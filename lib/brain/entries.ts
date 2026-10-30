import type { ExtractedEntries, ExtractedUnit } from '@/lib/brain/extract';
import { DIMENSIONS, GRID_KEYS, PATHWAY_KINDS, SECTORS, STAGES, SUB_CATEGORIES, UNIT_TYPES } from '@/lib/brain/vocab';

// Renders an extracted pathway (lib/brain/extract.ts) as Cube-Brain files for
// the Send-for-review pull request (docs/features/cube-brain-knowledge-source/,
// CB-13): the verbatim document, the pathway entry, one file per unit, and an
// activity entry. Frontmatter values are written as JSON, which is valid
// YAML, so no YAML library is needed. A value outside the brain's
// vocabularies (lib/brain/vocab.ts) is left blank; a framework unit that
// can't be fully tagged is left out and named in the PR description, so the
// brain's validator can pass and nothing implausible is written.

export interface BrainFile {
  path: string;
  // null deletes the file (a unit the new extraction replaces).
  content: string | null;
}

export interface RenderedEntries {
  files: BrainFile[];
  unitSlugs: string[];
  patternCount: number;
  skipped: { name: string; reason: string }[];
  prTitle: string;
  prBody: string;
}

const FRAMEWORK_TYPES = UNIT_TYPES.filter((t) => t !== 'Problem-Solution Pattern') as string[];
const PATTERN = 'Problem-Solution Pattern';

function kebab(text: string, maxWords = 6): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, ' ')
      .split(/[\s-]+/)
      .filter(Boolean)
      .slice(0, maxWords)
      .join('-') || 'unit'
  );
}

function present(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === 'string') return value.trim() !== '';
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return true;
}

function frontmatter(fields: Record<string, unknown>): string {
  const lines = Object.entries(fields)
    .filter(([, v]) => present(v))
    .map(([k, v]) => `${k}: ${JSON.stringify(v)}`);
  return `---\n${lines.join('\n')}\n---\n`;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : undefined;
}

function docField(document: string, key: string): string | undefined {
  return document.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'))?.[1]?.trim();
}

function coverage(raw: unknown): Record<string, number> | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const out: Record<string, number> = {};
  for (const key of GRID_KEYS) {
    const v = (raw as Record<string, unknown>)[key];
    if (Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 3) out[key] = v as number;
  }
  return Object.keys(out).length ? out : undefined;
}

function coverageTable(cov: Record<string, number> | undefined): string {
  if (!cov) return 'Not documented in the source.';
  const stages = ['Explore', 'Define', 'Pilot', 'Scale'];
  const rows = DIMENSIONS.map((d) => `| ${d} | ${stages.map((s) => cov[`${d}:${s}`] ?? '').join(' | ')} |`);
  return [`| | ${stages.join(' | ')} |`, '|---|---|---|---|---|', ...rows].join('\n');
}

function unitBody(u: ExtractedUnit): string {
  const parts = [`## Unit\n\n${u.unit_text.trim()}`];
  parts.push(`## Condition\n\n- **Applies when:** ${u.applies_when || 'Not documented in the source'}\n- **Fails when:** ${u.fails_when || 'Not documented in the source'}`);
  if (u.before || u.after) parts.push(`## Before → after\n\n${u.before ?? '—'} → ${u.after ?? '—'}`);
  if (u.why_reusable) parts.push(`## Why it is reusable\n\n${u.why_reusable}`);
  return parts.join('\n\n') + '\n';
}

function patternBody(u: ExtractedUnit, evidence: string[]): string {
  const section = (title: string, text?: string) => (text ? `## ${title}\n\n${text}` : '');
  return (
    [
      section('Problem', u.problem),
      section('Root cause', u.root_cause),
      section('Solution', u.solution),
      section('Result', u.result),
      section('Condition', u.condition),
      `## Evidence\n\n${evidence.map((s) => `- [${s}](${s}.md)`).join('\n')}${evidence.length === 1 ? '\n\nOne piece of evidence: a candidate pattern, not yet a pattern.' : ''}`,
    ]
      .filter(Boolean)
      .join('\n\n') + '\n'
  );
}

