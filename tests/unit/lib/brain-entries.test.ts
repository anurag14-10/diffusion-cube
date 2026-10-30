import { describe, expect, it } from 'vitest';
import { renderBrainEntries } from '@/lib/brain/entries';
import type { ExtractedEntries, ExtractedUnit } from '@/lib/brain/extract';

// Extracted pathway → Cube-Brain files for the Send-for-review PR (CB-13).

const DOCUMENT = `---
title: Sahayak for Health
description: A health helper for ASHA workers.
location: Bihar, India
stage: Pilot
---

# Overview

The account.

## Source Trace

- interview`;

const unit = (over: Partial<ExtractedUnit> = {}): ExtractedUnit => ({
  short_name: 'train-ashas-first',
  name: 'Train ASHAs before launch',
  summary: 'Training came first.',
  unit_type: 'Tactical Decision',
  dimension: 'institution',
  sub_category: 'institution-b',
  stage: 'pilot',
  also_relevant_at: ['scale', 'pilot'],
  applies_when: 'Frontline workers are the users.',
  decision: 'Train first',
  before: 'No training',
  after: 'Trained cohort',
  unit_text: "According to the contributor's pathway, training came first.",
  ...over,
});

const EXTRACTED: ExtractedEntries = {
  pathway: {
    name: 'Sahayak for Health',
    summary: 'A health helper.',
    sector: 'Public Health',
    stage_reached: 'pilot',
    pathway_kind: 'single-deployment',
    tags: ['Voice AI'],
    coverage: { 'persona:Explore': 2, 'institution:Pilot': 3, 'bogus:Key': 2, 'solution:Define': 7 },
    gaps: ['Who maintains it?'],
    reusable_value: 'The training sequence.',
  },
  units: [unit()],
};

function render(over: Partial<Parameters<typeof renderBrainEntries>[0]> = {}) {
  return renderBrainEntries({
    slug: 'sahayak-for-health',
    title: 'Sahayak for Health',
    document: DOCUMENT,
    extracted: EXTRACTED,
    takenUnitSlugs: new Set(),
    replacedUnitSlugs: [],
    today: '2026-10-30',
    now: new Date('2026-10-30T10:11:12.345Z'),
    ...over,
  });
}

const file = (r: ReturnType<typeof render>, path: string) => r.files.find((f) => f.path === path)?.content ?? undefined;

// Frontmatter lines are `key: <JSON>`; parse them back.
function fields(content: string): Record<string, unknown> {
  const fm = content.match(/^---\n([\s\S]*?)\n---/)![1];
  return Object.fromEntries(
    fm.split('\n').map((line) => {
      const i = line.indexOf(': ');
      return [line.slice(0, i), JSON.parse(line.slice(i + 2))];
    })
  );
}

