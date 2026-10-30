import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { isAdmin } from '@/lib/roles';
import { notifyContributor, publishPathwayAssets } from '@/lib/pathway-publish';
import { parseFrontmatter } from '@/lib/strip-frontmatter';
import { isBrainSource } from '@/lib/brain/corpus';
import { publishThroughBrain } from '@/lib/brain/review';

import { withErrorHandling } from '@/lib/errors';
// Publishes an assembled pathway (pathways.content_cache) to published_pathways
// so it appears in the Explore library and grounds Analyse conversations.
// Card metadata (title, hook, stage, sector, location, tags) is parsed from
// the document's frontmatter — contributors add these when they write the doc.
// accent is derived deterministically from the slug so it never changes on
// re-publish and requires no contributor input.
async function handlePOST(req: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user || !(await isAdmin(supabase, user.email))) {
    return NextResponse.json({ error: 'Admin only.' }, { status: 403 });
  }

  const body = await req.json().catch(() => ({}));
  const { pathway_id } = body as { pathway_id?: string };
  if (!pathway_id) return NextResponse.json({ error: 'pathway_id required.' }, { status: 400 });

  const admin = createAdminClient();

  // KNOWLEDGE_SOURCE=brain: publishing is merging the pathway's brain pull
  // request (lib/brain/review.ts); published_pathways is not written.
  if (isBrainSource()) {
    const { status, body: result } = await publishThroughBrain(admin, pathway_id);
    return NextResponse.json(result, { status });
  }

  const { data: pathway, error } = await admin
    .from('pathways')
    .select('id, slug, title, sector, content_cache, assembled_design_doc_id')
    .eq('id', pathway_id)
    .single();

  if (error || !pathway) {
    return NextResponse.json({ error: 'Pathway not found.' }, { status: 404 });
  }

  if (!pathway.content_cache) {
    return NextResponse.json(
      { error: 'No assembled document found. The contributor must publish from their workspace first.' },
      { status: 400 }
    );
  }

  const fm = parseFrontmatter(pathway.content_cache) ?? {};
  const title = fm.title || pathway.title;
  const hook = fm.description || '';
  const stage = fm.stage || '';
  const sector = fm.sector || pathway.sector || '';
  const location = fm.location || '';
  const tags = fm.tags ?? [];
  const category = tags.length > 0 ? tags.slice(0, 2).join(' · ') : 'Community';

  const { error: upsertErr } = await admin.from('published_pathways').upsert(
    {
      slug: pathway.slug,
      title,
      description: hook,
      category,
      content: pathway.content_cache,
      sector,
      location,
      tags,
      stage,
      published_by: user.id,
    },
    { onConflict: 'slug' }
  );

  if (upsertErr) {
    console.error('[admin/pathways/publish]', upsertErr);
    return NextResponse.json({ error: 'Failed to publish pathway.' }, { status: 500 });
  }

  await admin.from('pathways').update({
    review_requested: false,
    published_design_doc_id: pathway.assembled_design_doc_id ?? null,
  }).eq('id', pathway_id);

  const { assetIds, assetsPublished } = await publishPathwayAssets(admin, pathway_id, pathway.content_cache);

  await notifyContributor(admin, {
    pathwayId: pathway_id,
    title,
    assembledDocId: pathway.assembled_design_doc_id,
    assetIds,
  });

  return NextResponse.json({ ok: true, slug: pathway.slug, assetsPublished });
}

export const POST = withErrorHandling('api/admin/pathways/publish', handlePOST);
