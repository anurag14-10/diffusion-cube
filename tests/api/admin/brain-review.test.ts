import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSupabaseMock, type MockUser, type QueryOp, type SupabaseMock } from '../../helpers/supabase-mock';
import { jsonRequest } from '../../helpers/request';
import { rolesTable } from '../../helpers/chat-session';

vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: vi.fn() }));
vi.mock('@/lib/brain/snapshot', () => ({ getBrainSnapshot: vi.fn() }));
vi.mock('@/lib/pathway-publish', () => ({
  publishPathwayAssets: vi.fn(async () => ({ assetIds: [], assetsPublished: true })),
  notifyContributor: vi.fn(async () => {}),
}));
vi.mock('@/lib/github', () => {
  class BrainNotMergeableError extends Error {}
  return { BrainNotMergeableError, brainGetPR: vi.fn(), brainMergePR: vi.fn(), brainClosePR: vi.fn() };
});

import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { getBrainSnapshot } from '@/lib/brain/snapshot';
import { notifyContributor } from '@/lib/pathway-publish';
import { BrainNotMergeableError, brainClosePR, brainGetPR, brainMergePR } from '@/lib/github';
import { GENERIC_ERROR_MESSAGE } from '@/lib/error-messages';
import { POST as publish } from '@/app/api/admin/pathways/publish/route';
import { POST as decline } from '@/app/api/admin/pathways/decline/route';
import { POST as resync } from '@/app/api/admin/brain/resync/route';

// Admin Publish (merge), Decline and Resync with KNOWLEDGE_SOURCE=brain (CB-16).

const ADMIN: MockUser = { id: 'a1', email: 'env-admin@example.com' };
const NOT_ADMIN: MockUser = { id: 'u1', email: 'someone@example.com' };
let admin: SupabaseMock;
let row: Record<string, unknown> | null;

const prState = (over: object = {}) => ({ state: 'open', headSha: 'h', url: 'u', validation: 'passed', validationDetail: null, ...over });

function signIn(user: MockUser) {
  const session = createSupabaseMock({ user, tables: { user_roles: rolesTable(['adopter']) } });
  vi.mocked(createClient).mockResolvedValue(session.client);
}

const hasFilter = (op: QueryOp, column: string, value: unknown) => op.filters.some((f) => f[0] === 'eq' && f[1] === column && f[2] === value);

beforeEach(() => {
  vi.stubEnv('KNOWLEDGE_SOURCE', 'brain');
  row = { id: 'p1', title: 'Sahayak', content_cache: '# Doc', assembled_design_doc_id: 'doc-3', brain_pr_number: 7, brain_pr_state: 'open' };
  admin = createSupabaseMock({
    tables: {
      sys_errors: {},
      published_pathways: {},
      pathways: (op) => {
        if (op.action === 'select') {
          if (hasFilter(op, 'brain_pr_state', 'open')) return { data: row && row.brain_pr_state === 'open' ? [row] : [] };
          return { data: row };
        }
        if (op.action === 'update') {
          if (hasFilter(op, 'brain_pr_state', 'open') && row?.brain_pr_state !== 'open') return { data: [] };
          Object.assign(row!, op.payload as object);
          return { data: [{ id: 'p1' }] };
        }
        return {};
      },
    },
  });
  vi.mocked(createAdminClient).mockReturnValue(admin.client);
  vi.mocked(brainGetPR).mockResolvedValue(prState() as never);
  signIn(ADMIN);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

const req = (url: string, body: unknown) => new NextRequest(jsonRequest(url, body));
const publishIt = () => publish(req('http://localhost/api/admin/pathways/publish', { pathway_id: 'p1' }));
const declineIt = () => decline(req('http://localhost/api/admin/pathways/decline', { pathway_id: 'p1' }));
const resyncIt = () => resync();

describe('Publish (brain)', () => {
  it('merges a passing PR, marks it published and emails once, never writing published_pathways', async () => {
    const res = await publishIt();
    expect(res.status).toBe(200);
    expect(brainMergePR).toHaveBeenCalledWith(7);
    expect(row).toMatchObject({ brain_pr_state: 'merged', review_requested: false, published_design_doc_id: 'doc-3' });
    expect(notifyContributor).toHaveBeenCalledTimes(1);
    expect(admin.ops('published_pathways')).toHaveLength(0);
  });

  it('applies a PR already merged on GitHub without merging again', async () => {
    vi.mocked(brainGetPR).mockResolvedValue(prState({ state: 'merged' }) as never);
    expect((await publishIt()).status).toBe(200);
    expect(brainMergePR).not.toHaveBeenCalled();
    expect(row?.brain_pr_state).toBe('merged');
  });

  it.each([
    ['failed', 'Validate wiki: 1 error', /checks failed/],
    ['pending', null, /not finished/],
  ])('409s while validation is %s, with the detail', async (validation, detail, message) => {
    vi.mocked(brainGetPR).mockResolvedValue(prState({ validation, validationDetail: detail }) as never);
    const res = await publishIt();
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toMatch(message);
    expect(body.detail).toBe(detail);
    expect(brainMergePR).not.toHaveBeenCalled();
    expect(row?.brain_validation).toBe(validation);
  });

  it('409s a review closed on GitHub, and returns it to draft', async () => {
    vi.mocked(brainGetPR).mockResolvedValue(prState({ state: 'closed' }) as never);
    const res = await publishIt();
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'This review was closed.' });
    expect(row).toMatchObject({ brain_pr_state: 'closed', review_requested: false });
  });

  it('409s when GitHub refuses the merge', async () => {
    vi.mocked(brainMergePR).mockRejectedValue(new BrainNotMergeableError('Merge conflict'));
    const res = await publishIt();
    expect(res.status).toBe(409);
    expect((await res.json()).detail).toBe('Merge conflict');
    expect(row?.brain_pr_state).toBe('open');
  });

  it('answers the generic message when GitHub is down, leaving it awaiting review', async () => {
    vi.mocked(brainGetPR).mockRejectedValue(new Error('ECONNRESET'));
    const res = await publishIt();
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: GENERIC_ERROR_MESSAGE });
    expect(row?.brain_pr_state).toBe('open');
  });

  it('400s a pathway never sent to the brain', async () => {
    row!.brain_pr_number = null;
    expect((await publishIt()).status).toBe(400);
  });
});

