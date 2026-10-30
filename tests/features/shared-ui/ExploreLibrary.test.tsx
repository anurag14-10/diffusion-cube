// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/supabase/client', () => ({ createClient: vi.fn(() => ({})) }));

import ExploreLibrary from '@/app/explore/ExploreLibrary';
import { libraryPathways, type LibraryPathway } from '@/lib/library-pathways';

const BRAIN_CARD: LibraryPathway = {
  id: 'brain-only',
  title: 'Brain Only Pathway',
  location: 'Somewhere',
  category: 'Community',
  stage: 'Pilot',
  accent: 'blue',
  hook: 'A hook from the brain',
  tags: [],
};

describe('ExploreLibrary card list', () => {
  it('merges the hard-coded cards by default (legacy)', () => {
    render(<ExploreLibrary dbPathways={[BRAIN_CARD]} />);
    expect(screen.getByText('Brain Only Pathway')).toBeInTheDocument();
    expect(screen.getByText(libraryPathways[0].title)).toBeInTheDocument();
  });

  it('shows only the given cards when the brain supplies the whole library', () => {
    render(<ExploreLibrary dbPathways={[BRAIN_CARD]} includeStatic={false} />);
    expect(screen.getByText('Brain Only Pathway')).toBeInTheDocument();
    expect(screen.queryByText(libraryPathways[0].title)).not.toBeInTheDocument();
  });
});
