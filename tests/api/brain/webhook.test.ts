import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSupabaseMock, type QueryOp, type SupabaseMock } from '../../helpers/supabase-mock';

vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: vi.fn() }));
vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn(async () => createSupabaseMock().client) }));
vi.mock('@/lib/brain/snapshot', () => ({ getBrainSnapshot: vi.fn() }));
vi.mock('@/lib/pathway-publish', () => ({
  publishPathwayAssets: vi.fn(async () => ({ assetIds: ['asset-1'], assetsPublished: true })),
  notifyContributor: vi.fn(async () => {}),
}));
vi.mock('@/lib/github', () => ({
  brainRepo: () => 'owner/brain',
  brainBranch: () => 'dev',
  brainGetPR: vi.fn(),
}));

import { createAdminClient } from '@/lib/supabase/admin';
import { getBrainSnapshot } from '@/lib/brain/snapshot';
import { notifyContributor, publishPathwayAssets } from '@/lib/pathway-publish';
import { brainGetPR } from '@/lib/github';
import { POST } from '@/app/api/brain/webhook/route';

// GitHub → app for the Cube-Brain repo (CB-15).

const SECRET = 'hook-secret';
let admin: SupabaseMock;
let prState: string | null;

const PATHWAY = {
  id: 'p1',
  title: 'Sahayak',
  content_cache: '---\ntitle: Sahayak for Health\n---\n# Doc',
  assembled_design_doc_id: 'doc-3',
  brain_pr_number: 7,
};

function sign(body: string) {
  return `sha256=${createHmac('sha256', SECRET).update(body).digest('hex')}`;
}

function hook(event: string, payload: object, signature?: string) {
  const body = JSON.stringify({ repository: { full_name: 'owner/brain' }, ...payload });
  return POST(
    new Request('http://localhost/api/brain/webhook', {
      method: 'POST',
      headers: { 'x-github-event': event, 'x-hub-signature-256': signature ?? sign(body) },
      body,
    })
  );
}

const hasFilter = (op: QueryOp, column: string, value: unknown) => op.filters.some((f) => f[0] === 'eq' && f[1] === column && f[2] === value);

