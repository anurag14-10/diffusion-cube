// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { sessionMock } from '../../helpers/routes-auth';
import { createSupabaseMock, type MockResponse, type SupabaseMock } from '../../helpers/supabase-mock';
import { RedirectError, requestState, stubProps } from '../../helpers/pages-server-mocks';
import type { AdminUserRow } from '@/components/AdminDashboard';
import type { AdminPathwayRow } from '@/components/AdminPathwaysPanel';
import type { AdminContributorRegistrationRow } from '@/components/AdminContributorRegistrationsPanel';

vi.mock('next/navigation', async () => (await import('../../helpers/pages-server-mocks')).navigationModule());
vi.mock('next/headers', async () => (await import('../../helpers/pages-server-mocks')).headersModule());
vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: vi.fn() }));
// Only reached with KNOWLEDGE_SOURCE=brain.
vi.mock('@/lib/brain/snapshot', () => ({ getBrainSnapshot: vi.fn() }));
vi.mock('@/components/AdminDashboard', async () => ({
  default: (await import('../../helpers/pages-server-mocks')).propsStub('AdminDashboard'),
}));
vi.mock('@/components/AdminPathwaysPanel', async () => ({
  default: (await import('../../helpers/pages-server-mocks')).propsStub('AdminPathwaysPanel'),
}));
vi.mock('@/components/AdminContributorRegistrationsPanel', async () => ({
  default: (await import('../../helpers/pages-server-mocks')).propsStub('AdminContributorRegistrationsPanel'),
}));

import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import AdminPage from '@/app/admin/page';

let session: SupabaseMock;
let admin: SupabaseMock;

function as(user: { id: string; email?: string } | null, roles: string[]) {
  session = sessionMock(user, roles);
  vi.mocked(createClient).mockResolvedValue(session.client);
}

const USERS = [
  // Listed first despite holding fewer roles: the page keeps listUsers' order.
  { id: 'u2', email: 'plain@example.com', user_metadata: { name: 'Plain Person', organization: 'Org B' } },
  { id: 'u1', email: 'boss@example.com', user_metadata: { name: 'Boss', organization: 'Org A' } },
  { id: 'u3', email: 'contrib@example.com', user_metadata: {} },
  { id: 'u4', email: undefined, user_metadata: undefined },
];

const ROLE_ROWS = [
  { user_id: 'u1', role: 'adopter' },
  { user_id: 'u1', role: 'pathway_contributor' },
  { user_id: 'u1', role: 'admin' },
  { user_id: 'u2', role: 'adopter' },
  { user_id: 'u3', role: 'pathway_contributor' },
  { user_id: 'ghost', role: 'admin' }, // role row for a user listUsers didn't return
];

const PATHWAYS = [
  { id: 'p1', slug: 'live-one', title: 'Live One', sector: 'Health', created_at: '2026-10-02T00:00:00Z', review_requested: true },
  { id: 'p2', slug: 'draft-two', title: 'Draft Two', sector: null, created_at: '2026-10-01T00:00:00Z', review_requested: null },
];

const REGISTRATIONS = [
  {
    id: 'r1',
    poc_name: 'Asha',
    poc_email: 'asha@example.com',
    organisation_name: 'Org A',
    pathway_role: 'Lead',
    pathway_description: 'Voice bot',
    access_status: 'pending',
    created_at: '2026-10-03T00:00:00Z',
  },
  {
    id: 'r2',
    poc_name: null,
    poc_email: null,
    organisation_name: null,
    pathway_role: null,
    pathway_description: null,
    access_status: 'rejected',
    created_at: '2026-10-01T00:00:00Z',
  },
];