describe('renderBrainEntries', () => {
  it('writes the document verbatim, Source Trace included', () => {
    expect(file(render(), 'documents/sahayak-for-health.md')).toBe(DOCUMENT);
  });

  it('writes a published pathway entry with its card fields from the document and only valid coverage', () => {
    const fm = fields(file(render(), 'pathways/sahayak-for-health.md')!);
    expect(fm).toMatchObject({
      name: 'Sahayak for Health',
      type: 'pathway',
      schema_version: 2,
      sector: 'Public Health',
      stage_reached: 'pilot',
      lifecycle: 'published',
      published_on: '2026-10-30',
      card_hook: 'A health helper for ASHA workers.',
      card_location: 'Bihar, India',
      doc_refs: ['documents/sahayak-for-health.md'],
      coverage: { 'persona:Explore': 2, 'institution:Pilot': 3 },
    });
    expect(fm.sources).toEqual([expect.objectContaining({ system: 'diffusion_cube_app', method: 'document', date: '2026-10-30' })]);
  });

  it('writes a fully tagged unit attributed to the pathway', () => {
    const r = render();
    expect(r.unitSlugs).toEqual(['sahayak-for-health-train-ashas-first']);
    const content = file(r, 'units/sahayak-for-health-train-ashas-first.md')!;
    expect(fields(content)).toMatchObject({
      type: 'unit',
      pathway: 'sahayak-for-health',
      unit_type: 'Tactical Decision',
      dimension: 'institution',
      sub_category: 'institution-b',
      stage: 'pilot',
      also_relevant_at: ['scale'],
      applies_when: 'Frontline workers are the users.',
      fails_when: 'Not documented in the source',
    });
    expect(content).toContain("## Unit\n\nAccording to the contributor's pathway");
  });

  it('leaves out a unit whose sub-category is outside its dimension, and says so', () => {
    const r = render({ extracted: { ...EXTRACTED, units: [unit(), unit({ short_name: 'bad', name: 'Bad one', sub_category: 'persona-a' })] } });
    expect(r.unitSlugs).toHaveLength(1);
    expect(r.skipped).toEqual([{ name: 'Bad one', reason: expect.stringMatching(/sub-category/) }]);
    expect(r.prBody).toContain('Left out');
  });

  it('blanks a value outside the vocabularies rather than writing it', () => {
    const r = render({ extracted: { ...EXTRACTED, pathway: { ...EXTRACTED.pathway, sector: 'Healthcare', pathway_kind: 'odd' } } });
    const fm = fields(file(r, 'pathways/sahayak-for-health.md')!);
    expect(fm).not.toHaveProperty('sector');
    expect(fm).not.toHaveProperty('pathway_kind');
  });

  it('suffixes a unit slug already taken, and two units with the same name', () => {
    const r = render({
      takenUnitSlugs: new Set(['sahayak-for-health-train-ashas-first']),
      extracted: { ...EXTRACTED, units: [unit(), unit({ short_name: 'train ashas first!' })] },
    });
    expect(r.unitSlugs).toEqual(['sahayak-for-health-train-ashas-first-2', 'sahayak-for-health-train-ashas-first-3']);
  });

  it('writes a pattern with its evidence, and drops one without evidence', () => {
    const pattern = unit({ short_name: 'pattern-a', name: 'Pattern A', unit_type: 'Problem-Solution Pattern', problem: 'P', solution: 'S', evidence: ['train-ashas-first'] });
    const orphan = unit({ short_name: 'pattern-b', name: 'Pattern B', unit_type: 'Problem-Solution Pattern', problem: 'P', evidence: ['nope'] });
    const r = render({ extracted: { ...EXTRACTED, units: [unit(), pattern, orphan] } });
    expect(r.patternCount).toBe(1);
    expect(fields(file(r, 'units/sahayak-for-health-pattern-a.md')!)).toMatchObject({
      unit_type: 'Problem-Solution Pattern',
      evidence_units: ['sahayak-for-health-train-ashas-first'],
      pathways: ['sahayak-for-health'],
    });
    expect(r.skipped.map((s) => s.name)).toEqual(['Pattern B']);
  });

  it('deletes the pathway\'s replaced units unless a new unit reuses the slug', () => {
    const r = render({
      takenUnitSlugs: new Set(['sahayak-for-health-train-ashas-first', 'sahayak-for-health-old-one']),
      replacedUnitSlugs: ['sahayak-for-health-train-ashas-first', 'sahayak-for-health-old-one'],
    });
    expect(r.unitSlugs).toEqual(['sahayak-for-health-train-ashas-first']);
    expect(r.files.filter((f) => f.content === null).map((f) => f.path)).toEqual(['units/sahayak-for-health-old-one.md']);
  });

  it('adds one activity entry in the brain\'s format', () => {
    const r = render();
    const activity = r.files.find((f) => f.path.startsWith('activities/'))!;
    expect(activity.path).toBe('activities/entries/2026-10/20261030T101112Z-diffusion-cube-app-a1.md');
    expect(activity.content).toBe('- 2026-10-30: [pathway] Sahayak for Health — sent for review from the diffusion-cube app: 1 units, 0 patterns\n');
  });

  it('says in the PR that merging publishes', () => {
    const r = render();
    expect(r.prTitle).toBe('Pathway: Sahayak for Health');
    expect(r.prBody).toMatch(/Merging this pull request publishes the pathway/);
    expect(r.prBody).toContain('Train ASHAs before launch');
  });
});
