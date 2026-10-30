// GitHub Contents API helpers. All reads/writes target GITHUB_BRANCH in
// GITHUB_REPO. The repo value must be "owner/repo" (no URL prefix).
// GITHUB_TOKEN must be a classic PAT with `repo` scope, or a fine-grained
// token with `contents: write` on the target repo.

const REPO = process.env.GITHUB_REPO!         // 'owner/repo'
const BRANCH = process.env.GITHUB_BRANCH ?? 'pathways-dev'
const API = 'https://api.github.com'

function headers() {
  return {
    Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  }
}

// Percent-encode each path segment individually (spaces, special chars in
// filenames) but leave the '/' separators intact.
function encodePath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/')
}

/**
 * Read a file from the configured branch.
 * Returns null when the file doesn't exist (404). Throws on any other error.
 */
export async function ghReadFile(
  path: string
): Promise<{ content: string; sha: string } | null> {
  const res = await fetch(
    `${API}/repos/${REPO}/contents/${encodePath(path)}?ref=${BRANCH}`,
    { headers: headers() }
  )
  if (res.status === 404) return null
  if (!res.ok) {
    throw new Error(`GitHub readFile "${path}": ${res.status} ${await res.text()}`)
  }
  const data = await res.json()
  if (Array.isArray(data)) {
    throw new Error(`ghReadFile: "${path}" is a directory, not a file`)
  }
  return {
    content: Buffer.from(data.content as string, 'base64').toString('utf-8'),
    sha: data.sha as string,
  }
}

/**
 * Create or update a file on the configured branch.
 * Pass `sha` when updating an existing file (required by the GitHub API).
 * Returns the git commit SHA.
 */
export async function ghWriteFile(
  path: string,
  content: string,
  message: string,
  sha?: string
): Promise<{ commitSha: string }> {
  const body: Record<string, unknown> = {
    message,
    content: Buffer.from(content, 'utf-8').toString('base64'),
    branch: BRANCH,
  }
  if (sha) body.sha = sha

  const res = await fetch(`${API}/repos/${REPO}/contents/${encodePath(path)}`, {
    method: 'PUT',
    headers: { ...headers(), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    throw new Error(`GitHub writeFile "${path}": ${res.status} ${await res.text()}`)
  }
  const data = await res.json()
  return { commitSha: (data.commit as { sha: string }).sha }
}

/**
 * List files (not subdirectories) in a directory on the configured branch.
 * Returns [] when the directory doesn't exist.
 */
export async function ghListFiles(
  dirPath: string
): Promise<Array<{ name: string; path: string; sha: string }>> {
  const res = await fetch(
    `${API}/repos/${REPO}/contents/${encodePath(dirPath)}?ref=${BRANCH}`,
    { headers: headers() }
  )
  if (res.status === 404) return []
  if (!res.ok) {
    throw new Error(`GitHub listFiles "${dirPath}": ${res.status} ${await res.text()}`)
  }
  const data = await res.json()
  if (!Array.isArray(data)) return []
  return (data as Array<{ type: string; name: string; path: string; sha: string }>)
    .filter((f) => f.type === 'file')
    .map((f) => ({ name: f.name, path: f.path, sha: f.sha }))
}

// ---------------------------------------------------------------------------
// Cube-Brain (BRAIN_REPO): the app's knowledge source
// (docs/features/cube-brain-knowledge-source/). Authenticated with its own
// fine-grained token, BRAIN_GITHUB_TOKEN, limited to that one repo (Contents
// and Pull requests: write, Actions: read), never GITHUB_TOKEN, so neither
// token reaches the other repo. Env is read at call time so tests and
// environments can differ without re-importing.

export function brainRepo(): string {
  return process.env.BRAIN_REPO ?? 'anurag14-10/Cube-Brain'
}

export function brainBranch(): string {
  return process.env.BRAIN_BRANCH ?? 'main'
}

function githubHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  }
}

