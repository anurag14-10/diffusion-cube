import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { isAdmin } from '@/lib/roles';
import { isBrainSource } from '@/lib/brain/corpus';
import { getBrainSnapshot } from '@/lib/brain/snapshot';
import { syncOpenReviews } from '@/lib/brain/review';

import { withErrorHandling } from '@/lib/errors';
// Resync from brain (KNOWLEDGE_SOURCE=brain only): fetch the brain snapshot
// now instead of waiting for its refresh interval, and re-read every open
// review from GitHub, in case a webhook was missed
// (docs/features/cube-brain-knowledge-source/).
async function handlePOST() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user || !(await isAdmin(supabase, user.email))) {
    return NextResponse.json({ error: 'Admin only.' }, { status: 403 });
  }
  if (!isBrainSource()) {
    return NextResponse.json({ error: 'Resync is only available when the brain is the knowledge source.' }, { status: 400 });
  }

  const snapshot = await getBrainSnapshot({ force: true });
  const reviews = await syncOpenReviews(createAdminClient());
  return NextResponse.json({ ok: true, pathways: snapshot.pathways.length, reviews });
}

export const POST = withErrorHandling('api/admin/brain/resync', handlePOST);
