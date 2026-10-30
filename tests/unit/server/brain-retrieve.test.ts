import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createSupabaseMock, type SupabaseMock } from '../../helpers/supabase-mock';
import { fakeTextMessage, fakeToolUseMessage } from '../../helpers/anthropic-mock';
import type { BrainSnapshot, BrainUnit } from '@/lib/brain/snapshot';

const anthropic = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = { create: anthropic.create };
  },
}));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: vi.fn() }));
vi.mock('@/lib/brain/snapshot', () => ({ getBrainSnapshot: vi.fn() }));
vi.mock('@/lib/errors', () => ({ logError: vi.fn() }));
vi.mock('@/lib/ai-usage', () => ({ recordAiUsage: vi.fn() }));

import { createAdminClient } from '@/lib/supabase/admin';
import { getBrainSnapshot } from '@/lib/brain/snapshot';
import { logError } from '@/lib/errors';
import { recordAiUsage } from '@/lib/ai-usage';
import { EMPTY_GRID, type GridState } from '@/lib/dimensions';
import { gridHash, groundingForConversation, libraryGrounding, orderUnits, selectPathways } from '@/lib/brain/retrieve';

// Intent-aware grounding (CB-09, CB-10, CB-17): the three must-have retrieval
// capabilities (specific pathway, across pathways, common patterns), plus the
// person's own situation.

const doc = (slug: string, marker: string) =>
  `---\ntitle: ${slug}\ncontributor: ${slug} team\ntimestamp: 2026-08-31\n---\n\n# Overview\n\n${marker}\n\n## Source Trace\n\n- PROVENANCE-${slug}`;

const unit = (slug: string, pathway: string, dimension: string, stage: string, extra: Partial<BrainUnit> = {}): BrainUnit => ({
  slug,
  name: slug,
  pathway,
  unit_type: 'Strategic Decision',
  dimension,
  stage,
  body: `body of ${slug}`,
  ...extra,
});

const SNAPSHOT: BrainSnapshot = {
  schema_version: 1,
  pathways: [
    { slug: 'mahavistaar', title: 'MahaVISTAAR', sector: 'Agriculture', lifecycle: 'published', document: doc('mahavistaar', 'MAHA-TEXT') },
    { slug: 'blue-dots', title: 'Blue Dots', sector: 'Livelihoods', lifecycle: 'published', document: doc('blue-dots', 'BLUE-TEXT') },
    { slug: 'data-dhara', title: 'Data DHARA', sector: 'Data Infrastructure', lifecycle: 'published', document: doc('data-dhara', 'DHARA-TEXT') },
    { slug: 'african-voice-ai', title: 'African Voice AI', sector: 'Agriculture', lifecycle: 'published', document: doc('african-voice-ai', 'AFRICA-TEXT') },
  ],
  units: [
    unit('maha-explore', 'mahavistaar', 'persona', 'explore'),
    unit('maha-pilot', 'mahavistaar', 'institution', 'pilot'),
    unit('blue-pilot', 'blue-dots', 'institution', 'pilot'),
    unit('blue-scale', 'blue-dots', 'solution', 'scale'),
    unit('dhara-define', 'data-dhara', 'ecosystem', 'define'),
    unit('pattern-trust', '', 'institution', 'pilot', {
      pathway: undefined,
      pathways: ['mahavistaar', 'blue-dots'],
      unit_type: 'Problem-Solution Pattern',
    }),
  ],
  organisations: [],
};

const MESSAGES = [{ role: 'user', content: 'We run a voice advisory line for farmers in Maharashtra.' }];

let session: SupabaseMock;
let admin: SupabaseMock;
let saved: { slugs: string[] } | null;

function gridWith(...keys: string[]): GridState {
  const grid = structuredClone(EMPTY_GRID);
  for (const k of keys) grid[k] = { density: 2, note: 'x' };
  return grid;
}

const selects = (input: object) => anthropic.create.mockResolvedValue(fakeToolUseMessage(input));

beforeEach(() => {
  anthropic.create.mockReset();
  vi.mocked(getBrainSnapshot).mockResolvedValue(SNAPSHOT);
  saved = null;
  session = createSupabaseMock({ tables: { designs: (op) => ({ data: op.filters.some((f) => f[2] === 'd-own') ? { id: 'd-own' } : null }) } });
  admin = createSupabaseMock({
    tables: { knowledge_selections: (op) => (op.action === 'select' ? { data: saved } : {}) },
  });
  vi.mocked(createAdminClient).mockReturnValue(admin.client);
});

const ground = (overrides: Record<string, unknown> = {}) =>
  groundingForConversation({ supabase: session.client, designId: 'd-own', grid: EMPTY_GRID, messages: MESSAGES, mode: 'companion', flow: 'explorer', ...overrides });

