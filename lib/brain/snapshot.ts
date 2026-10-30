import { createAdminClient } from '@/lib/supabase/admin';
import { logError } from '@/lib/errors';
import { brainBranch, brainFetch } from '@/lib/github';

// The Cube-Brain snapshot: everything the app may use from the brain, built by
// the brain's CI (scripts/build_app_snapshot.py → snapshot/app-knowledge.json)
// and read here at runtime (docs/features/cube-brain-knowledge-source/).
//
// Each server instance fetches it at most once per BRAIN_SNAPSHOT_TTL_SECONDS,
// with If-None-Match so an unchanged file costs a 304. A new version is
// parsed once, kept in memory, and saved to brain_snapshots as the last good
// copy, which is what's served whenever GitHub can't be reached (including a
// cold start). Only when there's neither GitHub nor a saved copy does this
// throw.

// The snapshot file's own format version (SNAPSHOT_FORMAT in the builder), not
// the brain's schema version. An unknown major is refused, and the last good
// copy stays in use, so a brain-side format change can't break the app.
export const SNAPSHOT_FORMAT = 1;

export interface BrainPathway {
  slug: string;
  title?: string;
  card_hook?: string;
  card_title?: string;
  card_location?: string;
  sector?: string;
  use_case_category?: string;
  geography?: string;
  stage_reached?: string;
  summary?: string;
  tags?: string[];
  coverage?: Record<string, number>;
  contributing_organisations?: string[];
  deploying_organisations?: string[];
  partner_organisations?: string[];
  published_on?: string;
  lifecycle?: string;
  // The verbatim document, Source Trace appendix included — strip it
  // (lib/brain/corpus.ts) before anything adopter-facing.
  document: string;
}

export interface BrainUnit {
  slug: string;
  name?: string;
  unit_type?: string;
  pathway?: string;
  pathways?: string[];
  dimension?: string;
  dimensions?: string[];
  sub_category?: string;
  stage?: string;
  stages?: string[];
  also_relevant_at?: string[];
  applies_when?: string;
  fails_when?: string;
  adopter_intents?: string[];
  related_units?: string[];
  summary?: string;
  body: string;
}

export interface BrainOrganisation {
  slug: string;
  name?: string;
  summary?: string;
}

export interface BrainSnapshot {
  schema_version: number;
  brain_schema?: number;
  built_at?: string;
  source_commit?: string | null;
  pathways: BrainPathway[];
  units: BrainUnit[];
  organisations: BrainOrganisation[];
}

interface Held {
  snapshot: BrainSnapshot;
  etag: string | null;
  commit: string;
  checkedAt: number;
}

const DEFAULT_TTL_SECONDS = 300;
let held: Held | null = null;
let pending: Promise<BrainSnapshot> | null = null;

function ttlMs(): number {
  const seconds = Number(process.env.BRAIN_SNAPSHOT_TTL_SECONDS);
  return (Number.isFinite(seconds) && seconds >= 0 ? seconds : DEFAULT_TTL_SECONDS) * 1000;
}

function snapshotPath(): string {
  return process.env.BRAIN_SNAPSHOT_PATH ?? 'snapshot/app-knowledge.json';
}

export function parseSnapshot(text: string): BrainSnapshot {
  const data = JSON.parse(text) as BrainSnapshot;
  if (Math.trunc(Number(data?.schema_version)) !== SNAPSHOT_FORMAT) {
    throw new Error(`Brain snapshot format ${data?.schema_version} is not supported (expected ${SNAPSHOT_FORMAT})`);
  }
  if (!Array.isArray(data.pathways) || !Array.isArray(data.units) || !Array.isArray(data.organisations)) {
    throw new Error('Brain snapshot is missing pathways, units or organisations');
  }
  return data;
}

async function loadSaved(branch: string): Promise<Held | null> {
  const { data, error } = await createAdminClient()
    .from('brain_snapshots')
    .select('commit_sha, etag, payload')
    .eq('branch', branch)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return { snapshot: data.payload as BrainSnapshot, etag: data.etag, commit: data.commit_sha, checkedAt: 0 };
}

async function save(branch: string, next: Held): Promise<void> {
  const { error } = await createAdminClient()
    .from('brain_snapshots')
    .upsert(
      { branch, commit_sha: next.commit, etag: next.etag, payload: next.snapshot, fetched_at: new Date().toISOString() },
      { onConflict: 'branch' }
    );
  if (error) throw error;
}

async function refresh(): Promise<BrainSnapshot> {
  const branch = brainBranch();
  // A cold instance starts from the saved copy: its ETag usually turns the
  // GitHub fetch into a 304, and it's the fallback if GitHub is down.
  let saved: Held | null = held;
  try {
    saved ??= await loadSaved(branch);
  } catch (err) {
    logError('lib/brain/snapshot', err, { step: 'load-saved', branch });
  }

  try {
    const res = await brainFetch(`/contents/${snapshotPath()}?ref=${encodeURIComponent(branch)}`, {
      headers: {
        Accept: 'application/vnd.github.raw',
        ...(saved?.etag ? { 'If-None-Match': saved.etag } : {}),
      },
      cache: 'no-store',
    });
    if (res.status === 304 && saved) {
      held = { ...saved, checkedAt: Date.now() };
      return held.snapshot;
    }
    if (!res.ok) throw new Error(`GitHub brain snapshot "${snapshotPath()}"@${branch}: ${res.status} ${await res.text()}`);

    const snapshot = parseSnapshot(await res.text());
    const etag = res.headers.get('etag');
    const next: Held = { snapshot, etag, commit: snapshot.source_commit ?? etag ?? 'unknown', checkedAt: Date.now() };
    held = next;
    if (next.commit !== saved?.commit || next.etag !== saved?.etag) {
      await save(branch, next).catch((err) => logError('lib/brain/snapshot', err, { step: 'save', branch }));
    }
    return snapshot;
  } catch (err) {
    logError('lib/brain/snapshot', err, { step: 'fetch', branch });
    if (!saved) throw err;
    // Serve the saved copy and wait a full TTL before trying GitHub again.
    held = { ...saved, checkedAt: Date.now() };
    return saved.snapshot;
  }
}

/**
 * The current brain snapshot for BRAIN_BRANCH. `force` skips the TTL (admin
 * Resync, the webhook after a push).
 */
export async function getBrainSnapshot({ force = false }: { force?: boolean } = {}): Promise<BrainSnapshot> {
  if (!force && held && Date.now() - held.checkedAt < ttlMs()) return held.snapshot;
  pending ??= refresh().finally(() => {
    pending = null;
  });
  return pending;
}

// Tests only: forget what this instance holds.
export function resetBrainSnapshotForTests(): void {
  held = null;
  pending = null;
}
