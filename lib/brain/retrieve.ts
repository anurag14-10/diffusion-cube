import { createHash } from 'crypto';
import Anthropic from '@anthropic-ai/sdk';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createAdminClient } from '@/lib/supabase/admin';
import { logError } from '@/lib/errors';
import { recordAiUsage } from '@/lib/ai-usage';
import { datedLine } from '@/lib/wiki-loader';
import { stripProvenanceAppendix } from '@/lib/wiki-content';
import type { GridState } from '@/lib/dimensions';
import type { CompanionMeta } from '@/lib/system-prompts';
import { DIMENSIONS, STAGES } from '@/lib/brain/vocab';
import { publishedPathways, unitsFor } from '@/lib/brain/corpus';
import type { BrainPathway, BrainUnit } from '@/lib/brain/snapshot';

// Intent-aware grounding (docs/features/cube-brain-knowledge-source/). Instead
// of the whole corpus, each new message is grounded on the pathways its
// question needs. One small forced-tool-use call works out what kind of
// question it is and picks published pathways to suit, which is what the
// three must-have retrieval capabilities ask for:
//
//   specific  — about a named pathway: its own documents, any sector (1)
//   situation — about the person's own adoption: same sector AND same kind
//               of problem, as the product's matching rule says
//   broad     — across pathways: their micro-innovations on the topic (2)
//   patterns  — common patterns: the brain's recorded patterns plus lessons
//               several pathways share, with synthesis rules (3)
//
// The selection runs on every new message, so a new question never gets the
// previous one's pathways. A design's last `situation` pick is kept
// (knowledge_selections) for its analysis documents. If selecting fails, the
// whole published corpus is used, as before this feature: less focused,
// never a false "nothing matches".

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = 'claude-sonnet-4-6';

export const QUERY_TYPES = ['specific', 'situation', 'broad', 'patterns'] as const;
export type QueryType = (typeof QUERY_TYPES)[number];

// Per kind of question: how many pathways, how many of them in full, and how
// many micro-innovations (MahaVISTAAR alone has 43). Broad and pattern
// questions carry fewer documents, so they get more units.
const LIMITS: Record<QueryType, { pathways: number; documents: number; units: number }> = {
  specific: { pathways: 2, documents: 2, units: 30 },
  situation: { pathways: 3, documents: 2, units: 30 },
  broad: { pathways: 6, documents: 1, units: 40 },
  patterns: { pathways: 6, documents: 1, units: 40 },
};
const MAX_PATHWAYS = Math.max(...Object.values(LIMITS).map((l) => l.pathways));
const PATTERN = 'Problem-Solution Pattern';

// Recent turns the selection reads (each capped): enough to know the
// person's situation and what this message asks, without the whole conversation.
const SELECTION_TURNS = 6;
const SELECTION_TURN_CHARS = 2000;

export interface Selection {
  queryType: QueryType;
  slugs: string[];
  // What the question is about, when it names a dimension or stage; orders units.
  dimensions: string[];
  stages: string[];
}

const SELECT_TOOL: Anthropic.Tool = {
  name: 'select_pathways',
  description: 'Report what kind of question the latest message asks, and which published pathways answer it, most relevant first.',
  input_schema: {
    type: 'object',
    properties: {
      query_type: {
        type: 'string',
        enum: [...QUERY_TYPES],
        description:
          'specific: asks about a particular pathway (named or clearly identified). situation: about the person\'s own adoption. broad: a question across pathways on a topic. patterns: asks what is common, recurring or typical across pathways.',
      },
      slugs: {
        type: 'array',
        items: { type: 'string' },
        maxItems: MAX_PATHWAYS,
        description: 'Slugs of the pathways that answer it, most relevant first. An empty array when none genuinely does.',
      },
      dimensions: { type: 'array', items: { type: 'string', enum: [...DIMENSIONS] }, description: 'Dimensions the question is about, if any.' },
      stages: { type: 'array', items: { type: 'string', enum: [...STAGES] }, description: 'Stages the question is about, if any.' },
    },
    required: ['query_type', 'slugs'],
  },
};

type Message = { role: string; content: unknown };

function messageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((b) => (typeof b?.text === 'string' ? b.text : '')).join('\n');
  }
  return '';
}

// Each unit's name, so the selection can see details a pathway's summary
// doesn't mention (e.g. "prefix caching" lives only in a MahaVISTAAR unit).
// Names only: about 15 tokens a unit.
const UNIT_NAME_CHARS = 120;

