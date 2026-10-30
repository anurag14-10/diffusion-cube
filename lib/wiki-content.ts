import path from 'path';
import { createClient } from '@/lib/supabase/server';
import { readStaticFile } from '@/lib/static-content';
import { stripFrontmatter } from '@/lib/strip-frontmatter';
import { isValidSlug } from '@/lib/slug';
import { curatedPathwaySlugs } from '@/lib/wiki-loader';
import { isBrainSource, publishedPathways } from '@/lib/brain/corpus';

// Reads the same in-repo corpus lib/wiki-loader.ts injects into prompts, but
// for on-demand browsing in the app UI — separate concerns: wiki-loader.ts
// feeds the model, this feeds the /wiki pages a signed-in user reads
// directly. WIKI_PATH lets both point at the same override if set.
const WIKI_PATH = process.env.WIKI_PATH ?? path.join(process.cwd(), 'content', 'wiki');

// Kept in memory per server instance in production (lib/static-content.ts).
const readSource = readStaticFile;

export interface WikiPathwaySummary {
  slug: string;
  title: string;
  description: string;
  category: string;
  // The pathway's sector (e.g. Agriculture, Livelihoods) — distinct from
  // `category` above, which is the index.md heading it's filed under (often
  // a technology grouping like "Voice AI", not a sector). For static pathway
  // docs this comes from the file's own `sector:` frontmatter; for
  // community-published ones it's carried over at publish time from the
  // pathway's frontmatter or its pathways.sector (see
  // app/api/admin/pathways/publish/route.ts) — undefined only for pathways
  // published before that carry-over existed. "Cross-Sector" marks a deliberately horizontal pathway (a
  // synthesis or diagnostic spanning many sectors) rather than a real sector
  // — callers that want an actual sector list should filter it out, same as
  // an undefined sector.
  sector?: string;
  stage?: string;
  timestamp?: string;
  contributor?: string;
}