/**
 * A request to the brain repo's API (`path` is relative to /repos/<BRAIN_REPO>).
 * Returns the raw Response; callers decide what a 304 or 404 means. Headers in
 * `init` override the defaults (e.g. Accept for raw file content).
 */
export async function brainFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const token = process.env.BRAIN_GITHUB_TOKEN
  if (!token) throw new Error('BRAIN_GITHUB_TOKEN is not set')
  return fetch(`${API}/repos/${brainRepo()}${path}`, {
    ...init,
    headers: { ...githubHeaders(token), ...(init.headers as Record<string, string> | undefined) },
  })
}

async function brainJson<T>(step: string, path: string, init: RequestInit = {}): Promise<T> {
  const res = await brainFetch(path, {
    ...init,
    headers: init.body ? { 'Content-Type': 'application/json' } : undefined,
  })
  if (!res.ok) throw new BrainGitHubError(step, res.status, await res.text())
  return (await res.json()) as T
}

/** A failed brain GitHub call. Carries the status and step, never the token. */
export class BrainGitHubError extends Error {
  constructor(public step: string, public status: number, body: string) {
    super(`GitHub ${step}: ${status} ${body.slice(0, 500)}`)
    this.name = 'BrainGitHubError'
  }
}

/** GitHub refused a merge because the PR isn't mergeable (checks not passed, conflicts). */
export class BrainNotMergeableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BrainNotMergeableError'
  }
}

/**
 * One commit on `branch` holding every file (Git Data API: blobs → tree →
 * commit → ref); a null `content` deletes that path. The commit's parent is
 * the branch head, or with `fromBase` the head of BRAIN_BRANCH, the branch
 * being moved there (force) — a re-sent pathway's PR then holds only its
 * latest submission. A missing branch is created. Returns the commit sha.
 */
export async function brainCommitFiles(
  branch: string,
  files: Array<{ path: string; content: string | null }>,
  message: string,
  { fromBase = false }: { fromBase?: boolean } = {}
): Promise<string> {
  const refRes = await brainFetch(`/git/ref/heads/${encodePath(branch)}`)
  if (!refRes.ok && refRes.status !== 404) {
    throw new BrainGitHubError('read branch', refRes.status, await refRes.text())
  }
  const exists = refRes.ok
  let parentSha: string
  if (exists && !fromBase) {
    parentSha = ((await refRes.json()) as { object: { sha: string } }).object.sha
  } else {
    const base = await brainJson<{ object: { sha: string } }>('read base branch', `/git/ref/heads/${encodePath(brainBranch())}`)
    parentSha = base.object.sha
  }
  if (!exists) {
    await brainJson('create branch', '/git/refs', {
      method: 'POST',
      body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: parentSha }),
    })
  }

  const parent = await brainJson<{ tree: { sha: string } }>('read commit', `/git/commits/${parentSha}`)
  const tree = []
  for (const file of files) {
    if (file.content === null) {
      tree.push({ path: file.path, mode: '100644', type: 'blob', sha: null })
      continue
    }
    const blob = await brainJson<{ sha: string }>('create blob', '/git/blobs', {
      method: 'POST',
      body: JSON.stringify({ content: file.content, encoding: 'utf-8' }),
    })
    tree.push({ path: file.path, mode: '100644', type: 'blob', sha: blob.sha })
  }
  const newTree = await brainJson<{ sha: string }>('create tree', '/git/trees', {
    method: 'POST',
    body: JSON.stringify({ base_tree: parent.tree.sha, tree }),
  })
  const commit = await brainJson<{ sha: string }>('create commit', '/git/commits', {
    method: 'POST',
    body: JSON.stringify({ message, tree: newTree.sha, parents: [parentSha] }),
  })
  await brainJson('update branch', `/git/refs/heads/${encodePath(branch)}`, {
    method: 'PATCH',
    body: JSON.stringify(fromBase ? { sha: commit.sha, force: true } : { sha: commit.sha }),
  })
  return commit.sha
}

