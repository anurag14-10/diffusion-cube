import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSupabaseMock, type MockUser, type QueryOp, type SupabaseMock } from '../../helpers/supabase-mock';
import { getRequest, jsonRequest } from '../../helpers/request';
import { rolesTable } from '../../helpers/chat-session';
import { fakeToolUseMessage } from '../../helpers/anthropic-mock';
import type { BrainSnapshot } from '@/lib/brain/snapshot';

const anthropic = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = { create: anthropic.create };
  },
}));
vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: vi.fn() }));
vi.mock('@/lib/brain/snapshot', () => ({ getBrainSnapshot: vi.fn() }));

import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { getBrainSnapshot } from '@/lib/brain/snapshot';
import { POST as checkSimilar } from '@/app/api/pathways/check-similar/route';
import { GET as listPathways, POST as createPathway } from '@/app/api/pathways/route';
import { isReservedPathwaySlug } from '@/lib/wiki-loader';

// KNOWLEDGE_SOURCE=brain: the duplicate check, the Published badge and slug
// reservation follow the brain, not published_pathways (CB-08).

const USER: MockUser = { id: 'u1', email: 'contrib@example.com' };

const SNAPSHOT: BrainSnapshot = {
  schema_version: 1,
  pathways: [
    // Curated: no pathways row.
    { slug: 'mahavistaar', title: 'MahaVISTAAR', sector: 'Agriculture', summary: 'Voice advisory', lifecycle: 'published', document: '#' },
    // Community, published earlier: has a pathways row.
    { slug: 'sahayak-for-health', title: 'Sahayak', sector: 'Health', summary: 'Health helper', lifecycle: 'published', document: '#' },
  ],
  units: [],
  organisations: [],
};

// The pathways rows the service role sees.
const ROWS = [
  { id: 'p-sahayak', slug: 'sahayak-for-health', title: 'Sahayak', sector: 'Health', description: 'Health helper', created_at: '2026-10-01', review_requested: false, brain_pr_state: null },
  { id: 'p-merged', slug: 'just-merged', title: 'Just merged', sector: 'Health', description: 'd', created_at: '2026-10-29', review_requested: false, brain_pr_state: 'merged' },
  { id: 'p-draft', slug: 'a-draft', title: 'Draft', sector: 'Health', description: 'd', created_at: '2026-10-28', review_requested: true, brain_pr_state: 'open' },
];

let session: SupabaseMock;
let admin: SupabaseMock;

function filterValue(op: QueryOp, method: string): unknown {
  return op.filters.find((f) => f[0] === method)?.[2];
}

beforeEach(() => {
  vi.stubEnv('KNOWLEDGE_SOURCE', 'brain');
  vi.mocked(getBrainSnapshot).mockResolvedValue(SNAPSHOT);
  anthropic.create.mockReset();
  session = createSupabaseMock({
    user: USER,
    tables: {
      user_roles: rolesTable(['adopter', 'pathway_contributor']),
      pathway_contributors: { data: [] },
      published_pathways: { data: [{ slug: 'should-not-be-read' }] },
    },
  });
  vi.mocked(createClient).mockResolvedValue(session.client);
  admin = createSupabaseMock({
    tables: {
      ai_usage: {},
      sys_errors: {},
      pathways: (op) => {
        if (op.action === 'insert') return { data: { id: 'p-new', slug: 'x' } };
        const slug = filterValue(op, 'eq');
        if (slug !== undefined) return { data: ROWS.find((r) => r.slug === slug) ?? null };
        const slugs = filterValue(op, 'in') as string[] | undefined;
        return { data: slugs ? ROWS.filter((r) => slugs.includes(r.slug)) : ROWS };
      },
    },
  });
  vi.mocked(createAdminClient).mockReturnValue(admin.client);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('check-similar (brain)', () => {
  const body = { title: 'Farmer voice line', sector: 'Agriculture', description: 'A voice helpline' };
  const post = () => checkSimilar(new NextRequest(jsonRequest('http://localhost/api/pathways/check-similar', body)));

  it('offers the brain\'s published pathways, never reading published_pathways', async () => {
    anthropic.create.mockResolvedValue(fakeToolUseMessage({ matchId: null }));
    await post();
    const prompt = anthropic.create.mock.calls[0][0].messages[0].content as string;
    expect(prompt).toContain('title: MahaVISTAAR');
    expect(prompt).toContain('id: p-sahayak');
    expect(session.ops('published_pathways')).toHaveLength(0);
  });

  it('reports a curated brain match as curatedMatch, not joinable', async () => {
    anthropic.create.mockResolvedValue(fakeToolUseMessage({ matchId: 'curated:mahavistaar' }));
    expect(await (await post()).json()).toEqual({
      matchId: null,
      curatedMatch: { slug: 'mahavistaar', title: 'MahaVISTAAR', sector: 'Agriculture' },
    });
  });

  it('reports a match with a pathways row as joinable', async () => {
    anthropic.create.mockResolvedValue(fakeToolUseMessage({ matchId: 'p-sahayak' }));
    expect(await (await post()).json()).toEqual({ matchId: 'p-sahayak' });
  });

  it('still answers no match when Claude fails', async () => {
    anthropic.create.mockRejectedValue(new Error('overloaded'));
    expect(await (await post()).json()).toEqual({ matchId: null });
  });
});

describe('GET /api/pathways Published badge (brain)', () => {
  it('is set for a brain-published pathway and a just-merged one, not for an open review', async () => {
    const res = await listPathways(new NextRequest(getRequest('http://localhost/api/pathways')));
    const body = (await res.json()) as { slug: string; isPublished: boolean }[];
    const badge = Object.fromEntries(body.map((p) => [p.slug, p.isPublished]));
    expect(badge).toEqual({ 'sahayak-for-health': true, 'just-merged': true, 'a-draft': false });
    expect(session.ops('published_pathways')).toHaveLength(0);
    expect(admin.ops('pathways', 'select')[0].columns).toContain('brain_pr_state');
    // The PR state is not passed through to the client.
    expect(JSON.stringify(body)).not.toContain('brain_pr_state');
  });
});

describe('slug reservation (brain)', () => {
  it('reserves a curated brain slug, not a published pathway\'s own slug, not an unknown one', async () => {
    expect(await isReservedPathwaySlug('mahavistaar')).toBe(true);
    expect(await isReservedPathwaySlug('sahayak-for-health')).toBe(false);
    expect(await isReservedPathwaySlug('brand-new')).toBe(false);
    expect(await isReservedPathwaySlug('index')).toBe(true);
  });

  it('a new pathway titled like a curated one gets a suffixed slug', async () => {
    const res = await createPathway(
      new NextRequest(jsonRequest('http://localhost/api/pathways', { title: 'MahaVISTAAR', sector: 'Agriculture', description: 'Mine' }))
    );
    expect(res.status).toBe(201);
    const [insert] = admin.ops('pathways', 'insert');
    expect((insert.payload as { slug: string }).slug).toBe('mahavistaar-1');
  });
});
