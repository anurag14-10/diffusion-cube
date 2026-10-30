import { headers } from 'next/headers';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { isAdmin } from '@/lib/roles';
import AppShell from '@/components/AppShell';
import ExploreLibrary from './ExploreLibrary';
import { slugToAccent, type LibraryPathway } from '@/lib/library-pathways';
import { isBrainSource, libraryCards } from '@/lib/brain/corpus';

// Fetches published pathways from Supabase and maps them to LibraryPathway
// cards. Uses the service-role client so this works for anonymous visitors
// (RLS on published_pathways already uses `using (true)` — public read —
// but the server client needs auth context to call createClient, and an
// anonymous visitor has none, so the admin client sidesteps the issue cleanly).
async function getPublishedPathways(): Promise<LibraryPathway[]> {
  const admin = createAdminClient();
  const { data } = await admin
    .from('published_pathways')
    .select('slug, title, description, sector, stage, location, tags, category')
    .order('created_at', { ascending: false });

  return (data ?? []).map((p) => ({
    id: p.slug,
    title: p.title,
    hook: p.description ?? '',
    location: p.location ?? '',
    category: p.category ?? '',
    stage: (p.stage || 'Explore') as LibraryPathway['stage'],
    accent: slugToAccent(p.slug),
    sector: p.sector ?? undefined,
    tags: (p.tags as string[]) ?? [],
  }));
}

// The Library — deliberately public, no login or registration required (see
// proxy.ts's PUBLIC_PATHS). Lives outside the (app) route group because that
// group's layout gates on account approval, which doesn't apply here. A
// signed-in visitor still gets the normal Sidebar shell (AppShell, shared
// with (app)/layout.tsx) so the app doesn't visually change out from under
// them; a genuinely anonymous visitor gets the same shell with everything
// role-gated hidden, since Sidebar already degrades gracefully with no user.
//
// ?open=<id> reopens a saved conversation — Sidebar's "Recent Explorations"
// links here the same way it links to /strengthen?open=<id>. Resolved
// server-side (RLS already scopes it to the caller's own rows) rather than a
// client fetch, so there's no flash of the library grid before it loads.
export default async function PublicExplorePage({
  searchParams,
}: {
  searchParams: Promise<{ open?: string }>;
}) {
  const { open } = await searchParams;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // KNOWLEDGE_SOURCE=brain: every card comes from the brain, and the
  // hard-coded list in lib/library-pathways.ts is not merged in.
  const brain = isBrainSource();
  const dbPathways = brain ? await libraryCards() : await getPublishedPathways();
  const includeStatic = !brain;

  if (!user) {
    return (
      <AppShell email={null} adoptions={[]} isAdmin={false}>
        <ExploreLibrary dbPathways={dbPathways} includeStatic={includeStatic} />
      </AppShell>
    );
  }

  // proxy.ts only sets this header once a session is confirmed — true here.
  const email = (await headers()).get('x-user-email');

  const [{ data: adoptions }, adminAccess, initialConversation] = await Promise.all([
    supabase.from('designs').select('id, meta, updated_at').order('updated_at', { ascending: false }),
    isAdmin(supabase, email),
    open
      ? supabase
          .from('library_conversations')
          .select('id, pathway_slug, pathway_title, messages')
          .eq('id', open)
          .maybeSingle()
          .then((r) => r.data)
      : Promise.resolve(null),
  ]);

  return (
    <AppShell email={email} adoptions={adoptions ?? []} isAdmin={adminAccess}>
      <ExploreLibrary signedIn dbPathways={dbPathways} includeStatic={includeStatic} initialConversation={initialConversation} />
    </AppShell>
  );
}
