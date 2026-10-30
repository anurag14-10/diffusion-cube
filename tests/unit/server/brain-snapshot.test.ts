import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSupabaseMock, type SupabaseMock } from '../../helpers/supabase-mock';

vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: vi.fn() }));
vi.mock('@/lib/errors', () => ({ logError: vi.fn() }));

import { createAdminClient } from '@/lib/supabase/admin';
import { logError } from '@/lib/errors';
import { getBrainSnapshot, parseSnapshot, resetBrainSnapshotForTests, type BrainSnapshot } from '@/lib/brain/snapshot';

const fetchMock = vi.fn<typeof fetch>();
let admin: SupabaseMock;
let savedRow: { commit_sha: string; etag: string | null; payload: BrainSnapshot } | null;

function snapshot(commit: string, extra: Partial<BrainSnapshot> = {}): BrainSnapshot {
  return {
    schema_version: 1,
    source_commit: commit,
    pathways: [{ slug: 'mahavistaar', lifecycle: 'published', document: '# MahaVISTAAR' }],
    units: [],
    organisations: [],
    ...extra,
  };
}

// `snapshotResponses` feed the snapshot fetches in order.
function github(...snapshotResponses: Array<Response | Error>) {
  fetchMock.mockImplementation(async (url) => {
    const next = snapshotResponses.shift();
    if (!next) throw new Error(`unexpected fetch ${url}`);
    if (next instanceof Error) throw next;
    return next;
  });
}

const ok = (s: BrainSnapshot, etag = `"${s.source_commit}"`) =>
  new Response(JSON.stringify(s), { status: 200, headers: { etag } });
const snapshotCalls = () => fetchMock.mock.calls;

beforeEach(async () => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
  vi.stubEnv('BRAIN_GITHUB_TOKEN', 'brain-token');
  vi.stubEnv('BRAIN_REPO', 'owner/brain');
  vi.stubEnv('BRAIN_BRANCH', 'dev');
  savedRow = null;
  admin = createSupabaseMock({
    tables: { brain_snapshots: (op) => (op.action === 'select' ? { data: savedRow } : {}) },
  });
  vi.mocked(createAdminClient).mockReturnValue(admin.client);
  resetBrainSnapshotForTests();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe('getBrainSnapshot', () => {
  it('fetches the raw snapshot from the brain branch with the brain token, and saves it', async () => {
    github(ok(snapshot('c1')));
    const s = await getBrainSnapshot();
    expect(s.source_commit).toBe('c1');

    const [url, init] = snapshotCalls()[0];
    expect(url).toBe('https://api.github.com/repos/owner/brain/contents/snapshot/app-knowledge.json?ref=dev');
    const headers = init?.headers as Record<string, string>;
    expect(headers.Accept).toBe('application/vnd.github.raw');
    expect(headers.Authorization).toBe('Bearer brain-token');

    const [upsert] = admin.ops('brain_snapshots', 'upsert');
    expect(upsert.payload).toMatchObject({ branch: 'dev', commit_sha: 'c1', etag: '"c1"' });
    expect(upsert.options).toEqual({ onConflict: 'branch' });
  });

  it('makes no second fetch within the TTL', async () => {
    github(ok(snapshot('c1')));
    await getBrainSnapshot();
    await getBrainSnapshot();
    expect(snapshotCalls()).toHaveLength(1);
  });

  it('after the TTL, sends If-None-Match and keeps its copy on a 304 without re-saving', async () => {
    vi.stubEnv('BRAIN_SNAPSHOT_TTL_SECONDS', '0');
    github(ok(snapshot('c1')), new Response(null, { status: 304 }));
    await getBrainSnapshot();
    const s = await getBrainSnapshot();
    expect(s.source_commit).toBe('c1');
    expect((snapshotCalls()[1][1]?.headers as Record<string, string>)['If-None-Match']).toBe('"c1"');
    expect(admin.ops('brain_snapshots', 'upsert')).toHaveLength(1);
  });

  it('a cold instance starts from the saved copy, so an unchanged brain is a 304', async () => {
    savedRow = { commit_sha: 'c0', etag: '"c0"', payload: snapshot('c0') };
    github(new Response(null, { status: 304 }));
    const s = await getBrainSnapshot();
    expect(s.source_commit).toBe('c0');
    expect((snapshotCalls()[0][1]?.headers as Record<string, string>)['If-None-Match']).toBe('"c0"');
  });

  it('shares one fetch between concurrent first calls', async () => {
    github(ok(snapshot('c1')));
    const [a, b] = await Promise.all([getBrainSnapshot(), getBrainSnapshot()]);
    expect(a).toBe(b);
    expect(snapshotCalls()).toHaveLength(1);
  });

  it('force skips the TTL', async () => {
    github(ok(snapshot('c1')), ok(snapshot('c2')));
    await getBrainSnapshot();
    expect((await getBrainSnapshot({ force: true })).source_commit).toBe('c2');
  });

  it('serves the saved copy and records the failure when GitHub is down', async () => {
    savedRow = { commit_sha: 'c0', etag: '"c0"', payload: snapshot('c0') };
    github(new Error('network down'));
    const s = await getBrainSnapshot();
    expect(s.source_commit).toBe('c0');
    expect(logError).toHaveBeenCalledWith('lib/brain/snapshot', expect.any(Error), expect.objectContaining({ step: 'fetch' }));
  });

  it('serves the saved copy when GitHub answers an error status', async () => {
    savedRow = { commit_sha: 'c0', etag: null, payload: snapshot('c0') };
    github(new Response('Bad credentials', { status: 401 }));
    expect((await getBrainSnapshot()).source_commit).toBe('c0');
  });

  it('refuses a snapshot format it does not know and keeps the last good copy', async () => {
    savedRow = { commit_sha: 'c0', etag: '"c0"', payload: snapshot('c0') };
    github(ok(snapshot('c9', { schema_version: 99 })));
    expect((await getBrainSnapshot()).source_commit).toBe('c0');
    expect(admin.ops('brain_snapshots', 'upsert')).toHaveLength(0);
    expect(vi.mocked(logError).mock.calls[0][1]).toMatchObject({ message: expect.stringMatching(/format 99/) });
  });

  it('throws when there is neither GitHub nor a saved copy', async () => {
    github(new Error('network down'));
    await expect(getBrainSnapshot()).rejects.toThrow('network down');
  });

  it('never puts the token in an error', async () => {
    github(new Response('Not Found', { status: 404 }));
    await expect(getBrainSnapshot()).rejects.toThrow(/404/);
    const err = vi.mocked(logError).mock.calls[0][1] as Error;
    expect(err.message).not.toContain('brain-token');
  });

  it('serves the saved copy when BRAIN_GITHUB_TOKEN is missing', async () => {
    vi.stubEnv('BRAIN_GITHUB_TOKEN', '');
    savedRow = { commit_sha: 'c0', etag: '"c0"', payload: snapshot('c0') };
    expect((await getBrainSnapshot()).source_commit).toBe('c0');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(vi.mocked(logError).mock.calls[0][1]).toMatchObject({ message: 'BRAIN_GITHUB_TOKEN is not set' });
  });
});

describe('parseSnapshot', () => {
  it('rejects a payload without its lists', () => {
    expect(() => parseSnapshot(JSON.stringify({ schema_version: 1, pathways: [] }))).toThrow(/missing/);
  });
});
