import path from 'path';
import { createClient } from '@/lib/supabase/server';
import { readStaticFile } from '@/lib/static-content';
import { isBrainReservedSlug, isBrainSource } from '@/lib/brain/corpus';

// The corpus lives inside this repo (content/wiki/) so it deploys on Vercel
// with no extra step; S3 is the likely eventual home once the corpus grows
// past what's comfortable to commit. All reads go through readSource() so
// swapping in-repo for S3 later is a one-function change, no call-site edits.
// WIKI_PATH can still override this (e.g. to point at a different checkout
// in local dev) but nothing requires it anymore.
const WIKI_PATH = process.env.WIKI_PATH ?? path.join(process.cwd(), 'content', 'wiki');

// The framework question bank ships inside this repo (content/framework.md)
// rather than the external wiki: it's the app's own operating framework, and
// bundling it means it survives deployment regardless of where the pathway
// corpus ends up living.
const FRAMEWORK_FILE = path.join(process.cwd(), 'content', 'framework.md');

// The contributor-side generation prompt — the exact rules for the pathway
// document's output structure (Sections 0-6 + Source Trace appendix). Also
// used at runtime for the `pathway-draft` mode, which drafts a user's own
// adoption in the same structure for their review.
const PATHWAY_GENERATION_PROMPT_FILE = path.join(process.cwd(), 'content', 'pathway-generation-prompt.md');

// External tools/repos/reference material outside the pathway corpus (e.g.
// Voicera) — citable alongside pathway units but tagged distinctly, since
// they carry no contributor attribution or condition tag. See
// content/resources.md for the citation discipline itself.
const RESOURCES_FILE = path.join(process.cwd(), 'content', 'resources.md');

// Kept in memory per server instance in production (lib/static-content.ts).
async function readSource(filePath: string): Promise<string> {
  const text = await readStaticFile(filePath);
  if (!text) console.error(`[wiki-loader] Could not read ${filePath}`);
  return text;
}

// Parse pathway slugs from the pathways index's relative links:
// * [MahaVISTAAR](mahavistaar.md) - ...
function parsePathwaySlugs(indexMd: string): string[] {
  const slugs: string[] = [];
  const re = /\(([a-z0-9-]+\.md)\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(indexMd)) !== null) {
    if (m[1] !== 'index.md') slugs.push(m[1]);
  }
  return slugs;
}

// The curated corpus, by slug: the pathways index.md lists. Only these static
// files are ever served (Analyse prompts, /wiki, the /explore chat). Any other
// file under content/wiki/pathways/ is a contributor's assembled draft —
// assemble commits there before any admin review — and goes live only
// through published_pathways.
export async function curatedPathwaySlugs(): Promise<Set<string>> {
  const index = await readSource(path.join(WIKI_PATH, 'pathways', 'index.md'));
  return new Set(parsePathwaySlugs(index).map((file) => file.replace(/\.md$/, '')));
}

// A pathway's slug is the file assemble commits to, so a new pathway may not
// take a curated slug (or the index's own name) — it would overwrite that file.
// KNOWLEDGE_SOURCE=brain: a published brain pathway with no pathways row
// (lib/brain/corpus.ts isBrainReservedSlug) is the curated equivalent.
export async function isReservedPathwaySlug(slug: string): Promise<boolean> {
  if (slug === 'index') return true;
  return isBrainSource() ? isBrainReservedSlug(slug) : (await curatedPathwaySlugs()).has(slug);
}

// The AI Diffusion Pathway Framework — dimensions, sub-categories, stage
// weighting, the full question bank (core questions, listening-for, insight
// forms, corpus examples), unit types, and tagging rules. Injected into
// prompts rather than hardcoded in system-prompts.ts.
export async function loadFrameworkContent(): Promise<string> {
  return readSource(FRAMEWORK_FILE);
}

export async function loadPathwayGenerationPrompt(): Promise<string> {
  return readSource(PATHWAY_GENERATION_PROMPT_FILE);
}

export async function loadResourcesContent(): Promise<string> {
  return readSource(RESOURCES_FILE);
}

// The date the explorer prompt's "How old it is" rule reads (see
// evidenceHandlingRules in lib/system-prompts.ts), placed beside "Contributed
// by" so it's found the same way. The document's own frontmatter timestamp
// wins; a community pathway without one falls back to when it was first
// published (published_pathways.created_at — the publish upsert never
// rewrites it), labelled as such so it isn't read as when the work happened.
export function datedLine(document: string, firstPublishedAt?: string | null): string {
  const timestamp = document.match(/^timestamp:\s*(.+)$/m)?.[1]?.trim();
  if (timestamp) return `Documented as of: ${timestamp}\n\n`;
  if (firstPublishedAt) return `First published: ${firstPublishedAt.slice(0, 10)}\n\n`;
  return '';
}

// Loads the pathway corpus: the pathways index plus every pathway document,
// plus any admin-published community pathways (see
// supabase/migrations/0012_published_pathways.sql) — so a conversation with
// one adopter can be grounded in another's published experience, not just
// the original curated set. The whole corpus goes into context — fine at
// this size; revisit with retrieval once it grows meaningfully.
export async function loadWikiContext(): Promise<string> {
  const index = await readSource(path.join(WIKI_PATH, 'pathways', 'index.md'));
  if (!index) return '';

  const parts: string[] = [`# Pathways Index\n\n${index}`];

  const slugs = parsePathwaySlugs(index);
  const pages = await Promise.all(
    slugs.map(async (slug) => {
      const page = await readSource(path.join(WIKI_PATH, 'pathways', slug));
      if (!page) return '';
      const contributorMatch = page.match(/^contributor:\s*(.+)$/m);
      const contributor = contributorMatch?.[1]?.trim() ?? '';
      const contributorLine = contributor ? `Contributed by: ${contributor}\n\n` : '';
      return `# Pathway: ${slug.replace(/\.md$/, '')}\n\n${contributorLine}${datedLine(page)}${page}`;
    })
  );
  parts.push(...pages.filter(Boolean));

  const supabase = await createClient();
  const { data: published } = await supabase.from('published_pathways').select('slug, content, contributor_org, created_at');
  for (const p of published ?? []) {
    const contributorLine = p.contributor_org ? `Contributed by: ${p.contributor_org}\n\n` : '';
    parts.push(`# Pathway: ${p.slug}\n\n${contributorLine}${datedLine(p.content, p.created_at)}${p.content}`);
  }

  return parts.join('\n\n---\n\n');
}
