import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { hasRole, isAdmin } from '@/lib/roles'
import { isReservedPathwaySlug } from '@/lib/wiki-loader'
import { isBrainSource, isLive, publishedSlugSet } from '@/lib/brain/corpus'

import { withErrorHandling } from '@/lib/errors'
// Always a valid slug (isValidSlug) — assemble refuses anything else, so a
// pathway created with one could never be published. Hyphens are trimmed after
// the 80-char cut; a title with no ASCII letters or digits (e.g. Devanagari)
// falls back to 'pathway', which uniqueSlug suffixes as needed.
function slugify(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 80)
    .replace(/^-+|-+$/g, '')
  return slug || 'pathway'
}

// Taken means another pathway has it, or it's reserved by the curated corpus
// (isReservedPathwaySlug) — assemble commits to content/wiki/pathways/<slug>.md,
// so a "Blue Dots" or "Index" pathway would otherwise overwrite that file.
async function uniqueSlug(base: string): Promise<string> {
  const admin = createAdminClient()
  let candidate = base
  let suffix = 0
  while (true) {
    if (!(await isReservedPathwaySlug(candidate))) {
      const { data } = await admin
        .from('pathways')
        .select('id')
        .eq('slug', candidate)
        .maybeSingle()
      if (!data) return candidate
    }
    suffix++
    candidate = `${base}-${suffix}`
  }
}

/**
 * List every pathway for the contributor's selector (join an existing one, or
 * spot a duplicate before creating). Contributors and admins only — and
 * listing columns only, never content_cache: the pathways table's own RLS
 * (migration 0040) lets a user read just the pathways they contribute to, so
 * the full list is read here with the service role.
 */
async function handleGET(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!(await hasRole(supabase, 'pathway_contributor')) && !(await isAdmin(supabase, user.email))) {
    return NextResponse.json({ error: 'Contributor role required' }, { status: 403 })
  }

  // KNOWLEDGE_SOURCE=brain: live means published in the brain, or its brain
  // PR merged (lib/brain/corpus.ts isLive) — not a published_pathways row.
  const brain = isBrainSource()
  const { data: pathways, error } = await createAdminClient()
    .from('pathways')
    .select(`id, slug, title, sector, description, created_at, review_requested${brain ? ', brain_pr_state' : ''}`)
    .order('created_at', { ascending: false })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  // Also fetch which pathways this user contributes to so the grid can mark
  // them as "already joined" without a second client-side query, and every
  // contributing org per pathway so the grid can offer an org filter.
  // Live slugs drive each card's Published badge — published_pathways is
  // readable by any approved user (0012).
  const [{ data: myContribs }, { data: orgContribs }, { data: live }] = await Promise.all([
    supabase.from('pathway_contributors').select('pathway_id').eq('user_id', user.id),
    supabase.from('pathway_contributors').select('pathway_id, organisations(name)'),
    brain ? Promise.resolve({ data: null }) : supabase.from('published_pathways').select('slug'),
  ])
  const liveSlugs = brain ? await publishedSlugSet() : new Set((live ?? []).map((r) => r.slug as string))

  const mySet = new Set((myContribs ?? []).map((r) => r.pathway_id as string))
  const orgsByPathway = new Map<string, Set<string>>()
  for (const row of orgContribs ?? []) {
    const org = row.organisations as unknown as { name: string } | { name: string }[] | null
    const orgName = Array.isArray(org) ? org[0]?.name : org?.name
    if (!orgName) continue
    const pathwayId = row.pathway_id as string
    if (!orgsByPathway.has(pathwayId)) orgsByPathway.set(pathwayId, new Set())
    orgsByPathway.get(pathwayId)!.add(orgName)
  }

  type Row = { id: string; slug: string; review_requested: boolean | null; brain_pr_state?: string | null }
  const result = ((pathways ?? []) as unknown as Row[]).map(({ review_requested, brain_pr_state, ...p }) => ({
    ...p,
    isPublished: isLive(p.slug, brain_pr_state, liveSlugs),
    reviewRequested: review_requested ?? false,
    isContributor: mySet.has(p.id),
    orgs: Array.from(orgsByPathway.get(p.id) ?? []),
  }))

  return NextResponse.json(result)
}

/** Create a new pathway. Requires pathway_contributor role. */
async function handlePOST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!(await hasRole(supabase, 'pathway_contributor'))) {
    return NextResponse.json({ error: 'Contributor role required' }, { status: 403 })
  }

  const body = await req.json().catch(() => ({}))
  const { title, sector, description } = body as { title?: unknown; sector?: unknown; description?: unknown }
  // A non-string (e.g. a number) is as missing as an absent field.
  if (typeof title !== 'string' || !title.trim()) return NextResponse.json({ error: 'title required' }, { status: 400 })
  if (typeof sector !== 'string' || !sector.trim()) return NextResponse.json({ error: 'sector required' }, { status: 400 })
  if (typeof description !== 'string' || !description.trim()) {
    return NextResponse.json({ error: 'description required' }, { status: 400 })
  }

  const slug = await uniqueSlug(slugify(title.trim()))
  const admin = createAdminClient()

  const { data: pathway, error } = await admin
    .from('pathways')
    .insert({
      slug,
      title: title.trim(),
      sector: sector.trim(),
      description: description.trim(),
      created_by: user.id,
    })
    .select('id, slug')
    .single()

  if (error || !pathway) {
    return NextResponse.json({ error: error?.message ?? 'Could not create pathway' }, { status: 500 })
  }

  return NextResponse.json(pathway, { status: 201 })
}

export const GET = withErrorHandling('api/pathways', handleGET)
export const POST = withErrorHandling('api/pathways', handlePOST)
