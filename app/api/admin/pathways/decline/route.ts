import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { isAdmin } from '@/lib/roles';
import { isBrainSource } from '@/lib/brain/corpus';
import { declineThroughBrain } from '@/lib/brain/review';

import { withErrorHandling } from '@/lib/errors';
// Declines a pathway sent for review (KNOWLEDGE_SOURCE=brain only): closes its
// Cube-Brain pull request, and the pathway goes back to the contributor as a
// draft. Nothing reaches users (docs/features/cube-brain-knowledge-source/).
async function handlePOST(req: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user || !(await isAdmin(supabase, user.email))) {
    return NextResponse.json({ error: 'Admin only.' }, { status: 403 });
  }
  if (!isBrainSource()) {
    return NextResponse.json({ error: 'Declining is only available when the brain is the knowledge source.' }, { status: 400 });
  }

  const body = await req.json().catch(() => ({}));
  const { pathway_id } = body as { pathway_id?: unknown };
  if (typeof pathway_id !== 'string' || !pathway_id) {
    return NextResponse.json({ error: 'pathway_id required.' }, { status: 400 });
  }

  const { status, body: result } = await declineThroughBrain(createAdminClient(), pathway_id);
  return NextResponse.json(result, { status });
}

export const POST = withErrorHandling('api/admin/pathways/decline', handlePOST);