const ASSETS = [
  {
    unit_internal_id: 'asset-a',
    pathway_id: 'p1',
    asset_name: 'Playbook',
    purpose: 'How to run it',
    asset_kind: 'file',
    file_name: 'playbook.pdf',
    size_bytes: 2048,
    link_url: null,
    published_at: '2026-10-05T00:00:00Z',
  },
  {
    unit_internal_id: 'asset-b',
    pathway_id: 'p1',
    asset_name: 'Dashboard',
    purpose: null,
    asset_kind: 'link',
    file_name: null,
    size_bytes: null,
    link_url: 'https://www.example.org/dash',
    published_at: null,
  },
  {
    unit_internal_id: 'asset-c',
    pathway_id: 'p2',
    asset_name: 'Broken link',
    purpose: 'x',
    asset_kind: 'link',
    file_name: null,
    size_bytes: null,
    link_url: 'not a url',
    published_at: null,
  },
  {
    unit_internal_id: 'asset-orphan',
    pathway_id: 'p-missing',
    asset_name: 'Orphan',
    purpose: 'x',
    asset_kind: 'file',
    file_name: 'o.txt',
    size_bytes: 1,
    link_url: null,
    published_at: null,
  },
];

function adminData(
  overrides: Partial<Record<'user_roles' | 'published_pathways' | 'pathways' | 'contributor_registrations' | 'contribution_units', MockResponse>> = {},
  users: unknown = { data: { users: USERS }, error: null }
) {
  admin = createSupabaseMock({
    tables: {
      user_roles: { data: ROLE_ROWS },
      published_pathways: { data: [{ slug: 'live-one' }, { slug: 'not-in-pathways' }] },
      pathways: { data: PATHWAYS },
      contributor_registrations: { data: REGISTRATIONS },
      contribution_units: { data: ASSETS },
      ...overrides,
    },
  });
  admin.auth.admin.listUsers.mockResolvedValue(users as never);
  vi.mocked(createAdminClient).mockReturnValue(admin.client);
}

beforeEach(() => {
  requestState.email = null;
  adminData();
});

async function renderAdmin() {
  return render(await AdminPage());
}

const users = () => stubProps<{ initialRows: AdminUserRow[] }>(screen.getByTestId('AdminDashboard')).initialRows;
const pathways = () => stubProps<{ initialRows: AdminPathwayRow[] }>(screen.getByTestId('AdminPathwaysPanel')).initialRows;
const registrations = () =>
  stubProps<{ initialRows: AdminContributorRegistrationRow[] }>(screen.getByTestId('AdminContributorRegistrationsPanel'))
    .initialRows;

describe('app/admin/page.tsx — access', () => {
  it('redirects an anonymous visitor to / without touching the admin client', async () => {
    as(null, []);
    await expect(AdminPage()).rejects.toEqual(new RedirectError('/'));
    expect(createAdminClient).not.toHaveBeenCalled();
  });

  it.each([
    ['adopter', ['adopter']],
    ['pathway_contributor', ['adopter', 'pathway_contributor']],
    ['zero roles', []],
  ])('redirects a signed-in non-admin (%s) to /', async (_label, roles) => {
    as({ id: 'me', email: 'someone@example.com' }, roles);
    await expect(AdminPage()).rejects.toThrow('REDIRECT:/');
    expect(createAdminClient).not.toHaveBeenCalled();
  });

  it('judges ADMIN_EMAILS by the session user, not a forwarded header', async () => {
    requestState.email = 'env-admin@example.com';
    as({ id: 'me', email: 'someone@example.com' }, ['adopter']);
    await expect(AdminPage()).rejects.toThrow('REDIRECT:/');
  });

  it('lets an ADMIN_EMAILS address in with no admin role row', async () => {
    as({ id: 'me', email: 'env-admin@example.com' }, ['adopter']);
    await renderAdmin();
    expect(screen.getByRole('heading', { level: 1, name: 'Admin' })).toBeInTheDocument();
  });

  it('lets a user holding the admin role in', async () => {
    as({ id: 'me', email: 'someone@example.com' }, ['adopter', 'admin']);
    await renderAdmin();
    expect(screen.getByTestId('AdminDashboard')).toBeInTheDocument();
  });
});