function catalogueLine(p: BrainPathway, unitNames: string[] = []): string {
  return [
    `- slug: ${p.slug}`,
    `  title: ${p.title ?? p.slug}`,
    `  sector: ${p.sector || '(none)'}`,
    `  use case: ${p.use_case_category || '(none)'}`,
    `  geography: ${p.geography || '(none)'}`,
    `  stage reached: ${p.stage_reached || '(none)'}`,
    `  summary: ${p.summary || '(none)'}`,
    ...(unitNames.length ? [`  micro-innovations: ${unitNames.map((n) => n.slice(0, UNIT_NAME_CHARS)).join(' | ')}`] : []),
  ].join('\n');
}

function unitNamesByPathway(units: BrainUnit[]): Map<string, string[]> {
  const names = new Map<string, string[]>();
  for (const u of units) {
    for (const owner of new Set([u.pathway, ...(u.pathways ?? [])].filter((o): o is string => !!o))) {
      if (!names.has(owner)) names.set(owner, []);
      names.get(owner)!.push(u.name ?? u.slug);
    }
  }
  return names;
}

/**
 * Works out what kind of question the latest message asks and picks the
 * published pathways that answer it, or null when the call failed. `forceType`
 * pins the kind (analysis documents are always about the person's own situation).
 */
export async function selectPathways(input: {
  pathways: BrainPathway[];
  // The pathways' units; their names go into the catalogue.
  units?: BrainUnit[];
  messages: Message[];
  meta?: CompanionMeta | null;
  mode: string;
  flow?: string | null;
  forceType?: QueryType;
}): Promise<Selection | null> {
  const { pathways, messages, meta, mode, flow, forceType } = input;
  const unitNames = unitNamesByPathway(input.units ?? []);
  if (pathways.length === 0) return { queryType: forceType ?? 'situation', slugs: [], dimensions: [], stages: [] };

  const recent = messages
    .slice(-SELECTION_TURNS)
    .map((m) => `${m.role}: ${messageText(m.content).slice(0, SELECTION_TURN_CHARS)}`)
    .join('\n\n');
  const known = meta
    ? Object.entries({ sector: meta.sector, geography: meta.geography, stage: meta.stage, summary: meta.summary, hypothesis: meta.hypothesis })
        .filter(([, v]) => typeof v === 'string' && v.trim())
        .map(([k, v]) => `${k}: ${v}`)
        .join('\n')
    : '';

  const prompt = `Someone is talking with Cube, an assistant grounded in a corpus of real AI deployment pathways. Work out what their LATEST message asks, then pick the published pathways that answer it.

Kinds of question, and how to pick:
- specific: they ask about a particular pathway, by name or unmistakably (e.g. "How did MahaVISTAAR cut its cost?"). Pick that pathway (at most ${LIMITS.specific.pathways}), whatever its sector.
- situation: they describe or ask about their own adoption (e.g. "We're starting a voice line for farmers, what should we watch for?"). Pick at most ${LIMITS.situation.pathways} that are in the same sector AND deal with the same kind of problem as theirs. The same sector alone is not a match; overlapping words are not a match.
- broad: a question on a topic across pathways (e.g. "How have teams handled data governance with government?"). Pick every pathway that genuinely documents that topic, at most ${LIMITS.broad.pathways}, any sector.
- patterns: they ask what is common, recurring or typical across deployments (e.g. "What usually goes wrong at the Pilot stage?"). Pick every pathway that shows it, at most ${LIMITS.patterns.pathways}, any sector, EVEN IF only one pathway does: Cube then says it is a single example, not a pattern. Return an empty list only when no pathway shows it at all.
${forceType ? `\nThis request is about their own adoption: use query_type "${forceType}".\n` : ''}
Also report the dimensions (${DIMENSIONS.join(', ')}) and stages (${STAGES.join(', ')}) the question is about, if it names any.

What is known about them so far:
${known || '(nothing recorded yet)'}

The conversation so far (most recent last):
${recent}

The published pathways, each with the names of its micro-innovations (a detail may appear only there):
${pathways.map((p) => catalogueLine(p, unitNames.get(p.slug))).join('\n')}

Call select_pathways, most relevant pathway first, or with an empty slugs array if none genuinely answers it.`;

  try {
    const result = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 512,
      tools: [SELECT_TOOL],
      tool_choice: { type: 'tool', name: SELECT_TOOL.name },
      messages: [{ role: 'user', content: prompt }],
    });
    recordAiUsage({ mode, flow, model: result.model, usage: result.usage, ok: true });
    const toolUse = result.content.find((b) => b.type === 'tool_use');
    const raw = (toolUse?.type === 'tool_use' ? toolUse.input : undefined) as
      | { query_type?: unknown; slugs?: unknown; dimensions?: unknown; stages?: unknown }
      | undefined;
    if (!raw || !Array.isArray(raw.slugs)) throw new Error('select_pathways returned no slugs list');

    const queryType: QueryType =
      forceType ?? ((QUERY_TYPES as readonly string[]).includes(raw.query_type as string) ? (raw.query_type as QueryType) : 'situation');
    const offered = new Set(pathways.map((p) => p.slug));
    const pick = (value: unknown, allowed: readonly string[]) =>
      Array.isArray(value) ? [...new Set(value.filter((v): v is string => typeof v === 'string' && allowed.includes(v)))] : [];
    return {
      queryType,
      slugs: pick(raw.slugs, [...offered]).slice(0, LIMITS[queryType].pathways),
      dimensions: pick(raw.dimensions, DIMENSIONS),
      stages: pick(raw.stages, STAGES),
    };
  } catch (err) {
    recordAiUsage({ mode, flow, model: MODEL, ok: false });
    logError('lib/brain/retrieve', err, { step: 'select', mode, flow });
    return null;
  }
}

