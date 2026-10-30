import { createAdminClient } from '@/lib/supabase/admin';
import {
  BrainNotMergeableError,
  brainClosePR,
  brainGetPR,
  brainMergePR,
  type BrainPullRequestState,
  type BrainValidation,
} from '@/lib/github';
import { notifyContributor, publishPathwayAssets } from '@/lib/pathway-publish';

// The outcomes of a pathway's brain pull request (KNOWLEDGE_SOURCE=brain,
// docs/features/cube-brain-knowledge-source/, CB-15/CB-16), applied to its
// pathways row wherever they were seen: the GitHub webhook, the admin
// console's Publish, or Resync. Merged is applied once per PR: the state moves
// open → merged in one conditional update, and only the caller that made that
// move publishes the toolkit assets and emails the contributor, so a
// redelivered webhook or a merge seen twice never emails twice.

type Admin = ReturnType<typeof createAdminClient>;

export interface ReviewedPathway {
  id: string;
  title: string | null;
  content_cache: string | null;
  assembled_design_doc_id: string | null;
  brain_pr_number: number | null;
  brain_pr_state: string | null;
}

const COLUMNS = 'id, title, content_cache, assembled_design_doc_id, brain_pr_number, brain_pr_state';

export async function pathwayForPullRequest(admin: Admin, number: number): Promise<ReviewedPathway | null> {
  const { data, error } = await admin.from('pathways').select(COLUMNS).eq('brain_pr_number', number).maybeSingle();
  if (error) throw error;
  return (data as ReviewedPathway | null) ?? null;
}

/** Applies a merge. True if this call published it (it was still open). */
export async function applyMerged(admin: Admin, pathway: ReviewedPathway): Promise<boolean> {
  const { data, error } = await admin
    .from('pathways')
    .update({
      brain_pr_state: 'merged',
      brain_validation: 'passed',
      review_requested: false,
      published_design_doc_id: pathway.assembled_design_doc_id,
    })
    .eq('id', pathway.id)
    .eq('brain_pr_state', 'open')
    .select('id');
  if (error) throw error;
  if (!data?.length) return false;

  const document = pathway.content_cache ?? '';
  const { assetIds } = await publishPathwayAssets(admin, pathway.id, document);
  await notifyContributor(admin, {
    pathwayId: pathway.id,
    title: document.match(/^title:\s*(.+)$/m)?.[1]?.trim() ?? pathway.title ?? 'your pathway',
    assembledDocId: pathway.assembled_design_doc_id,
    assetIds,
  });
  return true;
}

/** A PR closed without merging: back to a draft for the contributor. */
export async function applyClosed(admin: Admin, pathway: ReviewedPathway): Promise<void> {
  const { error } = await admin
    .from('pathways')
    .update({ brain_pr_state: 'closed', review_requested: false })
    .eq('id', pathway.id)
    .eq('brain_pr_state', 'open');
  if (error) throw error;
}

export async function applyValidation(
  admin: Admin,
  pathway: ReviewedPathway,
  validation: BrainValidation,
  detail: string | null
): Promise<void> {
  const { error } = await admin
    .from('pathways')
    .update({ brain_validation: validation, brain_validation_detail: detail })
    .eq('id', pathway.id)
    .eq('brain_pr_state', 'open');
  if (error) throw error;
}

/** Reads the PR from GitHub and applies whatever it says. Returns that state. */
export async function syncPullRequest(admin: Admin, pathway: ReviewedPathway): Promise<BrainPullRequestState> {
  const pr = await brainGetPR(pathway.brain_pr_number!);
  if (pr.state === 'merged') await applyMerged(admin, pathway);
  else if (pr.state === 'closed') await applyClosed(admin, pathway);
  else await applyValidation(admin, pathway, pr.validation, pr.validationDetail);
  return pr;
}

async function pathwayById(admin: Admin, id: string): Promise<ReviewedPathway | null> {
  const { data, error } = await admin.from('pathways').select(COLUMNS).eq('id', id).maybeSingle();
  if (error) throw error;
  return (data as ReviewedPathway | null) ?? null;
}

export type ReviewResult = { status: number; body: Record<string, unknown> };

/**
 * The admin console's Publish (CB-16): merge the pathway's brain PR. GitHub's
 * own state is read first: an already-merged PR is applied (no second merge),
 * a closed one or one whose checks haven't passed is refused with 409.
 */
export async function publishThroughBrain(admin: Admin, pathwayId: string): Promise<ReviewResult> {
  const pathway = await pathwayById(admin, pathwayId);
  if (!pathway) return { status: 404, body: { error: 'Pathway not found.' } };
  if (!pathway.brain_pr_number) {
    return { status: 400, body: { error: 'This pathway has not been sent for review to the brain yet.' } };
  }

  const pr = await brainGetPR(pathway.brain_pr_number);
  if (pr.state === 'merged') {
    await applyMerged(admin, pathway);
    return { status: 200, body: { ok: true, merged: true } };
  }
  if (pr.state === 'closed') {
    await applyClosed(admin, pathway);
    return { status: 409, body: { error: 'This review was closed.' } };
  }
  if (pr.validation !== 'passed') {
    await applyValidation(admin, pathway, pr.validation, pr.validationDetail);
    return {
      status: 409,
      body: {
        error: pr.validation === 'failed' ? "The brain's checks failed for this pathway." : "The brain's checks have not finished yet.",
        detail: pr.validationDetail,
      },
    };
  }

  try {
    await brainMergePR(pathway.brain_pr_number);
  } catch (err) {
    if (err instanceof BrainNotMergeableError) {
      return { status: 409, body: { error: 'GitHub would not merge this pull request.', detail: err.message } };
    }
    throw err;
  }
  await applyMerged(admin, pathway);
  return { status: 200, body: { ok: true, merged: true } };
}

/** The admin console's Decline: close the PR; the pathway is a draft again. */
export async function declineThroughBrain(admin: Admin, pathwayId: string): Promise<ReviewResult> {
  const pathway = await pathwayById(admin, pathwayId);
  if (!pathway) return { status: 404, body: { error: 'Pathway not found.' } };
  if (!pathway.brain_pr_number || pathway.brain_pr_state !== 'open') {
    return { status: 409, body: { error: 'This pathway has no open review to decline.' } };
  }
  await brainClosePR(pathway.brain_pr_number);
  await applyClosed(admin, pathway);
  return { status: 200, body: { ok: true } };
}

/** Every open review re-read from GitHub (Resync). Returns how each one stands now. */
export async function syncOpenReviews(admin: Admin): Promise<{ open: number; merged: number; closed: number }> {
  const { data, error } = await admin.from('pathways').select(COLUMNS).eq('brain_pr_state', 'open');
  if (error) throw error;
  const counts = { open: 0, merged: 0, closed: 0 };
  for (const pathway of (data ?? []) as ReviewedPathway[]) {
    if (!pathway.brain_pr_number) continue;
    const pr = await syncPullRequest(admin, pathway);
    counts[pr.state]++;
  }
  return counts;
}
