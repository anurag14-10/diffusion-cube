import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/github', () => ({ brainCommitFiles: vi.fn(), brainOpenOrUpdatePR: vi.fn() }));
vi.mock('@/lib/brain/snapshot', () => ({ getBrainSnapshot: vi.fn() }));
vi.mock('@/lib/brain/extract', () => ({ extractBrainEntries: vi.fn() }));

import { brainCommitFiles, brainOpenOrUpdatePR } from '@/lib/github';
import { getBrainSnapshot } from '@/lib/brain/snapshot';
import { extractBrainEntries } from '@/lib/brain/extract';
import { submitPathwayToBrain } from '@/lib/brain/submit';

// Send for review → brain pull request (CB-14).

beforeEach(() => {
  vi.mocked(getBrainSnapshot).mockResolvedValue({
    schema_version: 1,
    pathways: [],
    units: [
      { slug: 'sahayak-old-unit', pathway: 'sahayak', body: '' },
      { slug: 'shared-pattern', pathways: ['sahayak', 'blue-dots'], unit_type: 'Problem-Solution Pattern', body: '' },
      { slug: 'other-unit', pathway: 'blue-dots', body: '' },
    ],
    organisations: [],
  });
  vi.mocked(extractBrainEntries).mockResolvedValue({
    pathway: { name: 'Sahayak', summary: 's', sector: 'Public Health', stage_reached: 'pilot' },
    units: [
      {
        short_name: 'new-unit',
        name: 'New unit',
        unit_type: 'Tactical Decision',
        dimension: 'solution',
        sub_category: 'solution-a',
        stage: 'pilot',
        decision: 'd',
        before: 'b',
        after: 'a',
        unit_text: 't',
      },
    ],
  });
  vi.mocked(brainCommitFiles).mockResolvedValue('commit-1');
  vi.mocked(brainOpenOrUpdatePR).mockResolvedValue({ number: 9, url: 'u9' });
});

describe('submitPathwayToBrain', () => {
  it('commits every file on pathway/<slug> rebuilt from base, then opens or updates its PR', async () => {
    const result = await submitPathwayToBrain({ slug: 'sahayak', title: 'Sahayak', document: '# Doc' });
    expect(result).toEqual({ number: 9, url: 'u9', unitCount: 1, patternCount: 0 });

    const [branch, files, message, options] = vi.mocked(brainCommitFiles).mock.calls[0];
    expect(branch).toBe('pathway/sahayak');
    expect(options).toEqual({ fromBase: true });
    expect(message).toBe('cube-brain: pathway sahayak sent for review (1 units, 0 patterns)');
    const paths = files.map((f) => f.path);
    expect(paths).toEqual(expect.arrayContaining(['documents/sahayak.md', 'pathways/sahayak.md', 'units/sahayak-new-unit.md']));
    // The pathway's own earlier unit is replaced; a shared pattern and other pathways' units are not.
    expect(files.filter((f) => f.content === null).map((f) => f.path)).toEqual(['units/sahayak-old-unit.md']);

    expect(vi.mocked(brainOpenOrUpdatePR).mock.calls[0][0]).toBe('pathway/sahayak');
  });

  it('commits nothing when extraction fails', async () => {
    vi.mocked(extractBrainEntries).mockRejectedValue(new Error('no units'));
    await expect(submitPathwayToBrain({ slug: 'sahayak', title: 'S', document: '#' })).rejects.toThrow('no units');
    expect(brainCommitFiles).not.toHaveBeenCalled();
    expect(brainOpenOrUpdatePR).not.toHaveBeenCalled();
  });
});
