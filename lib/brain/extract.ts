import path from 'path';
import Anthropic from '@anthropic-ai/sdk';
import { recordAiUsage } from '@/lib/ai-usage';
import { readStaticFile } from '@/lib/static-content';
import { DIMENSIONS, GRID_KEYS, PATHWAY_KINDS, SECTORS, STAGES, SUB_CATEGORIES, UNIT_TYPES } from '@/lib/brain/vocab';

// Send for review → the pathway entry and micro-innovation units for the
// Cube-Brain, extracted from the contributor's assembled document by one
// Claude call (docs/features/cube-brain-knowledge-source/, CB-13). The rules
// are the brain skill's own (content/brain-ingest-rules.md, copied from it)
// so units from the app match units ingested with the skill. Rendering to
// brain files is lib/brain/entries.ts; an admin reviews both in the PR.

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = 'claude-sonnet-4-6';
const RULES_FILE = path.join(process.cwd(), 'content', 'brain-ingest-rules.md');

export interface ExtractedPathway {
  name: string;
  summary: string;
  pathway_kind?: string;
  sector?: string;
  use_case_category?: string;
  geography?: string;
  population_served?: string;
  stage_reached?: string;
  key_dates?: string;
  scale_impact?: string;
  cost_anchor?: string;
  build_effort?: string;
  tags?: string[];
  gaps?: string[];
  coverage?: Record<string, number>;
  reusable_value?: string;
}

export interface ExtractedUnit {
  short_name: string;
  name: string;
  summary?: string;
  unit_type: string;
  dimension?: string;
  sub_category?: string;
  stage?: string;
  also_relevant_at?: string[];
  source_unit_id?: string;
  applies_when?: string;
  fails_when?: string;
  decision?: string;
  alternative_considered?: string;
  reason?: string;
  context?: string;
  before?: string;
  after?: string;
  failure?: string;
  fix?: string;
  insight?: string;
  steps?: string[];
  common_failure_mode?: string;
  purpose?: string;
  reuse_condition?: string;
  problem?: string;
  root_cause?: string;
  solution?: string;
  result?: string;
  condition?: string;
  evidence?: string[];
  adopter_intents?: string[];
  unit_text: string;
  why_reusable?: string;
}

export interface ExtractedEntries {
  pathway: ExtractedPathway;
  units: ExtractedUnit[];
}

const str = { type: 'string' } as const;
const strList = { type: 'array', items: { type: 'string' } } as const;

const ENTRIES_TOOL: Anthropic.Tool = {
  name: 'brain_entries',
  description: 'Report the Cube-Brain pathway entry and the micro-innovation units extracted from the pathway document.',
  input_schema: {
    type: 'object',
    properties: {
      pathway: {
        type: 'object',
        properties: {
          name: str,
          summary: { type: 'string', description: 'One or two sentences.' },
          pathway_kind: { type: 'string', enum: [...PATHWAY_KINDS] },
          sector: { type: 'string', enum: [...SECTORS] },
          use_case_category: str,
          geography: str,
          population_served: str,
          stage_reached: { type: 'string', enum: [...STAGES] },
          key_dates: str,
          scale_impact: { type: 'string', description: 'Headline usage/outcome numbers WITH an as-of date.' },
          cost_anchor: { type: 'string', description: 'Order of magnitude WITH an as-of date.' },
          build_effort: str,
          tags: strList,
          gaps: { ...strList, description: 'Open questions the pathway itself names.' },
          coverage: {
            type: 'object',
            description: `Density 0-3 per grid cell, from the document's Section 2. Keys: ${GRID_KEYS.join(', ')}.`,
            additionalProperties: { type: 'integer', minimum: 0, maximum: 3 },
          },
          reusable_value: { type: 'string', description: 'A short paragraph: where the reusable value of this pathway is.' },
        },
        required: ['name', 'summary'],
      },
      units: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            short_name: { type: 'string', description: 'Kebab-case, at most 6 words, unique in this list.' },
            name: str,
            summary: str,
            unit_type: { type: 'string', enum: [...UNIT_TYPES] },
            dimension: { type: 'string', enum: [...DIMENSIONS] },
            sub_category: { type: 'string', enum: Object.values(SUB_CATEGORIES).flat() },
            stage: { type: 'string', enum: [...STAGES] },
            also_relevant_at: { type: 'array', items: { type: 'string', enum: [...STAGES] } },
            source_unit_id: str,
            applies_when: str,
            fails_when: str,
            decision: str,
            alternative_considered: str,
            reason: str,
            context: str,
            before: str,
            after: str,
            failure: str,
            fix: str,
            insight: str,
            steps: strList,
            common_failure_mode: str,
            purpose: str,
            reuse_condition: str,
            problem: str,
            root_cause: str,
            solution: str,
            result: str,
            condition: str,
            evidence: { ...strList, description: 'Patterns only: the short_name of each unit in this list it is built from.' },
            adopter_intents: strList,
            unit_text: { type: 'string', description: 'The unit in the framework\'s own form, attributed to the contributor ("According to <contributor>\'s pathway, ...").' },
            why_reusable: str,
          },
          required: ['short_name', 'name', 'unit_type', 'unit_text'],
        },
      },
    },
    required: ['pathway', 'units'],
  },
};

/**
 * Extracts the pathway entry and units from an assembled pathway document.
 * Throws when the call fails or returns no units: the caller commits nothing.
 */
export async function extractBrainEntries(document: string, context: { slug: string; title: string }): Promise<ExtractedEntries> {
  const rules = await readStaticFile(RULES_FILE);
  if (!rules) throw new Error('content/brain-ingest-rules.md is missing');

  const prompt = `You are adding a contributor's AI deployment pathway to the Cube-Brain, the knowledge base the 100 Pathways app answers from. Extract its pathway entry and one unit per micro-innovation, following these rules exactly:

${rules}

Use only what the document says; leave a field out rather than guess. Never copy anything from the Source Trace / Provenance appendix.

The pathway's slug is "${context.slug}" and its title is "${context.title}".

PATHWAY DOCUMENT:
${document}

Call brain_entries with the result.`;

  let message: Anthropic.Message;
  try {
    // Streamed and awaited whole: the output is long, and streaming keeps
    // the connection from idling out.
    message = await anthropic.messages
      .stream({
        model: MODEL,
        max_tokens: 16000,
        tools: [ENTRIES_TOOL],
        tool_choice: { type: 'tool', name: ENTRIES_TOOL.name },
        messages: [{ role: 'user', content: prompt }],
      })
      .finalMessage();
  } catch (err) {
    recordAiUsage({ mode: 'brain-extract', model: MODEL, ok: false });
    throw err;
  }
  recordAiUsage({ mode: 'brain-extract', model: message.model, usage: message.usage, ok: true });

  if (message.stop_reason === 'max_tokens') throw new Error('Brain extraction was cut off at max_tokens');
  const toolUse = message.content.find((b) => b.type === 'tool_use');
  const input = toolUse?.type === 'tool_use' ? (toolUse.input as Partial<ExtractedEntries>) : undefined;
  if (!input?.pathway || typeof input.pathway.name !== 'string') throw new Error('Brain extraction returned no pathway');
  if (!Array.isArray(input.units) || input.units.length === 0) throw new Error('Brain extraction returned no units');
  return { pathway: input.pathway, units: input.units };
}