describe('Decline (brain)', () => {
  it('closes the PR and returns the pathway to draft, with no email', async () => {
    expect((await declineIt()).status).toBe(200);
    expect(brainClosePR).toHaveBeenCalledWith(7);
    expect(row).toMatchObject({ brain_pr_state: 'closed', review_requested: false });
    expect(notifyContributor).not.toHaveBeenCalled();
  });

  it('409s when there is no open review', async () => {
    row!.brain_pr_state = 'merged';
    expect((await declineIt()).status).toBe(409);
    expect(brainClosePR).not.toHaveBeenCalled();
  });

  it('400s without pathway_id', async () => {
    expect((await decline(req('http://localhost/api/admin/pathways/decline', {}))).status).toBe(400);
  });
});

describe('Resync (brain)', () => {
  it('refreshes the snapshot and applies what GitHub says about each open review', async () => {
    vi.mocked(getBrainSnapshot).mockResolvedValue({ schema_version: 1, pathways: [{ slug: 'x', document: '' }], units: [], organisations: [] });
    vi.mocked(brainGetPR).mockResolvedValue(prState({ state: 'merged' }) as never);
    const res = await resyncIt();
    expect(await res.json()).toEqual({ ok: true, pathways: 1, reviews: { open: 0, merged: 1, closed: 0 } });
    expect(getBrainSnapshot).toHaveBeenCalledWith({ force: true });
    expect(notifyContributor).toHaveBeenCalledTimes(1);
  });

  it('works with no open reviews', async () => {
    vi.mocked(getBrainSnapshot).mockResolvedValue({ schema_version: 1, pathways: [], units: [], organisations: [] });
    row!.brain_pr_state = 'merged';
    expect(await (await resyncIt()).json()).toEqual({ ok: true, pathways: 0, reviews: { open: 0, merged: 0, closed: 0 } });
  });
});

describe('admin only', () => {
  it.each([
    ['publish', publishIt],
    ['decline', declineIt],
    ['resync', resyncIt],
  ])('%s is 403 for a non-admin, with no GitHub call', async (_name, call) => {
    signIn(NOT_ADMIN);
    expect((await call()).status).toBe(403);
    expect(brainGetPR).not.toHaveBeenCalled();
    expect(brainClosePR).not.toHaveBeenCalled();
    expect(getBrainSnapshot).not.toHaveBeenCalled();
  });

  it.each([
    ['decline', declineIt],
    ['resync', resyncIt],
  ])('%s is refused in legacy mode', async (_name, call) => {
    vi.stubEnv('KNOWLEDGE_SOURCE', 'legacy');
    expect((await call()).status).toBe(400);
  });
});