export function renderBrainEntries(input: {
  slug: string;
  title: string;
  document: string;
  extracted: ExtractedEntries;
  // Every unit slug already in the brain, so new ones never collide.
  takenUnitSlugs: Set<string>;
  // This pathway's own single-pathway units already in the brain, replaced
  // by this submission (deleted unless a new unit takes the same slug).
  replacedUnitSlugs: string[];
  today: string;
  now: Date;
}): RenderedEntries {
  const { slug, title, document, extracted, today } = input;
  const p = extracted.pathway;
  const source = { system: 'diffusion_cube_app', method: 'document', date: today, ref: `Send for review of pathway ${slug} from the diffusion-cube app` };
  const docPath = `documents/${slug}.md`;

  // Slugs first, so patterns can point at their evidence.
  const taken = new Set([...input.takenUnitSlugs].filter((s) => !input.replacedUnitSlugs.includes(s)));
  const slugFor = new Map<string, string>();
  for (const u of extracted.units) {
    const base = `${slug}-${kebab(u.short_name || u.name)}`;
    let candidate = base;
    for (let n = 2; taken.has(candidate); n++) candidate = `${base}-${n}`;
    taken.add(candidate);
    slugFor.set(u.short_name, candidate);
  }

  const files: BrainFile[] = [];
  const unitSlugs: string[] = [];
  const skipped: RenderedEntries['skipped'] = [];
  let patternCount = 0;

  for (const u of extracted.units) {
    const unitSlug = slugFor.get(u.short_name)!;
    const type = oneOf(u.unit_type, UNIT_TYPES);
    const dimension = oneOf(u.dimension, DIMENSIONS);
    const stage = oneOf(u.stage, STAGES);
    const subCategory = dimension && SUB_CATEGORIES[dimension].includes(u.sub_category ?? '') ? u.sub_category : undefined;
    const common = {
      name: u.name,
      type: 'unit',
      schema_version: 2,
      summary: u.summary,
      doc_refs: [docPath],
      sources: [source],
      first_logged: today,
      last_updated: today,
    };

    if (type === PATTERN) {
      const evidence = (u.evidence ?? []).map((e) => slugFor.get(e)).filter((s): s is string => !!s && s !== unitSlug);
      if (!u.problem || !evidence.length) {
        skipped.push({ name: u.name, reason: 'pattern without a problem or evidence' });
        continue;
      }
      files.push({
        path: `units/${unitSlug}.md`,
        content:
          frontmatter({
            ...common,
            unit_type: PATTERN,
            problem: u.problem,
            root_cause: u.root_cause,
            solution: u.solution,
            result: u.result,
            condition: u.condition,
            evidence_units: evidence,
            pathways: [slug],
            adopter_intents: u.adopter_intents,
          }) + '\n' + patternBody(u, evidence),
      });
      unitSlugs.push(unitSlug);
      patternCount++;
      continue;
    }

    if (!type || !FRAMEWORK_TYPES.includes(type) || !dimension || !stage || !subCategory) {
      skipped.push({ name: u.name, reason: 'missing or invalid type, dimension, sub-category or stage' });
      continue;
    }
    files.push({
      path: `units/${unitSlug}.md`,
      content:
        frontmatter({
          ...common,
          pathway: slug,
          unit_type: type,
          dimension,
          sub_category: subCategory,
          stage,
          also_relevant_at: (u.also_relevant_at ?? []).filter((s) => oneOf(s, STAGES) && s !== stage),
          source_unit_id: u.source_unit_id,
          applies_when: u.applies_when || 'Not documented in the source',
          fails_when: u.fails_when || 'Not documented in the source',
          decision: u.decision,
          alternative_considered: u.alternative_considered,
          reason: u.reason,
          context: u.context,
          before: u.before,
          after: u.after,
          failure: u.failure,
          fix: u.fix,
          insight: u.insight,
          steps: u.steps,
          common_failure_mode: u.common_failure_mode,
          purpose: u.purpose,
          reuse_condition: u.reuse_condition,
          adopter_intents: u.adopter_intents,
        }) + '\n' + unitBody(u),
    });
    unitSlugs.push(unitSlug);
  }

  const cov = coverage(p.coverage);
  const pathwayEntry =
    frontmatter({
      name: p.name || title,
      type: 'pathway',
      schema_version: 2,
      summary: p.summary,
      tags: p.tags,
      doc_refs: [docPath],
      sources: [source],
      first_logged: today,
      last_updated: today,
      title: docField(document, 'title') ?? title,
      card_hook: docField(document, 'description'),
      card_location: docField(document, 'location'),
      pathway_kind: oneOf(p.pathway_kind, PATHWAY_KINDS),
      sector: oneOf(p.sector, SECTORS),
      use_case_category: p.use_case_category,
      geography: p.geography,
      population_served: p.population_served,
      stage_reached: oneOf(p.stage_reached, STAGES),
      key_dates: p.key_dates,
      scale_impact: p.scale_impact,
      cost_anchor: p.cost_anchor,
      build_effort: p.build_effort,
      coverage: cov,
      gaps: p.gaps,
      lifecycle: 'published',
      // The date it was sent for review; it goes live when this PR merges.
      published_on: today,
    }) +
    `\n## Identity\n\n${[p.geography && `**Where:** ${p.geography}`, p.population_served && `**Who it serves:** ${p.population_served}`, p.key_dates && `**Key dates:** ${p.key_dates}`]
      .filter(Boolean)
      .join('\n\n') || 'Not documented in the source.'}\n\n## Effort\n\n${[p.build_effort, p.cost_anchor, p.scale_impact].filter(Boolean).join('\n\n') || 'Not documented in the source.'}\n\n## Coverage\n\n${coverageTable(cov)}\n\n## Gaps\n\n${(p.gaps ?? []).map((g) => `- ${g}`).join('\n') || 'None named in the source.'}\n\n## Where the reusable value is\n\n${p.reusable_value || 'Not documented in the source.'}\n\n## Corpus copies\n\n- \`${docPath}\`\n`;

  const kept = new Set(unitSlugs);
  const deletions = input.replacedUnitSlugs.filter((s) => !kept.has(s)).map((s) => ({ path: `units/${s}.md`, content: null }));

  const stamp = input.now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const summaryLine = `${unitSlugs.length - patternCount} units, ${patternCount} patterns`;
  files.unshift(
    { path: docPath, content: document },
    { path: `pathways/${slug}.md`, content: pathwayEntry }
  );
  files.push(...deletions, {
    path: `activities/entries/${today.slice(0, 7)}/${stamp}-diffusion-cube-app-a1.md`,
    content: `- ${today}: [pathway] ${p.name || title} — sent for review from the diffusion-cube app: ${summaryLine}\n`,
  });

  const prBody = [
    `Sent for review from the diffusion-cube app (Send for review). **Merging this pull request publishes the pathway** in the app.`,
    `**Pathway:** ${p.name || title} (\`${slug}\`): ${p.summary ?? ''}`,
    `### Micro-innovations extracted (${summaryLine})`,
    ...extracted.units
      .filter((u) => kept.has(slugFor.get(u.short_name)!))
      .map((u) => `- **${u.name}** (${u.unit_type}${u.dimension ? `, ${u.dimension} · ${u.stage}` : ''}): ${u.summary ?? ''}`),
    skipped.length ? `### Left out (could not be tagged)\n${skipped.map((s) => `- ${s.name}: ${s.reason}`).join('\n')}` : '',
    deletions.length ? `### Replaced\nThis update replaces ${deletions.length} earlier unit(s) of this pathway.` : '',
    'Units were extracted by Claude from the contributor\'s document; review them with the pathway.',
  ]
    .filter(Boolean)
    .join('\n\n');

  return { files, unitSlugs, patternCount, skipped, prTitle: `Pathway: ${p.name || title}`, prBody };
}
