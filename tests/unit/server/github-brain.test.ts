import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BrainGitHubError,
  BrainNotMergeableError,
  brainClosePR,
  brainCommitFiles,
  brainGetPR,
  brainMergePR,
  brainOpenOrUpdatePR,
} from '@/lib/github';

// The brain repo's write operations (CB-12), against a mocked GitHub API.

const API = 'https://api.github.com/repos/owner/brain';
const fetchMock = vi.fn<typeof fetch>();

type Route = { method?: string; path: string; status?: number; body?: unknown };
let routes: Route[];

function json(body: unknown, status = 200) {
  return new Response(body === undefined ? null : JSON.stringify(body), { status });
}

// Answers each call from `routes` by method + path.
beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  vi.stubEnv('BRAIN_GITHUB_TOKEN', 'brain-token');
  vi.stubEnv('BRAIN_REPO', 'owner/brain');
  vi.stubEnv('BRAIN_BRANCH', 'dev');
  routes = [];
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (url, init) => {
    const u = String(url);
    const method = init?.method ?? 'GET';
    const route = routes.find((r) => (r.method ?? 'GET') === method && u === `${API}${r.path}`);
    if (!route) throw new Error(`unexpected ${method} ${u}`);
    return json(route.body, route.status ?? 200);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const calls = () =>
  fetchMock.mock.calls.map(([u, init]) => `${init?.method ?? 'GET'} ${String(u).replace(API, '')}`);
const bodyOf = (method: string, path: string) =>
  JSON.parse(fetchMock.mock.calls.find(([u, i]) => (i?.method ?? 'GET') === method && String(u) === `${API}${path}`)![1]!.body as string);

const commitRoutes = (): Route[] => [
  { path: '/git/commits/parent-sha', body: { tree: { sha: 'base-tree' } } },
  { method: 'POST', path: '/git/blobs', body: { sha: 'blob-sha' } },
  { method: 'POST', path: '/git/trees', body: { sha: 'new-tree' } },
  { method: 'POST', path: '/git/commits', body: { sha: 'new-commit' } },
  { method: 'PATCH', path: '/git/refs/heads/pathway/my-slug', body: {} },
];

describe('brainCommitFiles', () => {
  const FILES = [
    { path: 'documents/my-slug.md', content: '# Doc' },
    { path: 'pathways/my-slug.md', content: '---\nname: X\n---' },
    { path: 'units/my-slug-a.md', content: '---\nname: A\n---' },
  ];

  it('creates the branch from BRAIN_BRANCH and makes one commit with every file', async () => {
    routes = [
      { path: '/git/ref/heads/pathway/my-slug', status: 404, body: { message: 'Not Found' } },
      { path: '/git/ref/heads/dev', body: { object: { sha: 'parent-sha' } } },
      { method: 'POST', path: '/git/refs', status: 201, body: {} },
      ...commitRoutes(),
    ];
    expect(await brainCommitFiles('pathway/my-slug', FILES, 'cube-brain: ingest pathway my-slug')).toBe('new-commit');
    expect(calls()).toEqual([
      'GET /git/ref/heads/pathway/my-slug',
      'GET /git/ref/heads/dev',
      'POST /git/refs',
      'GET /git/commits/parent-sha',
      'POST /git/blobs',
      'POST /git/blobs',
      'POST /git/blobs',
      'POST /git/trees',
      'POST /git/commits',
      'PATCH /git/refs/heads/pathway/my-slug',
    ]);
    expect(bodyOf('POST', '/git/refs')).toEqual({ ref: 'refs/heads/pathway/my-slug', sha: 'parent-sha' });
    expect(bodyOf('POST', '/git/trees')).toEqual({
      base_tree: 'base-tree',
      tree: FILES.map((f) => ({ path: f.path, mode: '100644', type: 'blob', sha: 'blob-sha' })),
    });
    expect(bodyOf('POST', '/git/commits')).toEqual({ message: 'cube-brain: ingest pathway my-slug', tree: 'new-tree', parents: ['parent-sha'] });
  });

  it('commits on top of an existing branch without creating it', async () => {
    routes = [{ path: '/git/ref/heads/pathway/my-slug', body: { object: { sha: 'parent-sha' } } }, ...commitRoutes()];
    await brainCommitFiles('pathway/my-slug', FILES.slice(0, 1), 'm');
    expect(calls()).not.toContain('POST /git/refs');
    expect(bodyOf('POST', '/git/commits').parents).toEqual(['parent-sha']);
  });

  it('with fromBase, rebuilds an existing branch from BRAIN_BRANCH and force-moves it', async () => {
    routes = [
      { path: '/git/ref/heads/pathway/my-slug', body: { object: { sha: 'old-branch-head' } } },
      { path: '/git/ref/heads/dev', body: { object: { sha: 'parent-sha' } } },
      ...commitRoutes(),
    ];
    await brainCommitFiles('pathway/my-slug', FILES.slice(0, 1), 'm', { fromBase: true });
    expect(calls()).not.toContain('POST /git/refs');
    expect(bodyOf('POST', '/git/commits').parents).toEqual(['parent-sha']);
    expect(bodyOf('PATCH', '/git/refs/heads/pathway/my-slug')).toEqual({ sha: 'new-commit', force: true });
  });

  it('deletes a path whose content is null, without a blob', async () => {
    routes = [{ path: '/git/ref/heads/pathway/my-slug', body: { object: { sha: 'parent-sha' } } }, ...commitRoutes()];
    await brainCommitFiles('pathway/my-slug', [{ path: 'units/old.md', content: null }, FILES[0]], 'm');
    expect(calls().filter((c) => c === 'POST /git/blobs')).toHaveLength(1);
    expect(bodyOf('POST', '/git/trees').tree[0]).toEqual({ path: 'units/old.md', mode: '100644', type: 'blob', sha: null });
  });

  it('throws with the status and step, never the token', async () => {
    routes = [{ path: '/git/ref/heads/pathway/my-slug', status: 401, body: { message: 'Bad credentials' } }];
    const err = await brainCommitFiles('pathway/my-slug', FILES, 'm').catch((e) => e);
    expect(err).toBeInstanceOf(BrainGitHubError);
    expect(err.message).toMatch(/read branch: 401/);
    expect(err.message).not.toContain('brain-token');
  });
});

describe('brainOpenOrUpdatePR', () => {
  const LIST = `/pulls?state=open&head=${encodeURIComponent('owner:pathway/my-slug')}&base=dev`;

  it('opens a PR into BRAIN_BRANCH when none is open', async () => {
    routes = [
      { path: LIST, body: [] },
      { method: 'POST', path: '/pulls', status: 201, body: { number: 7, html_url: 'https://github.com/owner/brain/pull/7' } },
    ];
    expect(await brainOpenOrUpdatePR('pathway/my-slug', 'Pathway: X', 'body')).toEqual({ number: 7, url: 'https://github.com/owner/brain/pull/7' });
    expect(bodyOf('POST', '/pulls')).toEqual({ title: 'Pathway: X', head: 'pathway/my-slug', base: 'dev', body: 'body' });
  });

  it('reuses the open PR and refreshes its description', async () => {
    routes = [
      { path: LIST, body: [{ number: 5, html_url: 'u5' }] },
      { method: 'PATCH', path: '/pulls/5', body: {} },
    ];
    expect(await brainOpenOrUpdatePR('pathway/my-slug', 'T', 'new body')).toEqual({ number: 5, url: 'u5' });
    expect(calls()).not.toContain('POST /pulls');
    expect(bodyOf('PATCH', '/pulls/5')).toEqual({ body: 'new body' });
  });
});

describe('brainGetPR', () => {
  const pr = (extra: object) => ({ path: '/pulls/7', body: { state: 'open', merged: false, html_url: 'u', head: { sha: 'h1' }, ...extra } });
  const runs = (workflow_runs: object[]) => ({ path: '/actions/runs?head_sha=h1', body: { workflow_runs } });

  it('sends the brain token', async () => {
    routes = [pr({}), runs([])];
    await brainGetPR(7);
    expect((fetchMock.mock.calls[0][1]?.headers as Record<string, string>).Authorization).toBe('Bearer brain-token');
  });

  it.each([
    ['no run yet', [], 'pending'],
    ['a run in progress', [{ name: 'Validate wiki', status: 'in_progress', conclusion: null }], 'pending'],
    ['every run successful', [{ name: 'Validate wiki', status: 'completed', conclusion: 'success' }], 'passed'],
  ])('validation with %s is %s', async (_label, workflowRuns, expected) => {
    routes = [pr({}), runs(workflowRuns)];
    expect((await brainGetPR(7)).validation).toBe(expected);
  });

  it('a failed run fails it, naming the run and linking it', async () => {
    routes = [
      pr({}),
      runs([{ name: 'Validate wiki', status: 'completed', conclusion: 'failure', html_url: 'https://github.com/owner/brain/actions/runs/1' }]),
    ];
    expect(await brainGetPR(7)).toMatchObject({
      validation: 'failed',
      validationDetail: 'Validate wiki: failure https://github.com/owner/brain/actions/runs/1',
    });
  });

  it.each([
    [{ state: 'closed', merged: true }, 'merged'],
    [{ state: 'closed', merged: false }, 'closed'],
    [{ state: 'open', merged: false }, 'open'],
  ])('maps %j to %s', async (extra, expected) => {
    routes = [pr(extra), runs([])];
    expect((await brainGetPR(7)).state).toBe(expected);
  });
});

describe('BRAIN_GITHUB_TOKEN missing', () => {
  it('fails before calling GitHub', async () => {
    vi.stubEnv('BRAIN_GITHUB_TOKEN', '');
    await expect(brainGetPR(7)).rejects.toThrow('BRAIN_GITHUB_TOKEN is not set');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('brainMergePR / brainClosePR', () => {
  it('squash-merges', async () => {
    routes = [{ method: 'PUT', path: '/pulls/7/merge', body: { merged: true } }];
    await brainMergePR(7);
    expect(bodyOf('PUT', '/pulls/7/merge')).toEqual({ merge_method: 'squash' });
  });

  it.each([405, 409])('a %i is not mergeable, with GitHub\'s reason', async (status) => {
    routes = [{ method: 'PUT', path: '/pulls/7/merge', status, body: { message: 'Required status check "validate" is failing.' } }];
    const err = await brainMergePR(7).catch((e) => e);
    expect(err).toBeInstanceOf(BrainNotMergeableError);
    expect(err.message).toContain('Required status check');
  });

  it('any other failure is a GitHub error', async () => {
    routes = [{ method: 'PUT', path: '/pulls/7/merge', status: 500, body: { message: 'boom' } }];
    await expect(brainMergePR(7)).rejects.toBeInstanceOf(BrainGitHubError);
  });

  it('closes a PR', async () => {
    routes = [{ method: 'PATCH', path: '/pulls/7', body: {} }];
    await brainClosePR(7);
    expect(bodyOf('PATCH', '/pulls/7')).toEqual({ state: 'closed' });
  });
});