// Cells the grid has anything on, as brain keys (`persona:explore`).
function focusCells(grid: GridState | null | undefined): Set<string> {
  return new Set(
    Object.entries(grid ?? {})
      .filter(([, cell]) => (cell?.density ?? 0) > 0)
      .map(([key]) => key.toLowerCase())
  );
}

function unitDims(u: BrainUnit): string[] {
  return [u.dimension, ...(u.dimensions ?? [])].filter(Boolean) as string[];
}

function unitStages(u: BrainUnit): string[] {
  return [u.stage, ...(u.stages ?? []), ...(u.also_relevant_at ?? [])].filter(Boolean) as string[];
}

/**
 * Units in the order they matter, at most `cap`: those for grid cells under
 * discussion, then those for the dimensions/stages the question names, then
 * the rest, each group in the given order.
 */
export function orderUnits(
  units: BrainUnit[],
  grid: GridState | null | undefined,
  focus: { dimensions?: string[]; stages?: string[] } = {},
  cap: number = LIMITS.situation.units
): BrainUnit[] {
  const cells = focusCells(grid);
  const dims = new Set(focus.dimensions ?? []);
  const stages = new Set(focus.stages ?? []);
  const score = (u: BrainUnit) => {
    const ds = unitDims(u);
    const ss = unitStages(u);
    if (ds.some((d) => ss.some((s) => cells.has(`${d}:${s}`.toLowerCase())))) return 3;
    const dimHit = dims.size > 0 && ds.some((d) => dims.has(d));
    const stageHit = stages.size > 0 && ss.some((s) => stages.has(s));
    if ((dimHit || !dims.size) && (stageHit || !stages.size) && (dims.size || stages.size)) return 2;
    return dimHit || stageHit ? 1 : 0;
  };
  return units
    .map((u, i) => ({ u, i, s: score(u) }))
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .slice(0, cap)
    .map((x) => x.u);
}

function contributedBy(document: string): string {
  const contributor = document.match(/^contributor:\s*(.+)$/m)?.[1]?.trim();
  return contributor ? `Contributed by: ${contributor}\n\n` : '';
}

function sectorLine(p: BrainPathway): string {
  return `Sector: ${p.sector || 'not stated'}\n\n`;
}

// The same "# Pathway: <slug>" heading loadWikiContext uses, which the prompts'
// pathwaysReferenced rule keys on.
function pathwaySection(p: BrainPathway, forAdopter = false): string {
  const document = forAdopter ? stripProvenanceAppendix(p.document) : p.document;
  return `# Pathway: ${p.slug}\n\n${sectorLine(p)}${contributedBy(p.document)}${datedLine(p.document, p.published_on)}${document}`;
}

function pathwaySummary(p: BrainPathway): string {
  return `# Pathway: ${p.slug}\n\n${sectorLine(p)}${contributedBy(p.document)}${p.title ?? p.slug}: ${p.summary ?? ''}`;
}

function unitSection(u: BrainUnit, sectors: Map<string, string>): string {
  const tags = [u.unit_type, [u.dimension, u.stage].filter(Boolean).join(' · ')].filter(Boolean).join(', ');
  const owners = [u.pathway, ...(u.pathways ?? [])].filter((o): o is string => !!o);
  const from = [...new Set(owners)].map((o) => `${o} (${sectors.get(o) || 'sector not stated'})`).join(', ');
  return `### ${u.name ?? u.slug}${tags ? ` (${tags})` : ''}\nFrom pathway: ${from}\n\n${u.body}`;
}

