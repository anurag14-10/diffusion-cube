// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createSupabaseMock } from '../../helpers/supabase-mock';
import { jsonResponse, stubFetch } from '../../helpers/ui-fork-http';

vi.mock('@/lib/toast', () => ({ showToast: vi.fn() }));
vi.mock('@/lib/supabase/client', () => ({ createClient: vi.fn() }));

import { showToast } from '@/lib/toast';
import { createClient } from '@/lib/supabase/client';
import AdminPathwaysPanel, { type AdminPathwayRow } from '@/components/AdminPathwaysPanel';

// The admin console with KNOWLEDGE_SOURCE=brain (CB-16): each review's PR and
// checks, Publish waiting for passed checks, Decline, and Resync.

function pathway(over: Partial<AdminPathwayRow> = {}): AdminPathwayRow {
  return {
    id: 'pw-1',
    slug: 'pathway-1',
    title: 'Pathway 1',
    sector: 'Health',
    created_at: '2026-10-15T08:00:00Z',
    reviewRequested: true,
    isPublished: false,
    toolkitAssets: [],
    brain: { prUrl: 'https://github.com/o/brain/pull/7', validation: 'passed', validationDetail: null },
    ...over,
  };
}

const card = () => screen.getByText('Pathway 1').closest('div.rounded-xl') as HTMLElement;

beforeEach(() => {
  vi.mocked(showToast).mockClear();
  vi.mocked(createClient).mockReturnValue(createSupabaseMock().client);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('AdminPathwaysPanel (brain)', () => {
  it('links the review on GitHub and shows its checks', () => {
    render(<AdminPathwaysPanel brainMode initialRows={[pathway()]} />);
    expect(within(card()).getByRole('link', { name: 'Review on GitHub' })).toHaveAttribute('href', 'https://github.com/o/brain/pull/7');
    expect(within(card()).getByText('Checks passed')).toBeInTheDocument();
    expect(within(card()).getByRole('button', { name: 'Publish' })).toBeEnabled();
  });

  it.each([
    ['pending', 'Checks running'],
    ['failed', 'Checks failed'],
  ] as const)('keeps Publish disabled while checks are %s', (validation, label) => {
    render(
      <AdminPathwaysPanel
        brainMode
        initialRows={[pathway({ brain: { prUrl: 'u', validation, validationDetail: validation === 'failed' ? 'units/x.md: unknown dimension' : null } })]}
      />
    );
    expect(within(card()).getByText(label)).toBeInTheDocument();
    expect(within(card()).getByRole('button', { name: 'Publish' })).toBeDisabled();
    if (validation === 'failed') expect(within(card()).getByText('units/x.md: unknown dimension')).toBeInTheDocument();
  });

  it('shows the reason when the merge is refused', async () => {
    stubFetch(() => jsonResponse({ error: "The brain's checks failed for this pathway.", detail: 'Validate wiki: 1 error' }, 409));
    const user = userEvent.setup();
    render(<AdminPathwaysPanel brainMode initialRows={[pathway()]} />);
    await user.click(within(card()).getByRole('button', { name: 'Publish' }));
    expect(await screen.findByText("The brain's checks failed for this pathway. Validate wiki: 1 error")).toBeInTheDocument();
  });

  it('declines after confirmation, and the row becomes a draft', async () => {
    const { calls } = stubFetch(() => jsonResponse({ ok: true }));
    const user = userEvent.setup();
    render(<AdminPathwaysPanel brainMode initialRows={[pathway()]} />);
    await user.click(within(card()).getByRole('button', { name: 'Decline' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Decline' }));
    await waitFor(() => expect(within(card()).getByText('Draft')).toBeInTheDocument());
    expect(calls).toEqual([{ url: '/api/admin/pathways/decline', method: 'POST', body: { pathway_id: 'pw-1' } }]);
    expect(showToast).toHaveBeenCalledWith('Review declined. The pathway is a draft again.');
  });

  it('cancelling Decline sends nothing', async () => {
    const { fn } = stubFetch(() => jsonResponse({ ok: true }));
    const user = userEvent.setup();
    render(<AdminPathwaysPanel brainMode initialRows={[pathway()]} />);
    await user.click(within(card()).getByRole('button', { name: 'Decline' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }));
    expect(fn).not.toHaveBeenCalled();
  });

  it('Resync from brain calls the resync route and reloads', async () => {
    const reload = vi.fn();
    vi.stubGlobal('location', { ...window.location, reload });
    const { calls } = stubFetch(() => jsonResponse({ ok: true, pathways: 10, reviews: { open: 1, merged: 0, closed: 0 } }));
    const user = userEvent.setup();
    render(<AdminPathwaysPanel brainMode initialRows={[pathway()]} />);
    await user.click(screen.getByRole('button', { name: 'Resync from brain' }));
    await waitFor(() => expect(reload).toHaveBeenCalled());
    expect(calls).toEqual([{ url: '/api/admin/brain/resync', method: 'POST', body: undefined }]);
  });

  it('legacy mode has no Decline, Resync or GitHub link', () => {
    render(<AdminPathwaysPanel initialRows={[pathway({ brain: null })]} />);
    expect(screen.queryByRole('button', { name: 'Decline' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Resync from brain' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Review on GitHub' })).not.toBeInTheDocument();
  });
});
