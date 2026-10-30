import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSupabaseMock, type SupabaseMock } from '../../helpers/supabase-mock';
import type { BrainSnapshot } from '@/lib/brain/snapshot';

vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }));
vi.mock('@/lib/brain/snapshot', () => ({ getBrainSnapshot: vi.fn() }));

import { createClient } from '@/lib/supabase/server';
import { getBrainSnapshot } from '@/lib/brain/snapshot';
import { getWikiPathway, getWikiStats, listWikiPathways } from '@/lib/wiki-content';
import { libraryCards } from '@/lib/brain/corpus';

// KNOWLEDGE_SOURCE=brain: /wiki, /api/wiki-pathways, /api/wiki-stats and the
// /explore cards read published brain pathways only.

const MAHA = `---
title: MahaVISTAAR
stage: Scale
timestamp: 2026-08-31
contributor: Department of Agriculture
---

# Overview

The account.

## Source Trace

- PROVENANCE-LINE`;

const SNAPSHOT: BrainSnapshot = {
  schema_version: 1,
  pathways: [
    {
      slug: 'mahavistaar',
      lifecycle: 'published',
      title: 'MahaVISTAAR',
      card_title: 'Voice AI for Farmer Advisory — Maharashtra',
      card_location: 'Maharashtra, India',
      card_hook: '342,000 farmers dial one number',
      summary: 'Long summary',
      sector: 'Agriculture',
      stage_reached: 'scale',
      tags: ['Voice AI', 'Agriculture', 'Government'],
      document: MAHA,
    },
    { slug: 'synthesis', lifecycle: 'published', title: 'Synthesis', sector: 'Cross-Sector', summary: 'Many', document: '# S' },
    { slug: 'draft-one', lifecycle: 'unindexed', title: 'Draft', sector: 'Health', document: '# D' },
  ],
  units: [],
  organisations: [],
};

let session: SupabaseMock;

beforeEach(() => {
  vi.stubEnv('KNOWLEDGE_SOURCE', 'brain');
  vi.mocked(getBrainSnapshot).mockResolvedValue(SNAPSHOT);
  session = createSupabaseMock();
  vi.mocked(createClient).mockResolvedValue(session.client);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('listWikiPathways (brain)', () => {
  it('lists published brain pathways only, never touching published_pathways', async () => {
    const list = await listWikiPathways();
    expect(list.map((p) => p.slug)).toEqual(['mahavistaar', 'synthesis']);
    expect(list[0]).toMatchObject({
      title: 'MahaVISTAAR',
      description: '342,000 farmers dial one number',
      sector: 'Agriculture',
      stage: 'Scale',
      timestamp: '2026-08-31',
      contributor: 'Department of Agriculture',
    });
    expect(session.ops('published_pathways')).toHaveLength(0);
  });

  it('counts real sectors only for the stats line', async () => {
    expect(await getWikiStats()).toEqual({ total: 2, sectors: ['Agriculture'] });
  });
});

describe('getWikiPathway (brain)', () => {
  it('shows the document without frontmatter or Source Trace', async () => {
    const page = await getWikiPathway('mahavistaar');
    expect(page?.title).toBe('MahaVISTAAR');
    expect(page?.content).toContain('The account.');
    expect(page?.content).not.toMatch(/Source Trace|PROVENANCE|timestamp:/);
  });

  it.each(['draft-one', 'nope', '../../etc'])('returns null for %s', async (slug) => {
    expect(await getWikiPathway(slug)).toBeNull();
  });
});

describe('libraryCards', () => {
  it('builds each card from its card fields', async () => {
    const [maha] = await libraryCards();
    expect(maha).toEqual({
      id: 'mahavistaar',
      title: 'Voice AI for Farmer Advisory — Maharashtra',
      location: 'Maharashtra, India',
      category: 'Voice AI · Agriculture',
      stage: 'Scale',
      accent: expect.stringMatching(/^(coral|yellow|blue|navy)$/),
      hook: '342,000 farmers dial one number',
      sector: 'Agriculture',
      tags: ['Voice AI', 'Agriculture', 'Government'],
    });
  });

  it('falls back to title, summary, Community and Explore when card fields are missing', async () => {
    const cards = await libraryCards();
    expect(cards.map((c) => c.id)).toEqual(['mahavistaar', 'synthesis']);
    expect(cards[1]).toMatchObject({ title: 'Synthesis', hook: 'Many', location: '', category: 'Community', stage: 'Explore' });
  });

  it('gives a slug the same accent every time', async () => {
    const [a] = await libraryCards();
    const [b] = await libraryCards();
    expect(a.accent).toBe(b.accent);
  });
});
