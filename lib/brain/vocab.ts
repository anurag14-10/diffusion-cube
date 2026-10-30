// The Cube-Brain's controlled vocabularies an extracted entry may use, copied
// from the brain's MASTERS.md (sections 1, 2, 3, 4, 9, 10). The brain's
// validator rejects any other value, so lib/brain/entries.ts blanks a value
// that isn't here rather than send a pull request that can't pass. When
// MASTERS.md changes, update this file to match.

export const UNIT_TYPES = [
  'Strategic Decision',
  'Tactical Decision',
  'Failure and Fix',
  'Playbook',
  'Toolkit Asset',
  'Problem-Solution Pattern',
] as const;

export const DIMENSIONS = ['persona', 'solution', 'institution', 'ecosystem'] as const;

export const STAGES = ['explore', 'define', 'pilot', 'scale'] as const;

// `<dimension>-<letter>`; a unit's sub_category must belong to its dimension.
export const SUB_CATEGORIES: Record<(typeof DIMENSIONS)[number], string[]> = {
  persona: ['a', 'b', 'c', 'd'].map((l) => `persona-${l}`),
  solution: ['a', 'b', 'c', 'd', 'e'].map((l) => `solution-${l}`),
  institution: ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((l) => `institution-${l}`),
  ecosystem: ['a', 'b', 'c', 'd', 'e', 'f'].map((l) => `ecosystem-${l}`),
};

export const PATHWAY_KINDS = ['single-deployment', 'cross-deployment-synthesis', 'horizontal-enabler'] as const;

export const SECTORS = [
  'Agriculture',
  'Agriculture / Dairy',
  'Livelihoods',
  'Education',
  'Public Health',
  'Climate',
  'Governance and Public Services',
  'Industry and Investment',
  'Data Infrastructure',
  'Cross-Sector',
] as const;

// The 16 cells a pathway's `coverage` map is keyed by (MASTERS 5), as the
// app's grid spells them.
export const GRID_KEYS = DIMENSIONS.flatMap((d) =>
  STAGES.map((s) => `${d}:${s.charAt(0).toUpperCase()}${s.slice(1)}`)
);