function indexBlock(pathways: BrainPathway[]): string {
  return `# Pathways Index\n\nEvery published pathway in the corpus:\n\n${pathways
    .map((p) => `- ${p.slug}: ${p.title ?? p.slug}${p.sector ? ` (${p.sector})` : ''}`)
    .join('\n')}`;
}

const NONE: Record<QueryType, string> = {
  specific:
    "The pathway this question asks about is not in the published corpus. Say so plainly; do not answer from general knowledge.",
  situation:
    "No published pathway matches this person's sector and kind of problem: every pathway above was checked. If they ask about pathway experience for their situation, say plainly that the corpus has none; do not fill the gap with general knowledge.",
  broad: 'No published pathway documents this topic. Say so plainly; do not fill the gap with general knowledge.',
  patterns:
    'No published pathways show a pattern on this. Say so plainly; do not construct one from general knowledge.',
};

const INTRO: Record<QueryType, (n: number, docs: number) => string> = {
  specific: (n) =>
    `This question asks about ${n === 1 ? 'a specific pathway' : 'specific pathways'}. Answer precisely from ${n === 1 ? 'its' : 'their'} own document below. If ${n === 1 ? 'it is' : 'one is'} from another sector than the person's, say so in the same breath.`,
  situation: (n, docs) =>
    `These ${n} pathway(s) match this person's sector and kind of problem, most relevant first. The full document is included for the first ${docs}; the rest are represented by their summary and micro-innovations.`,
  broad: (n) =>
    `This is a broad question across pathways. These ${n} pathway(s) bear on it. Answer point by point, naming the pathway behind each point. Each pathway's sector is given: when it differs from the person's, say so (an adjacent match, not an exact one).`,
  patterns: (n) =>
    `This question asks for common patterns. These ${n} pathway(s) bear on it${n === 1 ? ': only one pathway shows it, so present it as a single example from that pathway, not a pattern, and say so plainly' : ''}. Identify what they show IN COMMON: start from the recorded patterns, then lessons that recur across their micro-innovations. Name the pathways behind every pattern. Something shown by only one pathway is "a single example", not a pattern: say so. Never construct a pattern the material below doesn't show.`,
};

/**
 * The grounding block for a selection (already filtered to published slugs,
 * in rank order). `forAdopter` strips each document's contributor-only Source
 * Trace appendix: required for the public library.
 */
export async function buildGroundingBlock(
  pathways: BrainPathway[],
  selection: Selection,
  grid: GridState | null | undefined,
  { forAdopter = false }: { forAdopter?: boolean } = {}
): Promise<string> {
  const { queryType } = selection;
  const limits = LIMITS[queryType];
  const parts = [indexBlock(pathways)];

  const bySlug = new Map(pathways.map((p) => [p.slug, p]));
  const selected = selection.slugs
    .map((s) => bySlug.get(s))
    .filter((p): p is BrainPathway => !!p)
    .slice(0, limits.pathways);
  if (selected.length === 0) {
    parts.push(`# Matching pathways\n\n${NONE[queryType]}`);
    return parts.join('\n\n---\n\n');
  }

  const docs = Math.min(limits.documents, selected.length);
  parts.push(`# Matching pathways\n\n${INTRO[queryType](selected.length, docs)}`);
  selected.forEach((p, i) => parts.push(i < docs ? pathwaySection(p, forAdopter) : pathwaySummary(p)));

  const sectors = new Map(pathways.map((p) => [p.slug, p.sector ?? '']));
  const units = await unitsFor(selected.map((p) => p.slug));
  const focus = { dimensions: selection.dimensions, stages: selection.stages };

  if (queryType === 'patterns') {
    const chosen = new Set(selected.map((p) => p.slug));
    const recorded = units.filter((u) => u.unit_type === PATTERN);
    // A dimension × stage lesson recurring across at least two selected pathways.
    const cellPathways = new Map<string, Set<string>>();
    for (const u of units) {
      if (u.unit_type === PATTERN || !u.pathway || !chosen.has(u.pathway)) continue;
      for (const s of unitStages(u)) {
        const key = `${u.dimension}:${s}`;
        if (!cellPathways.has(key)) cellPathways.set(key, new Set());
        cellPathways.get(key)!.add(u.pathway);
      }
    }
    const recurs = (u: BrainUnit) => unitStages(u).some((s) => (cellPathways.get(`${u.dimension}:${s}`)?.size ?? 0) >= 2);
    const lessons = units.filter((u) => u.unit_type !== PATTERN);
    const ordered = [
      ...orderUnits(lessons.filter(recurs), grid, focus, limits.units),
      ...orderUnits(lessons.filter((u) => !recurs(u)), grid, focus, limits.units),
    ].slice(0, Math.max(0, limits.units - recorded.length));
    parts.push(
      recorded.length
        ? `# Patterns recorded in the brain\n\nEach was built from evidence in the pathways it names.\n\n${recorded.map((u) => unitSection(u, sectors)).join('\n\n')}`
        : '# Patterns recorded in the brain\n\nNone recorded for these pathways: any pattern has to come from the micro-innovations below, across at least two pathways.'
    );
    parts.push(
      `# Micro-innovations from these pathways\n\nThose whose dimension and stage recur across at least two of these pathways come first. Each is another adoption's lived experience: a suggestion, never a recommendation.\n\n${ordered
        .map((u) => unitSection(u, sectors))
        .join('\n\n')}`
    );
    return parts.join('\n\n---\n\n');
  }

  const ordered = orderUnits(units, grid, focus, limits.units);
  parts.push(
    ordered.length
      ? `# Micro-innovations from the matching pathways\n\nEach is another adoption's lived experience: offer it as a suggestion the user can judge, never as a recommendation.\n\n${ordered
          .map((u) => unitSection(u, sectors))
          .join('\n\n')}`
      : '# Micro-innovations from the matching pathways\n\nNone of the matching pathways has a micro-innovation recorded for this.'
  );
  return parts.join('\n\n---\n\n');
}