// The curated corpus — parses the pathways index's grouped bullet list:
// # Category
// * [Title](slug.md) - description.
// Also used by /api/pathways/check-similar, so a new pathway that repeats a
// curated one is caught too.
export async function listStaticPathways(): Promise<WikiPathwaySummary[]> {
  const index = await readSource(path.join(WIKI_PATH, 'pathways', 'index.md'));
  if (!index) return [];

  const entries: { title: string; slug: string; description: string; category: string }[] = [];
  let category = '';
  const bulletRe = /^\*\s*\[(.+?)\]\((.+?)\.md\)\s*-\s*(.+)$/;

  for (const rawLine of index.split('\n')) {
    const line = rawLine.trim();
    const headingMatch = line.match(/^#\s+(.+)$/);
    if (headingMatch) {
      if (headingMatch[1].trim() !== 'Pathways') category = headingMatch[1].trim();
      continue;
    }
    const m = line.match(bulletRe);
    if (m) entries.push({ title: m[1], slug: m[2], description: m[3], category });
  }

  return Promise.all(
    entries.map(async (entry) => {
      const raw = await readSource(path.join(WIKI_PATH, 'pathways', `${entry.slug}.md`));
      const sectorMatch = raw.match(/^sector:\s*(.+)$/m);
      const stageMatch = raw.match(/^stage:\s*(.+)$/m);
      const timestampMatch = raw.match(/^timestamp:\s*(.+)$/m);
      const contributorMatch = raw.match(/^contributor:\s*(.+)$/m);
      return {
        ...entry,
        sector: sectorMatch?.[1]?.trim(),
        stage: stageMatch?.[1]?.trim(),
        timestamp: timestampMatch?.[1]?.trim(),
        contributor: contributorMatch?.[1]?.trim(),
      };
    })
  );
}

// The curated corpus lives as static files; admin-published community
// pathways (see supabase/migrations/0012_published_pathways.sql) live in
// Supabase so publishing is instant — no git commit or redeploy per pathway.
// Both are merged here for browsing.
export async function listWikiPathways(): Promise<WikiPathwaySummary[]> {
  if (isBrainSource()) return listBrainPathways();
  const [staticPathways, publishedResult] = await Promise.all([
    listStaticPathways(),
    (async () => {
      const supabase = await createClient();
      return supabase
        .from('published_pathways')
        .select('slug, title, description, category, sector')
        .order('created_at', { ascending: false });
    })(),
  ]);

  const published = (publishedResult.data ?? []).map((p) => ({
    slug: p.slug,
    title: p.title,
    description: p.description,
    category: p.category,
    sector: p.sector ?? undefined,
  }));

  return [...staticPathways, ...published];
}

// KNOWLEDGE_SOURCE=brain: every published brain pathway
// (docs/features/cube-brain-knowledge-source/), in place of the static index
// plus published_pathways. `category` is the first tag, as the index's
// heading grouping has no brain equivalent.
async function listBrainPathways(): Promise<WikiPathwaySummary[]> {
  return (await publishedPathways()).map((p) => ({
    slug: p.slug,
    title: p.title ?? p.slug,
    description: p.card_hook || p.summary || '',
    category: p.tags?.[0] ?? '',
    sector: p.sector || undefined,
    stage: p.document.match(/^stage:\s*(.+)$/m)?.[1]?.trim(),
    timestamp: p.document.match(/^timestamp:\s*(.+)$/m)?.[1]?.trim(),
    contributor: p.document.match(/^contributor:\s*(.+)$/m)?.[1]?.trim(),
  }));
}

export interface WikiStats {
  total: number;
  // Unique real sectors across the merged static + published corpus (see
  // WikiPathwaySummary.sector) — excludes "Cross-Sector" and any pathway with
  // no sector tagged (all community-published ones, for now), since neither
  // is an actual sector to name in browse-intent copy.
  sectors: string[];
}

// Powers the "Explore the Pathways Library" intent's opening line (see
// app/api/wiki-stats/route.ts) — how many pathways exist right now and which
// sectors they span, so that line stays accurate as the corpus grows via
// community publishing instead of being frozen in a prompt file.
export async function getWikiStats(): Promise<WikiStats> {
  const pathways = await listWikiPathways();
  const sectors = Array.from(new Set(pathways.map((p) => p.sector).filter((s): s is string => Boolean(s) && s !== 'Cross-Sector')));
  return { total: pathways.length, sectors };
}

// The Source Trace appendix (previously "Provenance appendix") is contributor-
// only — never surfaced to adopters in any mode, including this browsing page.
// Cuts at the first heading whose text mentions "Source Trace" or "Provenance"
// (the old name, still present in existing static pathway files). Also used
// by lib/library-documents.ts for the public /explore chat.
export function stripProvenanceAppendix(markdown: string): string {
  const match = markdown.match(/^#{1,6}\s*.*(provenance|source trace).*$/im);
  if (!match || match.index === undefined) return markdown;
  return markdown.slice(0, match.index).trim();
}


export interface WikiPathwayContent {
  title: string;
  content: string;
}

export async function getWikiPathway(slug: string): Promise<WikiPathwayContent | null> {
  // The slug comes from the URL and becomes a file path — only a real slug
  // shape gets that far, never "../../x".
  if (!isValidSlug(slug)) return null;
  if (isBrainSource()) {
    const pathway = (await publishedPathways()).find((p) => p.slug === slug);
    if (!pathway) return null;
    return {
      title: pathway.document.match(/^title:\s*(.+)$/m)?.[1]?.trim() ?? pathway.title ?? slug,
      content: stripProvenanceAppendix(stripFrontmatter(pathway.document)),
    };
  }
  // Only a curated file is read from disk; an assembled-but-unpublished draft
  // in the same folder is not public (see curatedPathwaySlugs).
  const raw = (await curatedPathwaySlugs()).has(slug)
    ? await readSource(path.join(WIKI_PATH, 'pathways', `${slug}.md`))
    : '';
  if (raw) {
    const titleMatch = raw.match(/^title:\s*(.+)$/m);
    return {
      title: titleMatch?.[1]?.trim() ?? slug,
      content: stripProvenanceAppendix(stripFrontmatter(raw)),
    };
  }

  // Not a static file — check admin-published community pathways.
  const supabase = await createClient();
  const { data } = await supabase.from('published_pathways').select('title, content').eq('slug', slug).maybeSingle();
  if (!data) return null;

  return { title: data.title, content: stripProvenanceAppendix(stripFrontmatter(data.content)) };
}