describe('app/admin/page.tsx — content', () => {
  beforeEach(() => as({ id: 'me', email: 'env-admin@example.com' }, ['adopter']));

  it('says every account is an Adopter and links to Usage and Recent errors', async () => {
    await renderAdmin();
    expect(screen.getByText(/Every account is an Adopter from signup\./)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Usage' })).toHaveAttribute('href', '/admin/usage');
    expect(screen.getByRole('link', { name: 'Recent errors' })).toHaveAttribute('href', '/admin/errors');
    expect(screen.getByRole('link', { name: '← Back' })).toHaveAttribute('href', '/');
    expect(screen.getByRole('heading', { level: 2, name: 'Contributor Registrations' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: 'Pathways' })).toBeInTheDocument();
  });

  it('passes every listed user, in listUsers order, with their own roles', async () => {
    await renderAdmin();
    expect(users()).toEqual([
      { id: 'u2', email: 'plain@example.com', name: 'Plain Person', organization: 'Org B', roles: ['adopter'] },
      { id: 'u1', email: 'boss@example.com', name: 'Boss', organization: 'Org A', roles: ['adopter', 'pathway_contributor', 'admin'] },
      { id: 'u3', email: 'contrib@example.com', name: '', organization: '', roles: ['pathway_contributor'] },
      { id: 'u4', email: '', name: '', organization: '', roles: [] },
    ]);
    expect(admin.auth.admin.listUsers).toHaveBeenCalledWith({ page: 1, perPage: 1000 });
    expect(admin.ops('user_roles')[0].columns).toBe('user_id, role');
  });

  it('maps pathways with publish state, defaults and their toolkit assets', async () => {
    await renderAdmin();
    expect(pathways()).toEqual([
      {
        id: 'p1',
        slug: 'live-one',
        title: 'Live One',
        sector: 'Health',
        created_at: '2026-10-02T00:00:00Z',
        reviewRequested: true,
        isPublished: true,
        toolkitAssets: [
          {
            id: 'asset-a',
            name: 'Playbook',
            purpose: 'How to run it',
            kind: 'file',
            fileName: 'playbook.pdf',
            sizeBytes: 2048,
            linkDomain: null,
            published: true,
          },
          {
            id: 'asset-b',
            name: 'Dashboard',
            purpose: '',
            kind: 'link',
            fileName: null,
            sizeBytes: null,
            linkDomain: 'example.org',
            published: false,
          },
        ],
      },
      {
        id: 'p2',
        slug: 'draft-two',
        title: 'Draft Two',
        sector: '',
        created_at: '2026-10-01T00:00:00Z',
        reviewRequested: false,
        isPublished: false,
        toolkitAssets: [
          {
            id: 'asset-c',
            name: 'Broken link',
            purpose: 'x',
            kind: 'link',
            fileName: null,
            sizeBytes: null,
            linkDomain: null,
            published: false,
          },
        ],
      },
    ]);
  });

  it('queries pathways newest first and only toolkit-asset units, oldest first', async () => {
    await renderAdmin();
    expect(admin.ops('pathways')[0].filters).toEqual([['order', 'created_at', { ascending: false }]]);
    expect(admin.ops('contribution_units')[0].filters).toEqual([
      ['eq', 'unit_type', 'toolkit-asset'],
      ['order', 'created_at', { ascending: true }],
    ]);
    expect(admin.ops('contributor_registrations')[0].filters).toEqual([['order', 'created_at', { ascending: false }]]);
  });

  it('maps contributor registrations with null text fields as empty strings', async () => {
    await renderAdmin();
    expect(registrations()).toEqual([
      {
        id: 'r1',
        pocName: 'Asha',
        pocEmail: 'asha@example.com',
        organisationName: 'Org A',
        pathwayRole: 'Lead',
        pathwayDescription: 'Voice bot',
        accessStatus: 'pending',
        createdAt: '2026-10-03T00:00:00Z',
      },
      {
        id: 'r2',
        pocName: '',
        pocEmail: '',
        organisationName: '',
        pathwayRole: '',
        pathwayDescription: '',
        accessStatus: 'rejected',
        createdAt: '2026-10-01T00:00:00Z',
      },
    ]);
  });

  it('is read-only — makes no writes with either client', async () => {
    await renderAdmin();
    expect(admin.queryOps.every((o) => o.action === 'select')).toBe(true);
    expect(session.queryOps.every((o) => o.action === 'select')).toBe(true);
  });

  it('renders empty panels when there is no data at all', async () => {
    adminData(
      {
        user_roles: { data: [] },
        published_pathways: { data: [] },
        pathways: { data: [] },
        contributor_registrations: { data: [] },
        contribution_units: { data: [] },
      },
      { data: { users: [] }, error: null }
    );
    await renderAdmin();
    expect(users()).toEqual([]);
    expect(pathways()).toEqual([]);
    expect(registrations()).toEqual([]);
  });

  it('a user with no user_roles rows at all still appears, with roles []', async () => {
    adminData({ user_roles: { data: [] } });
    await renderAdmin();
    expect(users().map((u) => [u.id, u.roles])).toEqual([
      ['u2', []],
      ['u1', []],
      ['u3', []],
      ['u4', []],
    ]);
  });

  it('still renders (empty lists) when every Supabase read errors', async () => {
    const err = { error: { message: 'db down' } };
    adminData(
      {
        user_roles: err,
        published_pathways: err,
        pathways: err,
        contributor_registrations: err,
        contribution_units: err,
      },
      { data: null, error: { message: 'auth admin down' } }
    );
    await renderAdmin();
    expect(users()).toEqual([]);
    expect(pathways()).toEqual([]);
    expect(registrations()).toEqual([]);
  });

  it('a failed user_roles read shows users with no roles; a failed published_pathways read marks nothing published', async () => {
    adminData({ user_roles: { error: { message: 'x' } }, published_pathways: { error: { message: 'x' } } });
    await renderAdmin();
    expect(users().every((u) => u.roles.length === 0)).toBe(true);
    expect(pathways().map((p) => p.isPublished)).toEqual([false, false]);
  });

  it('a failed toolkit-asset read leaves every pathway with no assets', async () => {
    adminData({ contribution_units: { error: { message: 'x' } } });
    await renderAdmin();
    expect(pathways().map((p) => p.toolkitAssets)).toEqual([[], []]);
  });
});

describe('app/admin/page.tsx — KNOWLEDGE_SOURCE=brain', () => {
  beforeEach(async () => {
    vi.stubEnv('KNOWLEDGE_SOURCE', 'brain');
    const { getBrainSnapshot } = await import('@/lib/brain/snapshot');
    vi.mocked(getBrainSnapshot).mockResolvedValue({
      schema_version: 1,
      pathways: [{ slug: 'draft-two', lifecycle: 'published', document: '#' }],
      units: [],
      organisations: [],
    });
    as({ id: 'me', email: 'env-admin@example.com' }, ['adopter']);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('marks Published from the brain and merged PRs, not published_pathways', async () => {
    adminData({
      pathways: {
        data: [
          { ...PATHWAYS[0], brain_pr_state: 'merged' },
          { ...PATHWAYS[1], brain_pr_state: null },
          { id: 'p3', slug: 'open-three', title: 'Open', sector: null, created_at: '2026-10-03T00:00:00Z', review_requested: true, brain_pr_state: 'open' },
        ],
      },
    });
    await renderAdmin();
    expect(pathways().map((p) => [p.slug, p.isPublished])).toEqual([
      ['live-one', true],
      ['draft-two', true],
      ['open-three', false],
    ]);
    expect(admin.ops('published_pathways')).toHaveLength(0);
  });
});
