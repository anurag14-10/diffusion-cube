// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createSupabaseMock } from '../../helpers/supabase-mock';
import { deferred, jsonResponse, stubFetch } from '../../helpers/ui-fork-http';

vi.mock('@/lib/toast', () => ({ showToast: vi.fn() }));
vi.mock('@/lib/supabase/client', () => ({ createClient: vi.fn() }));

import { showToast } from '@/lib/toast';
import { createClient } from '@/lib/supabase/client';
import AdminPathwaysPanel, { type AdminPathwayRow } from '@/components/AdminPathwaysPanel';

function pathway(i: number, over: Partial<AdminPathwayRow> = {}): AdminPathwayRow {
  return {
    id: `pw-${i}`,
    slug: `pathway-${i}`,
    title: `Pathway ${i}`,
    sector: 'Agriculture',
    created_at: '2026-09-15T08:00:00Z',
    reviewRequested: false,
    isPublished: false,
    toolkitAssets: [],
    ...over,
  };
}

function card(title: string) {
  return screen.getByText(title).closest('div.rounded-xl') as HTMLElement;
}

beforeEach(() => {
  vi.mocked(showToast).mockClear();
  vi.mocked(createClient).mockReturnValue(createSupabaseMock().client);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('AdminPathwaysPanel', () => {
  it('shows the empty state with no pathways', () => {
    render(<AdminPathwaysPanel initialRows={[]} />);
    expect(screen.getByText('No pathways yet.')).toBeInTheDocument();
  });

  it('only rows awaiting review get a Publish button', () => {
    render(
      <AdminPathwaysPanel
        initialRows={[
          pathway(1, { reviewRequested: true }),
          pathway(2, { isPublished: true }),
          pathway(3),
        ]}
      />
    );
    expect(within(card('Pathway 1')).getByText('Awaiting Review')).toBeInTheDocument();
    expect(within(card('Pathway 1')).getByRole('button', { name: 'Publish' })).toBeInTheDocument();
    expect(within(card('Pathway 2')).getByText('Published')).toBeInTheDocument();
    expect(within(card('Pathway 2')).queryByRole('button', { name: 'Publish' })).not.toBeInTheDocument();
    expect(within(card('Pathway 3')).queryByRole('button', { name: 'Publish' })).not.toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Delete' })).toHaveLength(3);
  });

  it('publishing POSTs the id, marks it Published and toasts success', async () => {
    const { calls } = stubFetch(() => jsonResponse({ ok: true, assetsPublished: true }));
    const user = userEvent.setup();
    render(<AdminPathwaysPanel initialRows={[pathway(1, { reviewRequested: true })]} />);
    await user.click(screen.getByRole('button', { name: 'Publish' }));
    await waitFor(() => expect(within(card('Pathway 1')).getByText('Published')).toBeInTheDocument());
    expect(calls).toEqual([{ url: '/api/admin/pathways/publish', method: 'POST', body: { pathway_id: 'pw-1' } }]);
    expect(screen.queryByText('Awaiting Review')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Publish' })).not.toBeInTheDocument();
    expect(showToast).toHaveBeenCalledWith('Pathway published successfully.');
  });

  it('warns with an error toast when toolkit assets failed to publish', async () => {
    stubFetch(() => jsonResponse({ ok: true, assetsPublished: false }));
    const user = userEvent.setup();
    render(<AdminPathwaysPanel initialRows={[pathway(1, { reviewRequested: true })]} />);
    await user.click(screen.getByRole('button', { name: 'Publish' }));
    await waitFor(() =>
      expect(showToast).toHaveBeenCalledWith(
        'Pathway published, but its toolkit assets could not be published. Publish again to retry.',
        'error'
      )
    );
    expect(within(card('Pathway 1')).getByText('Published')).toBeInTheDocument();
  });

  it('shows the server error when publishing fails and keeps the row awaiting', async () => {
    stubFetch(() => jsonResponse({ error: 'GitHub commit failed' }, 502));
    const user = userEvent.setup();
    render(<AdminPathwaysPanel initialRows={[pathway(1, { reviewRequested: true })]} />);
    await user.click(screen.getByRole('button', { name: 'Publish' }));
    expect(await screen.findByText('GitHub commit failed')).toBeInTheDocument();
    expect(screen.getByText('Awaiting Review')).toBeInTheDocument();
    expect(showToast).not.toHaveBeenCalled();
  });

  it('labels a row that is neither awaiting nor published as Draft', () => {
    render(<AdminPathwaysPanel initialRows={[pathway(1)]} />);
    expect(within(card('Pathway 1')).getByText('Draft')).toBeInTheDocument();
  });

  it('status filter shows per-status counts and narrows the list', async () => {
    const user = userEvent.setup();
    render(
      <AdminPathwaysPanel
        initialRows={[
          pathway(1, { reviewRequested: true }),
          pathway(2, { isPublished: true }),
          pathway(3, { isPublished: true }),
          pathway(4),
        ]}
      />
    );
    const filterButton = (name: RegExp) => screen.getByRole('button', { name });
    expect(filterButton(/^All \(4\)$/)).toHaveAttribute('aria-pressed', 'true');
    expect(filterButton(/^Awaiting review \(1\)$/)).toBeInTheDocument();
    expect(filterButton(/^Published \(2\)$/)).toBeInTheDocument();
    expect(filterButton(/^Draft \(1\)$/)).toBeInTheDocument();

    await user.click(filterButton(/^Published/));
    expect(filterButton(/^Published/)).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('Pathway 2')).toBeInTheDocument();
    expect(screen.getByText('Pathway 3')).toBeInTheDocument();
    expect(screen.queryByText('Pathway 1')).not.toBeInTheDocument();
    expect(screen.queryByText('Pathway 4')).not.toBeInTheDocument();

    await user.click(filterButton(/^Draft/));
    expect(screen.getByText('Pathway 4')).toBeInTheDocument();
    expect(screen.queryByText('Pathway 2')).not.toBeInTheDocument();
  });

  it('shows an empty message when no pathway matches the filter', async () => {
    const user = userEvent.setup();
    render(<AdminPathwaysPanel initialRows={[pathway(1)]} />);
    await user.click(screen.getByRole('button', { name: /^Published/ }));
    expect(screen.getByText('No published pathways.')).toBeInTheDocument();
  });

  it('a published row moves out of the Awaiting review filter', async () => {
    stubFetch(() => jsonResponse({ ok: true, assetsPublished: true }));
    const user = userEvent.setup();
    render(<AdminPathwaysPanel initialRows={[pathway(1, { reviewRequested: true }), pathway(2)]} />);
    await user.click(screen.getByRole('button', { name: /^Awaiting review/ }));
    await user.click(screen.getByRole('button', { name: 'Publish' }));
    expect(await screen.findByText('No awaiting review pathways.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Published \(1\)$/ })).toBeInTheDocument();
  });

  it('falls back to a generic publish error for a non-JSON failure', async () => {
    stubFetch(() => new Response('oops', { status: 500 }));
    const user = userEvent.setup();
    render(<AdminPathwaysPanel initialRows={[pathway(1, { reviewRequested: true })]} />);
    await user.click(screen.getByRole('button', { name: 'Publish' }));
    expect(await screen.findByText('Could not publish pathway.')).toBeInTheDocument();
  });

  it('disables Publish and Delete while publishing', async () => {
    const gate = deferred<Response>();
    const { fn } = stubFetch(() => gate.promise);
    const user = userEvent.setup();
    render(<AdminPathwaysPanel initialRows={[pathway(1, { reviewRequested: true })]} />);
    await user.click(screen.getByRole('button', { name: 'Publish' }));
    const publishing = screen.getByRole('button', { name: 'Publishing…' });
    expect(publishing).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Delete' })).toBeDisabled();
    await user.click(publishing);
    expect(fn).toHaveBeenCalledTimes(1);
    gate.resolve(jsonResponse({ ok: true }));
    await waitFor(() => expect(within(card('Pathway 1')).getByText('Published')).toBeInTheDocument());
  });

  it('delete asks for confirmation first; cancelling sends nothing', async () => {
    const { fn } = stubFetch(() => jsonResponse({ ok: true }));
    const user = userEvent.setup();
    render(<AdminPathwaysPanel initialRows={[pathway(1)]} />);
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    const dialog = screen.getByRole('dialog', { name: 'Delete "Pathway 1"?' });
    expect(within(dialog).getByText(/unpublishes it from the Explore library and Analyse corpus/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(fn).not.toHaveBeenCalled();
    expect(screen.getByText('Pathway 1')).toBeInTheDocument();
  });

  it('confirming delete POSTs, removes the row and toasts', async () => {
    const { calls } = stubFetch(() => jsonResponse({ ok: true }));
    const user = userEvent.setup();
    render(<AdminPathwaysPanel initialRows={[pathway(1), pathway(2)]} />);
    await user.click(within(card('Pathway 1')).getByRole('button', { name: 'Delete' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete pathway' }));
    await waitFor(() => expect(screen.queryByText('Pathway 1')).not.toBeInTheDocument());
    expect(calls).toEqual([{ url: '/api/admin/pathways/delete', method: 'POST', body: { pathway_id: 'pw-1' } }]);
    expect(screen.getByText('Pathway 2')).toBeInTheDocument();
    expect(showToast).toHaveBeenCalledWith('Pathway deleted successfully.');
  });

  it('deleting the last pathway shows the empty state', async () => {
    stubFetch(() => jsonResponse({ ok: true }));
    const user = userEvent.setup();
    render(<AdminPathwaysPanel initialRows={[pathway(1)]} />);
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    await user.click(screen.getByRole('button', { name: 'Delete pathway' }));
    expect(await screen.findByText('No pathways yet.')).toBeInTheDocument();
  });

  it('shows a connection error when publishing cannot reach the server', async () => {
    stubFetch(() => {
      throw new TypeError('Failed to fetch');
    });
    const user = userEvent.setup();
    render(<AdminPathwaysPanel initialRows={[pathway(1, { reviewRequested: true })]} />);
    await user.click(screen.getByRole('button', { name: 'Publish' }));
    expect(await screen.findByText('Could not publish pathway. Check your connection and try again.')).toBeInTheDocument();
    expect(screen.getByText('Awaiting Review')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Publish' })).toBeEnabled();
  });

  it('shows a connection error and keeps the row when delete cannot reach the server', async () => {
    stubFetch(() => {
      throw new TypeError('Failed to fetch');
    });
    const user = userEvent.setup();
    render(<AdminPathwaysPanel initialRows={[pathway(1)]} />);
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    await user.click(screen.getByRole('button', { name: 'Delete pathway' }));
    expect(await screen.findByText('Could not delete pathway. Check your connection and try again.')).toBeInTheDocument();
    expect(screen.getByText('Pathway 1')).toBeInTheDocument();
  });

  it('shows an error and keeps the row when delete fails', async () => {
    stubFetch(() => jsonResponse({ error: 'Not allowed' }, 403));
    const user = userEvent.setup();
    render(<AdminPathwaysPanel initialRows={[pathway(1)]} />);
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    await user.click(screen.getByRole('button', { name: 'Delete pathway' }));
    expect(await screen.findByText('Not allowed')).toBeInTheDocument();
    expect(screen.getByText('Pathway 1')).toBeInTheDocument();
    expect(showToast).not.toHaveBeenCalled();
  });

  it('falls back to a generic delete error', async () => {
    stubFetch(() => new Response('', { status: 500 }));
    const user = userEvent.setup();
    render(<AdminPathwaysPanel initialRows={[pathway(1)]} />);
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    await user.click(screen.getByRole('button', { name: 'Delete pathway' }));
    expect(await screen.findByText('Could not delete pathway.')).toBeInTheDocument();
  });

  it('shows "Deleting…" on a non-awaiting row while the delete is in flight', async () => {
    const gate = deferred<Response>();
    stubFetch(() => gate.promise);
    const user = userEvent.setup();
    render(<AdminPathwaysPanel initialRows={[pathway(1)]} />);
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    await user.click(screen.getByRole('button', { name: 'Delete pathway' }));
    expect(await screen.findByRole('button', { name: 'Deleting…' })).toBeDisabled();
    gate.resolve(jsonResponse({ ok: true }));
    await waitFor(() => expect(screen.queryByText('Pathway 1')).not.toBeInTheDocument());
  });

  it('a deletion that empties the last page moves back a page', async () => {
    stubFetch(() => jsonResponse({ ok: true }));
    const rows = Array.from({ length: 11 }, (_, i) => pathway(i + 1));
    const user = userEvent.setup();
    render(<AdminPathwaysPanel initialRows={rows} />);
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByText('Showing 11–11 of 11')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    await user.click(screen.getByRole('button', { name: 'Delete pathway' }));
    await waitFor(() => expect(screen.getByText('Showing 1–10 of 10')).toBeInTheDocument());
    expect(screen.getByText('Pathway 1')).toBeInTheDocument();
  });
});