export interface BrainPullRequest {
  number: number
  url: string
}

/** The open PR from `branch` into BRAIN_BRANCH, opened if there isn't one (its body refreshed if there is). */
export async function brainOpenOrUpdatePR(branch: string, title: string, body: string): Promise<BrainPullRequest> {
  const owner = brainRepo().split('/')[0]
  const open = await brainJson<Array<{ number: number; html_url: string }>>(
    'list pull requests',
    `/pulls?state=open&head=${encodeURIComponent(`${owner}:${branch}`)}&base=${encodeURIComponent(brainBranch())}`
  )
  if (open.length) {
    await brainJson('update pull request', `/pulls/${open[0].number}`, { method: 'PATCH', body: JSON.stringify({ body }) })
    return { number: open[0].number, url: open[0].html_url }
  }
  const pr = await brainJson<{ number: number; html_url: string }>('open pull request', '/pulls', {
    method: 'POST',
    body: JSON.stringify({ title, head: branch, base: brainBranch(), body }),
  })
  return { number: pr.number, url: pr.html_url }
}

export type BrainValidation = 'pending' | 'passed' | 'failed'

export interface BrainPullRequestState {
  state: 'open' | 'merged' | 'closed'
  headSha: string
  url: string
  validation: BrainValidation
  validationDetail: string | null
}

// The GitHub Actions runs for the head commit (the brain's "Validate wiki"
// workflow): any failed run fails it, anything unfinished (or no run yet) is
// pending, all successful is passed. Read through the Actions API, which a
// fine-grained token's Actions: read permission covers.
async function validationOf(sha: string): Promise<{ validation: BrainValidation; detail: string | null }> {
  const { workflow_runs } = await brainJson<{
    workflow_runs: Array<{ name: string | null; status: string; conclusion: string | null; html_url?: string }>
  }>('read workflow runs', `/actions/runs?head_sha=${encodeURIComponent(sha)}`)
  const failed = workflow_runs.find(
    (r) => r.status === 'completed' && r.conclusion && !['success', 'neutral', 'skipped'].includes(r.conclusion)
  )
  if (failed) {
    const detail = [`${failed.name ?? 'Workflow'}: ${failed.conclusion}`, failed.html_url].filter(Boolean).join(' ')
    return { validation: 'failed', detail }
  }
  if (!workflow_runs.length || workflow_runs.some((r) => r.status !== 'completed')) return { validation: 'pending', detail: null }
  return { validation: 'passed', detail: null }
}

export async function brainGetPR(number: number): Promise<BrainPullRequestState> {
  const pr = await brainJson<{ state: string; merged: boolean; html_url: string; head: { sha: string } }>(
    'read pull request',
    `/pulls/${number}`
  )
  const { validation, detail } = await validationOf(pr.head.sha)
  return {
    state: pr.merged ? 'merged' : pr.state === 'closed' ? 'closed' : 'open',
    headSha: pr.head.sha,
    url: pr.html_url,
    validation,
    validationDetail: detail,
  }
}

/** Merges the PR; a PR GitHub won't merge (checks, conflicts) throws BrainNotMergeableError. */
export async function brainMergePR(number: number): Promise<void> {
  const res = await brainFetch(`/pulls/${number}/merge`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ merge_method: 'squash' }),
  })
  if (res.status === 405 || res.status === 409) {
    const data = (await res.json().catch(() => ({}))) as { message?: string }
    throw new BrainNotMergeableError(data.message ?? 'This pull request cannot be merged yet.')
  }
  if (!res.ok) throw new BrainGitHubError('merge pull request', res.status, await res.text())
}

export async function brainClosePR(number: number): Promise<void> {
  await brainJson('close pull request', `/pulls/${number}`, { method: 'PATCH', body: JSON.stringify({ state: 'closed' }) })
}
