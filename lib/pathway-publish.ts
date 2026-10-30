import type { createAdminClient } from '@/lib/supabase/admin';
import { assetIdsInDocument } from '@/lib/toolkit-assets';
import { loadPathwayToolkitAssets } from '@/lib/toolkit-assets-server';
import { CUBE_APP_URL, sendContributionEmail } from '@/lib/email';

// What happens when a pathway goes live, shared by the admin publish route
// (published_pathways) and the Cube-Brain merge handler (lib/brain/review.ts,
// KNOWLEDGE_SOURCE=brain): its toolkit assets go live, and its contributor
// is told.

type Admin = ReturnType<typeof createAdminClient>;

// Toolkit assets ride the pathway's own approval: publish exactly the assets
// listed in the document the admin just reviewed and published (their
// <!-- asset-id --> markers, written by assemble), and only this pathway's.
// An asset shared after the last Send for Review isn't in the document, so it
// waits for the next round. Idempotent on re-publish.
export async function publishPathwayAssets(
  admin: Admin,
  pathwayId: string,
  document: string
): Promise<{ assetIds: string[]; assetsPublished: boolean }> {
  const assetIds = assetIdsInDocument(document);
  if (assetIds.length === 0) return { assetIds, assetsPublished: true };
  const { error } = await admin
    .from('contribution_units')
    .update({ published_at: new Date().toISOString() })
    .eq('pathway_id', pathwayId)
    .eq('unit_type', 'toolkit-asset')
    .is('published_at', null)
    .in('unit_internal_id', assetIds);
  if (error) {
    console.error('[pathway-publish] toolkit assets:', error);
    return { assetIds, assetsPublished: false };
  }
  return { assetIds, assetsPublished: true };
}

// Tells the contributor whose draft was just approved that it's live, which
// toolkit assets went live with it, and which shared ones didn't (shared
// after they last sent it for review — they go live with the next approved
// round). Best-effort: the pathway is already published, so an email failure
// is logged, never returned.
export async function notifyContributor(
  admin: Admin,
  opts: { pathwayId: string; title: string; assembledDocId: string | null; assetIds: string[] }
) {
  try {
    if (!opts.assembledDocId) return;
    const { data: doc } = await admin
      .from('design_documents')
      .select('design_id, user_id')
      .eq('id', opts.assembledDocId)
      .maybeSingle();
    if (!doc?.user_id) return;
    const { data: contributor } = await admin.auth.admin.getUserById(doc.user_id);
    const email = contributor?.user?.email;
    if (!email) return;

    const assets = await loadPathwayToolkitAssets(opts.pathwayId);
    const live = assets.filter((a) => opts.assetIds.includes(a.unit_internal_id)).map((a) => a.asset_name);
    const waiting = assets.filter((a) => !a.published_at && !opts.assetIds.includes(a.unit_internal_id)).map((a) => a.asset_name);

    const paragraphs = [`Your pathway "${opts.title}" has been approved and is now part of 100 Pathways, where it can help future adopters.`];
    if (live.length) paragraphs.push(`Published with it, and downloadable by anyone: ${live.join(', ')}.`);
    if (waiting.length) {
      paragraphs.push(
        `Not published yet: ${waiting.join(', ')}. You shared these after you last sent the pathway for review; they go live the next time it's sent for review and approved.`
      );
    }
    await sendContributionEmail({
      to: email,
      subject: `Your pathway "${opts.title}" is published`,
      heading: 'Your pathway is published',
      paragraphs,
      // Straight into the contributor's own workspace for this pathway
      // (ContributeGrid's ?open= deep link; they sign in first if needed).
      link: { url: `${CUBE_APP_URL}/contribute?open=${doc.design_id}`, label: 'Open your contribution' },
    });
  } catch (err) {
    console.error('[pathway-publish] contributor email:', err);
  }
}
