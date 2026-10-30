-- Cube-Brain as the app's knowledge source
-- (docs/features/cube-brain-knowledge-source/). Additive only.
--
-- brain_snapshots: the last good copy of the brain snapshot
-- (snapshot/app-knowledge.json in anurag14-10/Cube-Brain), one row per brain
-- branch. lib/brain/snapshot.ts serves it whenever GitHub can't be reached,
-- or on a cold start that can't reach it, so answers keep working.
--
-- knowledge_selections: the pathways the retriever last picked for a design,
-- keyed by a hash of its grid, so an unchanged grid reuses the selection
-- instead of making another Claude call (lib/brain/retrieve.ts).
--
-- pathways.brain_*: the brain pull request a contributor's Send for review
-- opened, and whether the brain's "Validate wiki" check passed. Merging that
-- PR is what publishes the pathway.

create table if not exists public.brain_snapshots (
  branch text primary key,
  commit_sha text not null,
  etag text,
  payload jsonb not null,
  fetched_at timestamptz not null default now()
);

-- RLS on with no policies: service role only, like sys_errors and ai_usage.
-- The payload holds Source Trace appendices, which are contributor-only.
alter table public.brain_snapshots enable row level security;

create table if not exists public.knowledge_selections (
  design_id uuid primary key references public.designs (id) on delete cascade,
  grid_hash text not null,
  slugs text[] not null,
  updated_at timestamptz not null default now()
);

alter table public.knowledge_selections enable row level security;

alter table public.pathways
  add column if not exists brain_pr_number integer,
  add column if not exists brain_pr_url text,
  add column if not exists brain_pr_state text
    check (brain_pr_state in ('open', 'merged', 'closed')),
  add column if not exists brain_validation text
    check (brain_validation in ('pending', 'passed', 'failed')),
  add column if not exists brain_validation_detail text;