describe('the selection call', () => {
  it('asks for the kind of question as well as the pathways, with every published pathway in the catalogue', async () => {
    selects({ query_type: 'situation', slugs: [] });
    await ground();
    const args = anthropic.create.mock.calls[0][0];
    expect(args.tool_choice).toEqual({ type: 'tool', name: 'select_pathways' });
    expect(args.tools[0].input_schema.properties.query_type.enum).toEqual(['specific', 'situation', 'broad', 'patterns']);
    const prompt = args.messages[0].content as string;
    for (const slug of ['mahavistaar', 'blue-dots', 'data-dhara', 'african-voice-ai']) expect(prompt).toContain(`slug: ${slug}`);
    expect(prompt).toContain('LATEST message');
    expect(recordAiUsage).toHaveBeenCalledWith(expect.objectContaining({ mode: 'companion', flow: 'explorer', ok: true }));
  });

  it('keeps only offered slugs, once each, within the kind\'s limit', async () => {
    selects({ query_type: 'situation', slugs: ['nope', 'mahavistaar', 'mahavistaar', 'blue-dots', 'data-dhara', 'african-voice-ai'] });
    const s = await selectPathways({ pathways: SNAPSHOT.pathways, messages: MESSAGES, mode: 'companion' });
    expect(s).toEqual({ queryType: 'situation', slugs: ['mahavistaar', 'blue-dots', 'data-dhara'], dimensions: [], stages: [] });
  });

  it('treats an unknown kind as the person\'s own situation, and drops focus values outside the vocabularies', async () => {
    selects({ query_type: 'gossip', slugs: ['mahavistaar'], dimensions: ['institution', 'people'], stages: ['pilot', 'launch'] });
    expect(await selectPathways({ pathways: SNAPSHOT.pathways, messages: MESSAGES, mode: 'companion' })).toEqual({
      queryType: 'situation',
      slugs: ['mahavistaar'],
      dimensions: ['institution'],
      stages: ['pilot'],
    });
  });

  it('runs for every new message: no reuse between companion turns', async () => {
    selects({ query_type: 'situation', slugs: ['mahavistaar'] });
    await ground();
    await ground({ messages: [...MESSAGES, { role: 'assistant', content: 'ok' }, { role: 'user', content: 'How did Blue Dots handle trust?' }] });
    expect(anthropic.create).toHaveBeenCalledTimes(2);
  });
});

describe('capability 1: specific information from an individual pathway', () => {
  it('grounds on the named pathway\'s own document even from another sector, with its sector stated', async () => {
    selects({ query_type: 'specific', slugs: ['blue-dots'] });
    const block = await ground();
    expect(block).toMatch(/asks about a specific pathway\. Answer precisely from its own document/);
    expect(block).toContain('# Pathway: blue-dots\n\nSector: Livelihoods');
    expect(block).toContain('BLUE-TEXT');
    expect(block).not.toContain('MAHA-TEXT');
  });

  it('includes both documents when two pathways are named, and no more than two', async () => {
    selects({ query_type: 'specific', slugs: ['blue-dots', 'data-dhara', 'mahavistaar'] });
    const block = await ground();
    expect(block).toContain('BLUE-TEXT');
    expect(block).toContain('DHARA-TEXT');
    expect(block).not.toContain('# Pathway: mahavistaar');
  });

  it('says plainly when the pathway asked about isn\'t published', async () => {
    selects({ query_type: 'specific', slugs: [] });
    expect(await ground()).toMatch(/not in the published corpus\. Say so plainly/);
  });
});