beforeEach(() => {
  vi.stubEnv('GITHUB_WEBHOOK_SECRET', SECRET);
  prState = 'open';
  admin = createSupabaseMock({
    tables: {
      sys_errors: {},
      pathways: (op) => {
        if (op.action === 'select') {
          return { data: hasFilter(op, 'brain_pr_number', 7) ? { ...PATHWAY, brain_pr_state: prState } : null };
        }
        if (op.action === 'update') {
          // The conditional update only changes an open PR.
          if (hasFilter(op, 'brain_pr_state', 'open') && prState !== 'open') return { data: [] };
          const next = (op.payload as { brain_pr_state?: string }).brain_pr_state;
          if (next) prState = next;
          return { data: [{ id: 'p1' }] };
        }
        return {};
      },
    },
  });
  vi.mocked(createAdminClient).mockReturnValue(admin.client);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('POST /api/brain/webhook — signature', () => {
  it.each([
    ['a wrong signature', 'sha256=deadbeef'],
    ['no signature', ''],
    ['a signature of another body', sign('{}')],
  ])('401s %s and touches nothing', async (_label, signature) => {
    const res = await hook('pull_request', { action: 'closed', pull_request: { number: 7, merged: true } }, signature);
    expect(res.status).toBe(401);
    expect(admin.ops('pathways')).toHaveLength(0);
  });

  it('401s when no secret is configured', async () => {
    vi.stubEnv('GITHUB_WEBHOOK_SECRET', '');
    expect((await hook('push', { ref: 'refs/heads/dev' })).status).toBe(401);
  });

  it('400s a signed body that is not JSON', async () => {
    const body = 'not json';
    const res = await POST(
      new Request('http://localhost/api/brain/webhook', {
        method: 'POST',
        headers: { 'x-github-event': 'push', 'x-hub-signature-256': sign(body) },
        body,
      })
    );
    expect(res.status).toBe(400);
  });

  it('ignores another repository', async () => {
    const body = JSON.stringify({ repository: { full_name: 'someone/else' }, action: 'closed', pull_request: { number: 7, merged: true } });
    const res = await POST(
      new Request('http://localhost/api/brain/webhook', {
        method: 'POST',
        headers: { 'x-github-event': 'pull_request', 'x-hub-signature-256': sign(body) },
        body,
      })
    );
    expect(res.status).toBe(200);
    expect(admin.ops('pathways')).toHaveLength(0);
  });
});

describe('POST /api/brain/webhook — pull requests', () => {
  it('a merge publishes: state, assets, one email', async () => {
    const res = await hook('pull_request', { action: 'closed', pull_request: { number: 7, merged: true } });
    expect(res.status).toBe(200);
    expect(admin.ops('pathways', 'update')[0].payload).toEqual({
      brain_pr_state: 'merged',
      brain_validation: 'passed',
      review_requested: false,
      published_design_doc_id: 'doc-3',
    });
    expect(publishPathwayAssets).toHaveBeenCalledWith(expect.anything(), 'p1', PATHWAY.content_cache);
    expect(notifyContributor).toHaveBeenCalledWith(expect.anything(), {
      pathwayId: 'p1',
      title: 'Sahayak for Health',
      assembledDocId: 'doc-3',
      assetIds: ['asset-1'],
    });
  });

  it('a redelivered merge never emails twice', async () => {
    await hook('pull_request', { action: 'closed', pull_request: { number: 7, merged: true } });
    await hook('pull_request', { action: 'closed', pull_request: { number: 7, merged: true } });
    expect(notifyContributor).toHaveBeenCalledTimes(1);
    expect(publishPathwayAssets).toHaveBeenCalledTimes(1);
  });

  it('closed without merging returns it to a draft, with no email', async () => {
    await hook('pull_request', { action: 'closed', pull_request: { number: 7, merged: false } });
    expect(admin.ops('pathways', 'update')[0].payload).toEqual({ brain_pr_state: 'closed', review_requested: false });
    expect(notifyContributor).not.toHaveBeenCalled();
  });

  it('ignores a PR no pathway opened', async () => {
    const res = await hook('pull_request', { action: 'closed', pull_request: { number: 99, merged: true } });
    expect(res.status).toBe(200);
    expect(admin.ops('pathways', 'update')).toHaveLength(0);
  });

  it('ignores other pull request actions', async () => {
    await hook('pull_request', { action: 'opened', pull_request: { number: 7 } });
    expect(admin.ops('pathways', 'update')).toHaveLength(0);
  });
});

describe('POST /api/brain/webhook — checks and pushes', () => {
  it('records the PR\'s validation from all its check runs', async () => {
    vi.mocked(brainGetPR).mockResolvedValue({ state: 'open', headSha: 'h', url: 'u', validation: 'failed', validationDetail: 'Validate wiki: 1 error' });
    await hook('check_suite', { action: 'completed', check_suite: { pull_requests: [{ number: 7 }] } });
    expect(admin.ops('pathways', 'update')[0].payload).toEqual({ brain_validation: 'failed', brain_validation_detail: 'Validate wiki: 1 error' });
  });

  it('skips checks for a PR that is no longer open', async () => {
    prState = 'merged';
    await hook('check_suite', { action: 'completed', check_suite: { pull_requests: [{ number: 7 }] } });
    expect(brainGetPR).not.toHaveBeenCalled();
  });

  it('a push to the brain branch refreshes the snapshot now', async () => {
    await hook('push', { ref: 'refs/heads/dev' });
    expect(getBrainSnapshot).toHaveBeenCalledWith({ force: true });
  });

  it('a push to another branch does nothing', async () => {
    await hook('push', { ref: 'refs/heads/pathway/x' });
    expect(getBrainSnapshot).not.toHaveBeenCalled();
  });
});
