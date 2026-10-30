import { brainCommitFiles, brainOpenOrUpdatePR } from '@/lib/github';
import { getBrainSnapshot } from '@/lib/brain/snapshot';
import { extractBrainEntries } from '@/lib/brain/extract';
import { renderBrainEntries } from '@/lib/brain/entries';

// Send for review with KNOWLEDGE_SOURCE=brain (CB-14): the contributor's
// assembled document → extracted entries → one commit on `pathway/<slug>`,
// rebuilt from BRAIN_BRANCH each time → the pull request an admin merges to
// publish. Nothing is committed if extraction fails; a re-send updates the
// same open PR. The caller records the PR on its pathways row.

export interface BrainSubmission {
  number: number;
  url: string;
  unitCount: number;
  patternCount: number;
}

export async function submitPathwayToBrain(input: { slug: string; title: string; document: string }): Promise<BrainSubmission> {
  const { slug, title, document } = input;
  const snapshot = await getBrainSnapshot();
  const extracted = await extractBrainEntries(document, { slug, title });

  const now = new Date();
  const rendered = renderBrainEntries({
    slug,
    title,
    document,
    extracted,
    takenUnitSlugs: new Set(snapshot.units.map((u) => u.slug)),
    // An update to a published pathway replaces its own units; a pattern
    // shared with other pathways is left alone.
    replacedUnitSlugs: snapshot.units.filter((u) => u.pathway === slug && !u.pathways?.length).map((u) => u.slug),
    today: now.toISOString().slice(0, 10),
    now,
  });

  const units = rendered.unitSlugs.length - rendered.patternCount;
  const branch = `pathway/${slug}`;
  await brainCommitFiles(
    branch,
    rendered.files,
    `cube-brain: pathway ${slug} sent for review (${units} units, ${rendered.patternCount} patterns)`,
    { fromBase: true }
  );
  const pr = await brainOpenOrUpdatePR(branch, rendered.prTitle, rendered.prBody);
  return { ...pr, unitCount: units, patternCount: rendered.patternCount };
}