describe('the person\'s own situation (unchanged rule)', () => {
  it('grounds on matching pathways: top two in full, the third summarised, units for the cells in focus first', async () => {
    selects({ query_type: 'situation', slugs: ['mahavistaar', 'african-voice-ai', 'blue-dots'] });
    const block = await ground({ grid: gridWith('institution:Pilot') });
    expect(block).toContain('MAHA-TEXT');
    expect(block).toContain('AFRICA-TEXT');
    expect(block).not.toContain('BLUE-TEXT');
    expect(block).toContain('# Pathway: blue-dots');
    expect(block).toContain('Contributed by: mahavistaar team');
    expect(block.indexOf('### maha-pilot')).toBeLessThan(block.indexOf('### maha-explore'));
    expect(block).toMatch(/- data-dhara: Data DHARA/);
  });

  it('marks a genuine no-match plainly', async () => {
    selects({ query_type: 'situation', slugs: [] });
    const block = await ground();
    expect(block).toMatch(/No published pathway matches this person's sector and kind of problem/);
    expect(block).not.toContain('# Pathway:');
  });

  it('saves the situation pick for the design\'s analysis documents', async () => {
    selects({ query_type: 'situation', slugs: ['mahavistaar'] });
    await ground();
    expect(admin.ops('knowledge_selections', 'upsert')[0].payload).toMatchObject({
      design_id: 'd-own',
      grid_hash: gridHash(EMPTY_GRID),
      slugs: ['mahavistaar'],
    });
  });

  it.each(['specific', 'broad', 'patterns'])('does not overwrite that pick with a %s question', async (queryType) => {
    selects({ query_type: queryType, slugs: ['blue-dots'] });
    await ground();
    expect(admin.ops('knowledge_selections', 'upsert')).toHaveLength(0);
  });
});

describe('capability 2: relevant answers across multiple pathways', () => {
  it('draws units from every selected pathway, labelled with pathway and sector, focus first', async () => {
    selects({ query_type: 'broad', slugs: ['mahavistaar', 'blue-dots', 'data-dhara'], dimensions: ['institution'], stages: ['pilot'] });
    const block = await ground();
    expect(block).toMatch(/broad question across pathways\. .*Answer point by point, naming the pathway behind each point/);
    for (const u of ['maha-pilot', 'blue-pilot', 'dhara-define']) expect(block).toContain(`### ${u}`);
    expect(block).toContain('From pathway: blue-dots (Livelihoods)');
    expect(block.indexOf('### blue-pilot')).toBeLessThan(block.indexOf('### blue-scale'));
    // One document in full; the others summarised.
    expect(block).toContain('MAHA-TEXT');
    expect(block).not.toContain('BLUE-TEXT');
  });

  it('allows up to six pathways', async () => {
    const many = Array.from({ length: 8 }, (_, i) => ({ slug: `p${i}`, title: `P${i}`, sector: 'X', lifecycle: 'published', document: `# P${i}` }));
    vi.mocked(getBrainSnapshot).mockResolvedValue({ ...SNAPSHOT, pathways: many });
    selects({ query_type: 'broad', slugs: many.map((p) => p.slug) });
    const s = await selectPathways({ pathways: many, messages: MESSAGES, mode: 'companion' });
    expect(s?.slugs).toHaveLength(6);
  });
});

describe('capability 3: common patterns across multiple pathways', () => {
  it('leads with recorded patterns, then lessons recurring across pathways, with synthesis rules', async () => {
    selects({ query_type: 'patterns', slugs: ['mahavistaar', 'blue-dots', 'data-dhara'] });
    const block = await ground();
    expect(block).toMatch(/Name the pathways behind every pattern/);
    expect(block).toMatch(/only one pathway is "a single example", not a pattern/);
    expect(block).toMatch(/Never construct a pattern/);
    expect(block).toContain('# Patterns recorded in the brain');
    expect(block).toContain('From pathway: mahavistaar (Agriculture), blue-dots (Livelihoods)');
    // institution × pilot recurs in two pathways; it outranks the one-off lessons.
    const recurring = Math.max(block.indexOf('### maha-pilot'), block.indexOf('### blue-pilot'));
    expect(recurring).toBeLessThan(block.indexOf('### dhara-define'));
    expect(recurring).toBeLessThan(block.indexOf('### maha-explore'));
    // The top pathway's document, the rest summarised.
    expect(block).toContain('MAHA-TEXT');
    expect(block).not.toContain('BLUE-TEXT');
  });

  it('says when no pattern is recorded, so one must come from at least two pathways', async () => {
    selects({ query_type: 'patterns', slugs: ['data-dhara', 'african-voice-ai'] });
    expect(await ground()).toMatch(/None recorded for these pathways: any pattern has to come from the micro-innovations below, across at least two pathways/);
  });

  it('presents a finding from only one pathway as a single example, not a pattern', async () => {
    selects({ query_type: 'patterns', slugs: ['mahavistaar'] });
    const block = await ground();
    expect(block).toMatch(/only one pathway shows it, so present it as a single example from that pathway, not a pattern/);
    expect(block).toContain('MAHA-TEXT');
  });

  it('asks the selection to keep a one-pathway finding rather than return nothing', async () => {
    selects({ query_type: 'patterns', slugs: ['mahavistaar'] });
    await ground();
    expect(anthropic.create.mock.calls[0][0].messages[0].content).toMatch(/EVEN IF only one pathway does/);
  });

  it('says plainly when no pathway shows a pattern', async () => {
    selects({ query_type: 'patterns', slugs: [] });
    expect(await ground()).toMatch(/No published pathways show a pattern on this/);
  });
});

describe('analysis documents', () => {
  it('reuse the conversation\'s last situation pick, with no Claude call', async () => {
    saved = { slugs: ['blue-dots', 'retired-one'] };
    const block = await ground({ mode: 'analysis-doc', grid: gridWith('persona:Explore') });
    expect(anthropic.create).not.toHaveBeenCalled();
    expect(block).toContain('BLUE-TEXT');
    expect(block).not.toContain('retired-one');
  });

  it('select in situation mode when nothing is saved', async () => {
    selects({ query_type: 'broad', slugs: ['mahavistaar'] });
    const block = await ground({ mode: 'executive-summary' });
    expect(anthropic.create.mock.calls[0][0].messages[0].content).toContain('use query_type "situation"');
    expect(block).toMatch(/match this person's sector and kind of problem/);
  });
});

describe('safety', () => {
  it('never reads or writes the saved selection for a design that is not the caller\'s', async () => {
    saved = { slugs: ['blue-dots'] };
    selects({ query_type: 'situation', slugs: ['mahavistaar'] });
    await ground({ designId: 'd-someone-else', mode: 'analysis-doc' });
    expect(admin.ops('knowledge_selections')).toHaveLength(0);
  });

  it('falls back to the whole published corpus when the selection call fails', async () => {
    anthropic.create.mockRejectedValue(new Error('overloaded'));
    const block = await ground();
    for (const marker of ['MAHA-TEXT', 'BLUE-TEXT', 'DHARA-TEXT', 'AFRICA-TEXT']) expect(block).toContain(marker);
    expect(logError).toHaveBeenCalledWith('lib/brain/retrieve', expect.any(Error), expect.objectContaining({ step: 'select' }));
    expect(recordAiUsage).toHaveBeenCalledWith(expect.objectContaining({ ok: false }));
  });

  it('treats a reply without the tool call as a failure', async () => {
    anthropic.create.mockResolvedValue(fakeTextMessage('mahavistaar looks right'));
    expect(await ground()).toContain('DHARA-TEXT');
  });

  it('keeps the document whole for Analyse, as the in-repo corpus always has', async () => {
    selects({ query_type: 'specific', slugs: ['mahavistaar'] });
    expect(await ground()).toContain('PROVENANCE-mahavistaar');
  });
});

describe('libraryGrounding', () => {
  it.each(['specific', 'broad', 'patterns', 'situation'])('serves a %s question with Source Trace stripped', async (queryType) => {
    selects({ query_type: queryType, slugs: ['mahavistaar', 'blue-dots'] });
    const block = await libraryGrounding(MESSAGES);
    expect(block).not.toMatch(/Source Trace|PROVENANCE-/);
    expect(block).toContain('# Pathway: mahavistaar');
    expect(recordAiUsage).toHaveBeenCalledWith(expect.objectContaining({ mode: 'library', ok: true }));
  });

  it('adds nothing when the selection fails, so the overview alone answers', async () => {
    anthropic.create.mockRejectedValue(new Error('overloaded'));
    expect(await libraryGrounding(MESSAGES)).toBe('');
  });
});

describe('orderUnits', () => {
  const units = [unit('a', 'p', 'persona', 'explore'), unit('b', 'p', 'institution', 'pilot'), unit('c', 'p', 'solution', 'scale')];

  it('puts units for cells under discussion first', () => {
    expect(orderUnits(units, gridWith('institution:Pilot')).map((u) => u.slug)).toEqual(['b', 'a', 'c']);
  });

  it('counts also_relevant_at as in focus', () => {
    const extra = { ...unit('d', 'p', 'solution', 'explore'), also_relevant_at: ['scale'] };
    expect(orderUnits([...units, extra], gridWith('solution:Scale')).map((u) => u.slug)).toEqual(['c', 'd', 'a', 'b']);
  });

  it('then the dimensions and stages the question names', () => {
    expect(orderUnits(units, EMPTY_GRID, { dimensions: ['solution'] }).map((u) => u.slug)).toEqual(['c', 'a', 'b']);
    expect(orderUnits(units, EMPTY_GRID, { stages: ['pilot'] }).map((u) => u.slug)).toEqual(['b', 'a', 'c']);
  });

  it('keeps the given order on an empty grid with no focus, and caps the count', () => {
    const many = Array.from({ length: 40 }, (_, i) => unit(`u${i}`, 'p', 'persona', 'explore'));
    const ordered = orderUnits(many, EMPTY_GRID);
    expect(ordered).toHaveLength(30);
    expect(ordered[0].slug).toBe('u0');
    expect(orderUnits(many, EMPTY_GRID, {}, 40)).toHaveLength(40);
  });
});

describe('gridHash', () => {
  it('ignores key order', () => {
    const a = { 'persona:Explore': { density: 1, note: '' }, 'solution:Define': { density: 0, note: '' } } as GridState;
    const b = { 'solution:Define': { density: 0, note: '' }, 'persona:Explore': { density: 1, note: '' } } as GridState;
    expect(gridHash(a)).toBe(gridHash(b));
  });
});