/** Every published pathway in full: the fallback, and today's behaviour. */
export async function wholeCorpusContext(): Promise<string> {
  const pathways = await publishedPathways();
  return [indexBlock(pathways), ...pathways.map((p) => pathwaySection(p))].join('\n\n---\n\n');
}

export function gridHash(grid: GridState | null | undefined): string {
  const entries = Object.entries(grid ?? {}).sort(([a], [b]) => a.localeCompare(b));
  return createHash('sha256').update(JSON.stringify(entries)).digest('hex');
}

/**
 * The grounding for one Analyse (or Contributor) request. `supabase` is the
 * caller's session client: the design is checked to be theirs (RLS) before
 * its saved selection is read or written.
 */
export async function groundingForConversation(input: {
  supabase: SupabaseClient;
  designId?: unknown;
  grid?: GridState | null;
  meta?: CompanionMeta | null;
  messages: Message[];
  mode: string;
  flow?: string | null;
}): Promise<string> {
  const { supabase, grid, meta, messages, mode, flow } = input;
  const pathways = await publishedPathways();
  const live = new Set(pathways.map((p) => p.slug));
  const isDocument = mode === 'analysis-doc' || mode === 'executive-summary';

  let designId: string | null = null;
  if (typeof input.designId === 'string' && input.designId) {
    const { data } = await supabase.from('designs').select('id').eq('id', input.designId).maybeSingle();
    designId = data?.id ?? null;
  }

  const admin = createAdminClient();
  // A document is about the person's own adoption: it reuses the
  // conversation's last `situation` pick. A companion turn always selects
  // afresh, since each message may ask a different kind of question.
  if (designId && isDocument) {
    const { data: saved } = await admin.from('knowledge_selections').select('slugs').eq('design_id', designId).maybeSingle();
    if (saved) {
      const slugs = (saved.slugs as string[]).filter((s) => live.has(s));
      return buildGroundingBlock(pathways, { queryType: 'situation', slugs, dimensions: [], stages: [] }, grid);
    }
  }

  const units = await unitsFor(pathways.map((p) => p.slug));
  const selection = await selectPathways({ pathways, units, messages, meta, mode, flow, forceType: isDocument ? 'situation' : undefined });
  if (selection === null) return wholeCorpusContext();

  if (designId && selection.queryType === 'situation') {
    const { error } = await admin
      .from('knowledge_selections')
      .upsert(
        { design_id: designId, grid_hash: gridHash(grid), slugs: selection.slugs, updated_at: new Date().toISOString() },
        { onConflict: 'design_id' }
      );
    if (error) logError('lib/brain/retrieve', error, { step: 'save-selection' });
  }
  return buildGroundingBlock(pathways, selection, grid);
}

/**
 * Grounding for the library chat with no pathway open: the published
 * pathways the visitor's latest question needs, of whichever kind, Source
 * Trace stripped. '' when the selection call fails, so the chat answers from
 * the overview alone.
 */
export async function libraryGrounding(messages: Message[]): Promise<string> {
  const pathways = await publishedPathways();
  const units = await unitsFor(pathways.map((p) => p.slug));
  const selection = await selectPathways({ pathways, units, messages, mode: 'library' });
  if (selection === null) return '';
  return buildGroundingBlock(pathways, selection, null, { forAdopter: true });
}
