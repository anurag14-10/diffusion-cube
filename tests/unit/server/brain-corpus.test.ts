import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrainSnapshot } from '@/lib/brain/snapshot';

vi.mock('@/lib/brain/snapshot', () => ({ getBrainSnapshot: vi.fn() }));

import { getBrainSnapshot } from '@/lib/brain/snapshot';
import { isBrainSource, isPublishedSlug, libraryDocument, libraryOverview, pathwayDocument, publishedPathways, unitsFor } from '@/lib/brain/corpus';

const DOC = '# Overview\n\nThe account.\n\n## Source Trace\n\n- interview with a named officer';

const SNAPSHOT: BrainSnapshot = {
  schema_version: 1,
  pathways: [
    { slug: 'mahavistaar', lifecycle: 'published', document: DOC },
    { slug: 'blue-dots', lifecycle: 'published', title: 'Blue Dots', card_hook: 'Jobs findable', sector: 'Livelihoods', stage_reached: 'scale', tags: ['Voice AI'], published_on: '2026-08-01', document: '# Blue Dots' },
    // A build that slipped: the snapshot should never carry these.
    { slug: 'retired-one', lifecycle: 'retired', document: '# Old' },
    { slug: 'no-lifecycle', document: '# ?' },
  ],
  units: [
    { slug: 'mahavistaar-a', pathway: 'mahavistaar', body: 'a' },
    { slug: 'blue-dots-b', pathway: 'blue-dots', body: 'b' },
    { slug: 'pattern-shared', unit_type: 'Problem-Solution Pattern', pathways: ['blue-dots', 'mahavistaar'], body: 'p' },
    { slug: 'retired-one-c', pathway: 'retired-one', body: 'c' },
  ],
  organisations: [],
};

beforeEach(() => {
  vi.mocked(getBrainSnapshot).mockResolvedValue(SNAPSHOT);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('isBrainSource', () => {
  it.each([
    [undefined, false],
    ['legacy', false],
    ['brain', true],
  ])('KNOWLEDGE_SOURCE=%s → %s', (value, expected) => {
    if (value !== undefined) vi.stubEnv('KNOWLEDGE_SOURCE', value);
    expect(isBrainSource()).toBe(expected);
  });
});

describe('publishedPathways', () => {
  it('keeps only published pathways, even if the snapshot carried others', async () => {
    expect((await publishedPathways()).map((p) => p.slug)).toEqual(['mahavistaar', 'blue-dots']);
    expect(await isPublishedSlug('retired-one')).toBe(false);
    expect(await isPublishedSlug('blue-dots')).toBe(true);
  });
});

describe('pathwayDocument', () => {
  it('strips the Source Trace appendix for adopters', async () => {
    const doc = await pathwayDocument('mahavistaar', { forAdopter: true });
    expect(doc).toContain('The account.');
    expect(doc).not.toMatch(/Source Trace|named officer/);
  });

  it('keeps it otherwise', async () => {
    expect(await pathwayDocument('mahavistaar', { forAdopter: false })).toContain('## Source Trace');
  });

  it('returns null for anything not published', async () => {
    expect(await pathwayDocument('retired-one', { forAdopter: true })).toBeNull();
    expect(await pathwayDocument('nope', { forAdopter: true })).toBeNull();
  });
});

describe('unitsFor', () => {
  it('returns units in slug order, a shared pattern once, and nothing for unpublished pathways', async () => {
    const units = await unitsFor(['blue-dots', 'mahavistaar', 'retired-one']);
    expect(units.map((u) => u.slug)).toEqual(['blue-dots-b', 'pattern-shared', 'mahavistaar-a']);
  });
});

describe('libraryDocument', () => {
  it('strips Source Trace and adds the first-published date when the document has no timestamp', async () => {
    expect(await libraryDocument('mahavistaar')).not.toContain('Source Trace');
    expect(await libraryDocument('blue-dots')).toMatch(/^First published: 2026-08-01/);
    expect(await libraryDocument('retired-one')).toBeNull();
  });
});

describe('libraryOverview', () => {
  it('lists every published pathway once, with the hook as its description, and counts them', async () => {
    const { overview, count } = await libraryOverview();
    expect(count).toBe(2);
    expect(overview).toContain('[blue-dots]\ntitle: Blue Dots\ndescription: Jobs findable\nsector: Livelihoods\nstage: scale\ntags: [Voice AI]');
    expect(overview).not.toContain('retired-one');
  });
});
