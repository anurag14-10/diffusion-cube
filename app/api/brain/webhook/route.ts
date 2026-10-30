import { createHmac, timingSafeEqual } from 'node:crypto';
import { createAdminClient } from '@/lib/supabase/admin';
import { AuthError, ValidationError, withErrorHandling } from '@/lib/errors';
import { brainBranch, brainGetPR, brainRepo } from '@/lib/github';
import { getBrainSnapshot } from '@/lib/brain/snapshot';
import { applyClosed, applyMerged, applyValidation, pathwayForPullRequest } from '@/lib/brain/review';

// GitHub → the app, for the Cube-Brain repo (KNOWLEDGE_SOURCE=brain,
// docs/features/cube-brain-knowledge-source/, CB-15). Public at proxy.ts: the
// X-Hub-Signature-256 HMAC is the gate, checked before anything else.
//
//   pull_request closed, merged → the pathway is published (lib/brain/review.ts)
//   pull_request closed         → back to a draft for the contributor
//   check_suite completed       → the PR's validation state for the admin console
//   push to BRAIN_BRANCH        → refresh the saved snapshot now
//
// Anything else, or a PR no pathway opened, is acknowledged and ignored.

function verifySignature(body: string, header: string | null, secret: string): boolean {
  if (!header?.startsWith('sha256=')) return false;
  const expected = Buffer.from(`sha256=${createHmac('sha256', secret).update(body).digest('hex')}`);
  const given = Buffer.from(header);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

interface Payload {
  action?: string;
  ref?: string;
  repository?: { full_name?: string };
  pull_request?: { number?: number; merged?: boolean };
  check_suite?: { pull_requests?: { number?: number }[] };
}

async function handlePOST(req: Request) {
  const secret = process.env.GITHUB_WEBHOOK_SECRET;
  const body = await req.text();
  if (!secret || !verifySignature(body, req.headers.get('x-hub-signature-256'), secret)) {
    throw new AuthError('Invalid signature.');
  }

  let payload: Payload;
  try {
    payload = JSON.parse(body) as Payload;
  } catch {
    throw new ValidationError('Invalid payload.');
  }
  if (payload.repository?.full_name !== brainRepo()) return Response.json({ ok: true, ignored: 'repository' });

  const event = req.headers.get('x-github-event');
  const admin = createAdminClient();

  if (event === 'pull_request' && payload.action === 'closed' && payload.pull_request?.number) {
    const pathway = await pathwayForPullRequest(admin, payload.pull_request.number);
    if (!pathway) return Response.json({ ok: true, ignored: 'pull request' });
    if (payload.pull_request.merged) await applyMerged(admin, pathway);
    else await applyClosed(admin, pathway);
    return Response.json({ ok: true });
  }

  if (event === 'check_suite' && payload.action === 'completed') {
    for (const { number } of payload.check_suite?.pull_requests ?? []) {
      if (!number) continue;
      const pathway = await pathwayForPullRequest(admin, number);
      if (!pathway || pathway.brain_pr_state !== 'open') continue;
      // Every check run on the PR's current head decides it, not just this suite.
      const pr = await brainGetPR(number);
      await applyValidation(admin, pathway, pr.validation, pr.validationDetail);
    }
    return Response.json({ ok: true });
  }

  if (event === 'push' && payload.ref === `refs/heads/${brainBranch()}`) {
    await getBrainSnapshot({ force: true });
    return Response.json({ ok: true });
  }

  return Response.json({ ok: true, ignored: event ?? 'event' });
}

export const POST = withErrorHandling('api/brain/webhook', handlePOST);
