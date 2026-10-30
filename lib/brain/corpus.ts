import { createAdminClient } from '@/lib/supabase/admin';
import { stripProvenanceAppendix } from '@/lib/wiki-content';
import { datedLine } from '@/lib/wiki-loader';
import { libraryStages, slugToAccent, type LibraryPathway, type Stage } from '@/lib/library-pathways';
import { getBrainSnapshot, type BrainPathway, type BrainUnit } from '@/lib/brain/snapshot';

// Published brain knowledge, for every read site that switches to the brain
// (docs/features/cube-brain-knowledge-source/). The snapshot is built with
// published pathways only; the lifecycle is checked again here so a bad
// build can never put a draft in front of a user.

// KNOWLEDGE_SOURCE=brain switches the read sites to the brain; unset (or
// `legacy`) keeps content/wiki/pathways + published_pathways, as before.
export function isBrainSource(): boolean {
  return process.env.KNOWLEDGE_SOURCE === 'brain';
}

export async function publishedPathways(): Promise<BrainPathway[]> {
  const { pathways } = await getBrainSnapshot();
  return pathways.filter((p) => p.lifecycle === 'published' && !!p.document);
}

export async function isPublishedSlug(slug: string): Promise<boolean> {
  return (await publishedPathways()).some((p) => p.slug === slug);
}

export async function publishedSlugSet(): Promise<Set<string>> {
  return new Set((await publishedPathways()).map((p) => p.slug));
}

/**
 * A pathway's Published badge: live in the brain snapshot, or its brain pull
 * request merged already (the snapshot can be up to its TTL behind a merge).
 */
export function isLive(slug: string, prState: string | null | undefined, published: Set<string>): boolean {
  return published.has(slug) || prState === 'merged';
}

/**
 * A slug a new or assembled pathway may not take: published in the brain
 * with no pathways row behind it (a curated pathway). A pathway's own slug,
 * re-sent after it was published, has its row, so it is not reserved.
 */
export async function isBrainReservedSlug(slug: string): Promise<boolean> {
  if (!(await isPublishedSlug(slug))) return false;
  const { data, error } = await createAdminClient().from('pathways').select('id').eq('slug', slug).maybeSingle();
  if (error) throw error;
  return !data;
}

/**
 * A published pathway's document, or null. `forAdopter` removes the
 * contributor-only Source Trace appendix; anything an adopter or the public
 * library can see must ask for that.
 */
export async function pathwayDocument(slug: string, { forAdopter }: { forAdopter: boolean }): Promise<string | null> {
  const pathway = (await publishedPathways()).find((p) => p.slug === slug);
  if (!pathway) return null;
  return forAdopter ? stripProvenanceAppendix(pathway.document) : pathway.document;
}

/**
 * The units of the given pathways, in the order the slugs are given. A
 * Problem-Solution Pattern counts for a pathway listed in its `pathways`.
 */
export async function unitsFor(slugs: string[]): Promise<BrainUnit[]> {
  const live = new Set((await publishedPathways()).map((p) => p.slug));
  const wanted = slugs.filter((s) => live.has(s));
  const { units } = await getBrainSnapshot();
  const owners = (u: BrainUnit) => [u.pathway, ...(u.pathways ?? [])].filter((o): o is string => !!o);
  const seen = new Set<string>();
  const out: BrainUnit[] = [];
  for (const slug of wanted) {
    for (const unit of units) {
      if (!seen.has(unit.slug) && owners(unit).includes(slug)) {
        seen.add(unit.slug);
        out.push(unit);
      }
    }
  }
  return out;
}

/**
 * The public library chat's document for one pathway: Source Trace stripped,
 * with the same date line the in-repo corpus gets. Null if not published.
 */
export async function libraryDocument(slug: string): Promise<string | null> {
  const pathway = (await publishedPathways()).find((p) => p.slug === slug);
  if (!pathway) return null;
  return `${datedLine(pathway.document, pathway.published_on)}${stripProvenanceAppendix(pathway.document)}`;
}

/**
 * The library chat's overview when no pathway is open: one entry per
 * published pathway, in the shape lib/library-documents.ts buildLibraryOverview
 * gives, and the count stated so the model never counts the list itself.
 */
export async function libraryOverview(): Promise<{ overview: string; count: number }> {
  const pathways = await publishedPathways();
  const sections = pathways.map((p) =>
    [
      `[${p.slug}]`,
      p.title && `title: ${p.title}`,
      (p.card_hook || p.summary) && `description: ${p.card_hook || p.summary}`,
      p.sector && `sector: ${p.sector}`,
      p.stage_reached && `stage: ${p.stage_reached}`,
      p.geography && `location: ${p.geography}`,
      p.tags?.length && `tags: [${p.tags.join(', ')}]`,
    ]
      .filter(Boolean)
      .join('\n')
  );
  return { overview: sections.join('\n\n'), count: sections.length };
}

// The brain's stage values are lowercase (MASTERS 3); the cards use the app's.
function cardStage(stage: string | undefined): Stage {
  return libraryStages.find((s) => s.toLowerCase() === stage?.toLowerCase()) ?? 'Explore';
}

/**
 * The /explore cards: one per published pathway, from its card_* fields,
 * falling back to its title and summary. The category follows the publish
 * route's rule (first two tags, else "Community").
 */
export async function libraryCards(): Promise<LibraryPathway[]> {
  return (await publishedPathways()).map((p) => ({
    id: p.slug,
    title: p.card_title || p.title || p.slug,
    location: p.card_location || '',
    category: p.tags?.length ? p.tags.slice(0, 2).join(' · ') : 'Community',
    stage: cardStage(p.stage_reached),
    accent: slugToAccent(p.slug),
    hook: p.card_hook || p.summary || '',
    sector: p.sector || undefined,
    tags: p.tags ?? [],
  }));
}
