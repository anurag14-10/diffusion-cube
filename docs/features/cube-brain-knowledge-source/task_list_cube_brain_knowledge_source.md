# Task List: Cube-Brain as the Knowledge Source

> Status: **Approved 2026-10-30** (task-creation). Revised before approval: CB-01 follows the `cube-brain` skill's `references/schema-change.md`, CB-02 uses its Mode C ingest, and CB-13 builds its extraction prompt from its `references/ingest-pathway.md`, so the brain's ingest rules live in one place. Derived from the approved
> [`plan_cube_brain_knowledge_source.md`](plan_cube_brain_knowledge_source.md). Requirement:
> [`requirement_cube_brain_knowledge_source.md`](requirement_cube_brain_knowledge_source.md).
> Clarifications: [business](business_clarifications_cube_brain_knowledge_source.md),
> [architecture](architecture_clarifications_cube_brain_knowledge_source.md).

> **Testing note.**
> - **App repo:** it has a Vitest suite (`npm test`; `tests/unit`, `tests/api`, `tests/features`, `tests/db`, `tests/proxy`), and every external client is mocked (`tests/helpers/supabase-mock.ts`, `anthropic-mock.ts`). No CI job runs it: `.github/workflows/deploy.yml` only deploys. So "automated" below means **a Vitest test added in this story and run locally with `npm test` before the PR**, not a CI gate. The wiki's `architecture/testing.md` still says there are no tests; that is stale.
> - **Brain repo:** it has no unit tests. Its gate is `python3 scripts/validate_wiki.py .`, which CI (`validate.yml`) runs on every PR and push.
> - **Live checks:** cases marked 💲 are manual checks that call the real Anthropic API or write to the real GitHub repo. Run them against the brain's `dev` branch and the dev Supabase project, never `main`.

## Implementation status (2026-10-30)

Nothing is committed or pushed yet. The brain work sits on local branch `app-knowledge-source` in Cube-Brain and is not pushed until the repo is private (CB-04).

| Story | Status |
|---|---|
| CB-01 | Done (brain). **No schema bump**: an optional field and a non-entity folder need none (`schema-change.md`). `card_title`/`card_location` were added too. Validator: 0 errors. |
| CB-02 | 8 curated pathways done (documents, card fields, links). The 2 database-only pathways (Advanced Citizen Grievances System, Sahayak for Health) are **deferred**, and must land before prod switches. |
| CB-03 | Done (brain): `scripts/build_app_snapshot.py`, CI on `main` + `dev`. The `dev` branch is created when pushed. |
| CB-04 | **Manual, pending**: repo private, fine-grained `BRAIN_GITHUB_TOKEN` (PAT replaced the GitHub App on 2026-10-30), branch protection, webhook. `.env.example` is done. |
| CB-05 | Done; applied to the **dev** database and verified. |
| CB-06 to CB-10 | Done, with Vitest coverage. |
| CB-17 | Done (2026-10-30): intent-aware retrieval for the three must-have capabilities, with Vitest coverage. The first test-set run (library, brain mode, local) passed 15/15 after two fixes: see [`test_set_cube_brain_knowledge_source.md`](test_set_cube_brain_knowledge_source.md). |
| CB-11 | Pending: needs CB-04, CB-02's 2 pathways, and the agreed test set and pass mark. |
| CB-12 to CB-16 | Done, with Vitest coverage (GitHub, Anthropic and Supabase mocked). An app-rendered submission was validated with the brain's own `validate_wiki.py` (0 errors). The live 💲 checks wait on CB-04. |

Added during the work: a `diffusion_cube_app` source in the brain's `SOURCES.md`; `lib/pathway-publish.ts` (asset publishing and the contributor email shared by the legacy publish and the brain merge); the `brain-extract` usage mode (area Contribute).

## Build order

```
Brain foundation              App read path                         Write path
────────────────              ─────────────                         ──────────
CB-01 schema v3 ─► CB-02 content catch-up ─┐
       └─────────► CB-03 snapshot + CI + dev ┤
CB-04 private repo + App + webhook ──────────┤
                                             ▼
CB-05 migration 0042 ─► CB-06 snapshot reader + flag ─┬─► CB-07 library + /wiki read sites
                                                      ├─► CB-08 contributor/admin read sites
                                                      └─► CB-09 retriever (Analyse) ─► CB-10 retriever (contributor + library overview)
                                                                                              │
                                              CB-07..CB-10 ─► CB-11 test-set gate + prod flip
CB-06 ─► CB-12 GitHub PR operations ─┬─► CB-14 assemble → brain PR ─┐
CB-01 ─► CB-13 extraction + entries ─┘                              ├─► CB-16 admin publish/decline/resync + console UI
                                       CB-12 ─► CB-15 webhook + post-merge handler ─┘
```

CB-01 to CB-04 land in the **Cube-Brain** repo or its GitHub settings; everything else lands in **diffusion-cube**. CB-11 gates switching **prod reads**; the write path (CB-12 to CB-16) can be built in parallel but goes live in prod only after CB-11.

---

## Stories

### CB-01: Brain schema v3 (`documents/`, `card_hook`), migrator and validator

**As a** Solution Team engineer
**I want** the brain to hold each pathway's full document and its library-card hook
**So that** the brain can be the single source the app reads (requirement item 1; architecture Q6, Q7)

**Priority:** P0
**Depends on:** None

**Acceptance Criteria:**
- Given `SCHEMA.yml` and `CONVENTIONS.md`:
  - when v3 is introduced, then the schema version is 3;
  - a top-level `documents/` folder is documented as holding `<slug>.md`, the verbatim pathway document with its Source Trace appendix, and is **not** an entity folder;
  - the pathway type gains an optional `card_hook` (str) field.
- Given the "Version history" in `CONVENTIONS.md`, when v3 is recorded, then it lists the field-level mapping from v2: no field renamed; `documents/` added; `card_hook` added; "Full document copies" removed from "does not hold" and replaced by the rule that the brain holds the canonical document.
- Given `scripts/migrate_v2_to_v3.py`, when run with `--check` on a v2 brain, then it reports every file below v3. When run without `--check`, every entity file gets `schema_version: 3` and nothing else changes.
- Given `scripts/validate_wiki.py`:
  - when a pathway has `lifecycle: published` and no `documents/<slug>.md`, then it reports an **error**;
  - when a `documents/*.md` file has no matching pathway entry, then it reports an error;
  - `documents/` files are not validated as entities.
- Given a pathway's `doc_refs`, when its document lives in the brain, then `doc_refs` includes `documents/<slug>.md`.
- Given the `cube-brain` skill, when v3 lands, then the bump follows `skills/cube-brain/references/schema-change.md`, and the skill's own docs (`SKILL.md`, `references/ingest-pathway.md`) state that ingesting a pathway also writes `documents/<slug>.md` and `card_hook`.

**Test Plan:**
- *Positive:*
  - Run `python3 scripts/migrate_v2_to_v3.py . --check` on a clean checkout: it lists all files. Run it without `--check`, then run `python3 scripts/validate_wiki.py .`: it exits 0 once CB-02's documents exist (run this together with CB-02, or on a branch where those documents are present).
  - `git diff --stat` after the migrator shows only `schema_version` lines changed.
- *Edge cases:*
  - A pathway with `lifecycle: unindexed` (e.g. `ai-advisory-for-dairy-farmers`) and no document: the validator reports **no** error.
  - A `documents/` file containing YAML frontmatter and a `---` horizontal rule in its body: the validator doesn't try to parse it as an entity.
- *Negative cases:*
  - Delete `documents/mahavistaar.md` locally: the validator exits non-zero, naming `mahavistaar`.
  - Add `documents/orphan.md` with no pathway: the validator exits non-zero.
  - A file still claiming `schema_version: 4`: the validator errors, as today for versions ahead of CONVENTIONS.
- *Non-functional:*
  - The migrator is idempotent: running it twice produces no further diff.

---

### CB-02: Brain content catch-up for the 10 live pathways

**As a** Program Team member
**I want** the brain to contain everything users see in the app today, in its current version
**So that** switching the app to the brain loses nothing (requirement item 10; business Q17)

**Priority:** P0
**Depends on:** CB-01

**Acceptance Criteria:**
- Given the 8 curated pathways in `content/wiki/pathways/index.md`, when the catch-up lands, then each has `documents/<slug>.md` equal byte for byte to the app's file. CEEW Climate Intelligence and Data DHARA use the 2026-10-22 versions.
- Given the 2 published database pathways (Advanced Citizen Grievances System, Sahayak for Health):
  - when added, then each has a pathway entry (`lifecycle: published`), its `documents/<slug>.md` copied from `published_pathways.content`, and its units;
  - the units are extracted with the `cube-brain` skill's **Mode C** (`references/ingest-pathway.md`), so all 10 are on the same footing.
- Given the 8 hard-coded cards in `lib/library-pathways.ts`, when the catch-up lands, then each matching pathway entry's `card_hook` equals that card's `hook`. The 2 database pathways get `card_hook` from `published_pathways.description`.
- Given the brain's 8 stale `content/library-wiki/` links, when fixed, then no `doc_refs` points at `content/library-wiki/`.
- Given `test-assets-langchat`, the 2 app drafts (Citizen Help, Community Health) and the 6 `unindexed` brain pathways, then none is set to `published` by this story.
- Given `python3 scripts/check_corpus_drift.py`, when run after the catch-up, then it reports no missing or changed pathways among the 10.

**Test Plan:**
- *Positive:*
  - `diff content/wiki/pathways/mahavistaar.md <brain>/documents/mahavistaar.md` shows no output; repeat for all 8.
  - `grep -l "lifecycle: published" pathways/*.md | wc -l` returns 10.
  - `validate_wiki.py` exits 0.
- *Edge cases:*
  - Sahayak for Health's document has no frontmatter `timestamp`: confirm the pathway entry records `published_on` from `published_pathways.created_at`, so the app can keep its "First published" date line (`datedLine`).
  - A database pathway with an empty `description`: `card_hook` is left blank rather than invented ("blank beats plausible").
- *Negative cases:*
  - `grep -r "library-wiki" pathways/ units/` returns nothing.
  - `grep -l "test-assets-langchat" pathways/` returns nothing, or an entry that is not `published`.
- *Non-functional:*
  - No personal data is copied: `published_pathways.published_by` user ids are not written anywhere (brain rule "no personal data").

---

### CB-03: App snapshot builder, CI on `main` and `dev`, and the `dev` branch

**As a** Solution Team engineer
**I want** the brain to publish one JSON file containing exactly what the app may use
**So that** the app can read the brain without parsing YAML (architecture Q4, Q5, Q14)

**Priority:** P0
**Depends on:** CB-01

**Acceptance Criteria:**
- Given `scripts/build_app_snapshot.py`, when run, then it writes `snapshot/app-knowledge.json` with this shape:
  - `{schema_version, commit, built_at, pathways, units, organisations}`
  - pathways: `slug, title, card_hook, sector, use_case_category, geography, stage_reached, summary, tags, coverage, contributing_organisations, published_on, document`
  - units: `slug, pathway, unit_type, dimension, sub_category, stage, also_relevant_at, applies_when, fails_when, adopter_intents, body`
  - organisations: `slug, name, summary`
- Given the brain contains unpublished, unindexed or retired pathways, people, decisions, risks and milestones, when the snapshot is built, then **none** of them appears. Units appear only if their `pathway`, or for patterns any of their `pathways`, is published. Organisations appear only if a published pathway names them.
- Given SCHEMA's `redact` list (`email, phone, value, contact_info, poc_email`), when a field matches, then it is not in the snapshot.
- Given `.github/workflows/validate.yml`, when a push lands on `main` or `dev`, then the workflow builds the snapshot and commits it with `[skip ci]` only if it changed. On a pull request it builds it for the checks but does not commit it.
- Given the repo, then a `dev` branch exists, created from `main` after CB-02.

**Test Plan:**
- *Positive:*
  - Run the script locally and confirm `jq '.pathways | length'` is 10 and `jq '[.units[].pathway] | unique | length'` ≤ 10.
  - Confirm `jq '.pathways[] | select(.slug=="mahavistaar") | .document' | head` starts with the document's frontmatter.
- *Edge cases:*
  - A Problem-Solution Pattern spanning a published and an unindexed pathway is included. Its `pathways` list keeps both slugs; the app treats only published slugs as citable (CB-06).
  - Running the builder twice with no brain change gives an identical file apart from `built_at`. CI must compare without `built_at`, so it doesn't commit on every push.
- *Negative cases:*
  - `jq '.. | strings' snapshot/app-knowledge.json | grep -E "@|\\+91"` finds no email addresses or phone numbers.
  - Set one pathway to `retired` on a scratch branch and rebuild: it and its units disappear.
- *Non-functional:*
  - The snapshot size is printed in the CI log. Expect about 1 MB; the app fetches it with the raw media type (CB-06), so the Contents API 1 MB JSON limit doesn't apply.

---

### CB-04: Private repo, brain token, branch protection and webhook (setup)

**As a** Solution Team engineer
**I want** the brain locked down, with an App identity and events wired to the app
**So that** drafts and Source Trace stay private and the app can act on the brain (business Q6; architecture Q9, Q10, Q11)

**Priority:** P0
**Depends on:** None (do it before CB-06 is deployed)

**Acceptance Criteria:**
- Given `anurag14-10/Cube-Brain`, when this story is done, then:
  - the repo is **private**;
  - the Solution and Program Team members who need to read or merge are collaborators.
- Given a personal access token (*updated 2026-10-30: replaces the GitHub App*), which is either:
  - a fine-grained token of the repo's owner (`anurag14-10`) with repository access to Cube-Brain only and the permissions Contents: read & write, Pull requests: read & write, Actions: read, Metadata: read; or
  - a classic token (`repo` scope) of a bot account that is a collaborator on Cube-Brain only (a fine-grained token can't reach another account's personal repo);

  then:
  - it is stored as `BRAIN_GITHUB_TOKEN` in the dev and prod Vercel environments, and its expiry date is recorded where the team will see it before it lapses.
- Given branch protection on `main` and `dev`, then:
  - pull requests require the "Validate wiki" check to pass before merging;
  - admins may bypass the check for direct pushes (business clarification: an admin's own change counts as approved);
  - the CI bot can still push its `[skip ci]` derived-pages commit.
- Given a repository webhook, then it points at `<app-url>/api/brain/webhook` for each environment, sends `pull_request`, `check_suite` and `push` events, and uses a secret stored as `GITHUB_WEBHOOK_SECRET`.
- Given `.env.example`, then it lists every new variable from the plan's Config row with a one-line comment and no values.

**Test Plan:**
- *Positive:*
  - From a logged-out browser, `https://github.com/anurag14-10/Cube-Brain` returns 404.
  - A test PR opened with `BRAIN_GITHUB_TOKEN` (curl, 💲 writes to GitHub) appears authored by the token's account.
- *Edge cases:*
  - The CI derived-pages commit on `main` still succeeds after protection is on: push a trivial doc change as an admin and confirm the bot commit lands.
  - The `cube-brain` skill's fork-based write route for non-collaborators no longer works on a private repo. Confirm the skill's `write-route.md` is updated to say collaborators only.
- *Negative cases:*
  - A PR whose validation fails cannot be merged in the GitHub UI by a non-admin.
  - `BRAIN_GITHUB_TOKEN` cannot read another repo of the account (expect 404).
- *Non-functional:*
  - The token is stored only in Vercel env vars and a password manager, never committed. Check with `git log -p | grep -c "github_pat_"` = 0 in both repos.

---

### CB-05: Migration `0042_brain_knowledge_source.sql`

**As a** Solution Team engineer
**I want** tables for the saved snapshot and cached selections, and PR state on `pathways`
**So that** the read path has a fallback and the write path can track reviews (plan: Data Model)

**Priority:** P0
**Depends on:** None

**Acceptance Criteria:**
- Given `supabase/migrations/0042_brain_knowledge_source.sql`, then:
  - it starts with a comment stating its purpose;
  - it is additive only (no drop, no rename);
  - it creates `brain_snapshots(branch pk, commit_sha, etag, payload jsonb, fetched_at)` and `knowledge_selections(design_id pk → designs(id) on delete cascade, grid_hash, slugs text[], updated_at)`;
  - both tables have RLS on and **no** policies (service role only, like `sys_errors`/`ai_usage`).
- Given `pathways`, then it gains `brain_pr_number int`, `brain_pr_url text`, `brain_pr_state text` with a check constraint (`open|merged|closed`), `brain_validation text` with a check constraint (`pending|passed|failed`), and `brain_validation_detail text`, all nullable.
- Given `0041_admin_usage_stats_ist.sql` is the current highest number on this branch, then the new file is `0042`. If another `0042` lands first, it is renumbered before merge.

**Test Plan:**
- *Positive (automated):*
  - Extend `tests/db/migrations.test.ts`: `0042` creates both tables, enables RLS on each, contains no `create policy` for them, and contains no `drop `.
- *Positive (manual):*
  - Apply on dev Supabase with `psql "$SUPABASE_DB_URL" -f …` and confirm `\d brain_snapshots` and the new `pathways` columns.
- *Edge cases:*
  - Applying twice fails cleanly on `create table`, the same convention as other migrations. Note in the PR that it is not re-runnable.
  - Deleting a `designs` row removes its `knowledge_selections` row (cascade).
- *Negative cases:*
  - As an `adopter` session through the REST API, `select * from brain_snapshots` returns 0 rows (RLS, no policy).
  - `update pathways set brain_pr_state='weird'` is rejected by the check constraint.
- *Non-functional:*
  - Production is applied only after the code that reads these columns is deployed. Same order as the 0040 note: code first, then migration. It is additive, so the risk is low.

---

### CB-06: Snapshot reader, brain corpus accessors and the `KNOWLEDGE_SOURCE` flag

**As a** Solution Team engineer
**I want** one module that fetches, caches, falls back and exposes published brain content
**So that** every read site switches to the brain the same way (requirement items 1, 3; architecture Q4, Q13)

**Priority:** P0
**Depends on:** CB-03, CB-04, CB-05

**Acceptance Criteria:**
- **Brain token** (*updated 2026-10-30*). Given `lib/github.ts`, then every brain request carries `BRAIN_GITHUB_TOKEN`, never `GITHUB_TOKEN`. A missing token fails before any GitHub call, and the snapshot reader then serves its saved copy. The existing `ghReadFile`/`ghWriteFile` keep working for the legacy assemble path.
- **Fetching.** Given `lib/brain/snapshot.ts`, `getBrainSnapshot()`:
  - fetches `BRAIN_SNAPSHOT_PATH` from `BRAIN_REPO`@`BRAIN_BRANCH` with `Accept: application/vnd.github.raw` and `If-None-Match`;
  - fetches at most once per `BRAIN_SNAPSHOT_TTL_SECONDS` (default 300) per server instance;
  - a 304 keeps the in-memory copy;
  - a 200 with a new commit is parsed once and upserted into `brain_snapshots`.
- **Fallback.** Given GitHub returns an error or times out, or a cold start can't reach it, when `getBrainSnapshot()` runs, then it returns the `brain_snapshots` row for the branch and records the failure with `recordServerError`. The caller gets content, not an exception.
- **Version check.** Given a snapshot whose major `schema_version` is unknown, then it is rejected, the last good copy is kept, and the rejection is recorded in `sys_errors`.
- **No copy anywhere.** Given neither GitHub nor a saved copy is available, then `getBrainSnapshot()` throws, and the calling route answers with the generic message through `withErrorHandling`.
- **Corpus accessors.** Given `lib/brain/corpus.ts`, then it exports `publishedPathways()`, `pathwayDocument(slug, {forAdopter})`, `unitsFor(slugs)`, `libraryCards()` and `isPublishedSlug(slug)`. These:
  - filter `lifecycle == published` again;
  - return documents with the Source Trace removed by `stripProvenanceAppendix` whenever `forAdopter` is true;
  - derive a card's accent from its slug, the same way `publish/route.ts` does today.
- **Flag.** Given `KNOWLEDGE_SOURCE` is unset or `legacy`, then every read site behaves exactly as today. Given `brain`, the read sites in CB-07 to CB-10 use `corpus.ts`.

**Test Plan:**
- *Positive (automated):*
  - `tests/unit/server/brain-snapshot.test.ts` with `fetch` mocked: first call fetches and saves; a second call within the TTL makes no fetch; after the TTL it sends `If-None-Match`, and a 304 keeps the copy.
  - `tests/unit/lib/brain-corpus.test.ts` over a fixture snapshot: only published pathways are returned; `forAdopter` removes the appendix; accent is stable per slug.
- *Edge cases (automated):*
  - The fixture includes a `retired` pathway that slipped into the snapshot: it is filtered out.
  - Two concurrent first calls on a cold instance produce one GitHub fetch (shared in-flight promise, like `lib/static-content.ts`).
- *Negative cases (automated):*
  - `fetch` rejects: the saved row is served and `recordServerError` is called once.
  - A snapshot with `schema_version: 99` is rejected and the saved copy is served.
  - No row and a fetch failure: the route test expects a 500 with the generic message.
- *Live check (💲, manual):*
  - On dev with `KNOWLEDGE_SOURCE=brain`, load `/explore` and confirm a `brain_snapshots` row for `dev` with the current commit.
- *Non-functional:*
  - No token in any error message (asserted in the snapshot and github-brain tests).

---

### CB-07: Library and `/wiki` read from the brain

**As an** Explorer or public library visitor
**I want** the library cards, per-pathway chat and `/wiki` pages to come from the brain
**So that** a newly published pathway appears without a code change, and nothing unpublished ever does (requirement items 3, 4)

**Priority:** P0
**Depends on:** CB-06

**Acceptance Criteria:**
- **Cards.** Given `KNOWLEDGE_SOURCE=brain`, when `/explore` loads, then cards come from `libraryCards()`, not from `lib/library-pathways.ts` plus `published_pathways`:
  - one card per published brain pathway;
  - `card_hook` as the hook;
  - `stage_reached` mapped to Explore/Define/Pilot/Scale.
- **Per-pathway chat.** Given a library chat with a `pathwayId`:
  - the document comes from `pathwayDocument(slug, {forAdopter: true})`, with its date line from the document's `timestamp`, else `published_on`;
  - a slug that isn't published returns 404 "Unknown pathway." as today;
  - `isValidSlug`, the Explore rate limit and the input caps run first, unchanged.
- **Browsing.** Given `/wiki`, `/wiki/<slug>`, `GET /api/wiki-pathways` and `GET /api/wiki-stats`, then they list, count and show only published brain pathways, with the appendix stripped on display.
- **Toolkit assets.** Given toolkit assets, then `loadPublishedToolkitAssets({pathwaySlug})` keeps reading `contribution_units` (architecture Q15), so asset cards still appear in library chat.

**Test Plan:**
- *Positive (automated):*
  - Extend `tests/api/wiki-pathways.test.ts` and `wiki-stats.test.ts` with a brain-mode branch over a fixture snapshot.
  - Extend `tests/api/chat.test.ts` (library): a published slug returns a stream; the system prompt contains the document without its Source Trace.
- *Positive (manual):*
  - On dev in brain mode, `/explore` shows 10 cards with the same hooks as before (CB-02).
- *Edge cases:*
  - A published pathway with no `card_hook`: the card shows its `summary`, truncated as the card component already does, rather than a blank tile.
  - The slug `index`, or any slug of a curated file that isn't published in the brain: 404.
- *Negative cases (automated):*
  - `pathwayId: "../../x"`: 404 before any snapshot access (unchanged guard).
  - An unpublished slug present only in the fixture's raw data: 404 and not in the card list.
  - Grep the library system prompt in the test for "Source Trace": not found.
- *Non-functional:*
  - Legacy mode: the existing `library` tests in `tests/api/chat.test.ts` and `tests/unit/lib/library-pathways.test.ts` pass unchanged.

---

### CB-08: Contributor and admin read sites use the brain

**As a** Contributor or admin
**I want** the duplicate check, Published badges and slug protection to look at the brain
**So that** they agree with what is actually live (requirement item 3; plan: corpus read sites)

**Priority:** P1
**Depends on:** CB-06

**Acceptance Criteria:**
- **Duplicate check.** Given brain mode, when `POST /api/pathways/check-similar` runs, then it compares against the brain's published pathways, not `published_pathways` plus the static list. Its forced-tool-use call and its swallow-to-"no match" failure behaviour are unchanged.
- **Published badge.** Given `GET /api/pathways` and the admin page, when they compute the Published badge, then a pathway counts as live when `isPublishedSlug(slug)` is true **or** its `brain_pr_state` is `merged`. That covers the up-to-5-minute gap after a merge.
- **Slug protection.** Given a new pathway slug, or an assemble for a pathway that has never been merged into the brain, when that slug is already a published brain pathway, then `isReservedPathwaySlug` treats it as reserved and assemble refuses with the existing 409 message.

**Test Plan:**
- *Positive (automated):*
  - Extend `tests/api/pathways/check-similar.test.ts`: in brain mode the prompt lists brain titles.
  - Extend `tests/api/pathways/pathways.test.ts`: badge true for a published brain slug.
- *Edge cases (automated):*
  - `brain_pr_state = 'merged'` but the snapshot is older: badge still true.
  - The pathway's own slug after it was merged (an update): **not** reserved for that pathway.
- *Negative cases (automated):*
  - Anthropic throws in check-similar: the response is still "no match" (unchanged), and an `ai_usage` row records `ok:false`.
  - A contributor creating a pathway titled like a brain pathway with the identical slug: they get a suffixed slug (`uniqueSlug`), never the brain's.
- *Non-functional:*
  - Legacy mode: the existing tests pass unchanged.

---

### CB-09: Retriever for Analyse (selection + grounding block)

**As an** Explorer (`adopter`)
**I want** the assistant to answer from the pathways that match my situation
**So that** answers are relevant instead of drawn from the whole corpus (requirement item 2, "How the assistant behaves"; architecture Q1, Q2, Q16)

**Priority:** P0
**Depends on:** CB-06

**Acceptance Criteria:**
- **Selection call.** Given `lib/brain/retrieve.ts`, when `selectPathways()` runs, then:
  - it makes one non-streaming `claude-sonnet-4-6` call with a forced `select_pathways` tool (the `check-similar` pattern);
  - the input is the published catalogue (slug, title, sector, `use_case_category`, geography, stage, summary), the last few turns and `meta`;
  - the call returns at most 3 known published slugs, ranked. Unknown slugs are dropped.
  - The tool description states the matching test: same sector **and** same kind of problem.
- **Usage recording.** Given the selection call, then it writes one `ai_usage` row with `area` from `areaFor(mode, flow)` (the monitoring rule: every Claude call is counted).
- **Grounding block.** Given a selection, when `buildGroundingBlock()` runs, then it contains:
  - the selected pathways' units, with units whose `dimension:stage` is a grid cell with density > 0, or whose `also_relevant_at` includes the stage under discussion, listed first;
  - their patterns;
  - the full documents of the top 2;
  - each pathway's "Contributed by" and date lines, as `loadWikiContext` does today.
- **No match.** Given the selection returns none, then the block carries an explicit no-matching-pathway marker, and the explorer prompt keeps stating pathway absence and micro-innovation absence separately.
- **Reuse.** Given a design whose grid hash equals the row in `knowledge_selections`, when the next companion turn runs, then no selection call is made and the stored slugs are used. A changed grid triggers a new call and an upsert.
- **Other Analyse modes.** Given `analysis-doc` and `executive-summary`, then they use the design's stored selection, and run a selection only if none is stored.
- **Selection failure.** Given the selection call fails, then the turn uses the whole published corpus from the snapshot (today's behaviour), the failure is recorded in `sys_errors`, and the user gets a normal reply.
- **Rules unchanged.** Given brain mode, then:
  - the prompt keeps `PROMPT_CACHE_BREAK` with the framework and instructions before it;
  - micro-innovations are phrased as suggestions;
  - the Source Trace rule is unchanged.

**Test Plan:**
- *Positive (automated):*
  - `tests/unit/server/brain-retrieve.test.ts` with Anthropic mocked: a tool result of two slugs gives a block that contains those pathways' units and documents and **no** text from a third pathway.
  - Unit ordering: grid cells under discussion first.
- *Positive (manual, 💲):*
  - On dev in brain mode, start Analyse as an agriculture voice-advisory team. Confirm the reply cites MahaVISTAAR, not unrelated pathways, and `ai_usage` shows a selection row plus the companion row.
- *Edge cases (automated):*
  - The first turn has an empty grid: units are not filtered, only ordered.
  - The selection returns 4 slugs, one of them unknown: 3 known slugs are kept and the unknown one is dropped.
  - Same grid hash twice: the second turn makes no selection call (Anthropic mock called once).
- *Negative cases (automated):*
  - The selection call throws: the companion prompt contains every published pathway, `recordServerError` is called, and the response is a 200 stream.
  - A tool result that isn't valid against the schema is treated as a failure, so the fallback runs.
  - An `adopter` request with `flow: 'contributor'` is still rejected by `requiredRole` before any selection (unchanged).
- *Non-functional:*
  - Cost check on dev: compare average `cache_creation_tokens + cache_read_tokens + input_tokens` for `analyse/companion` before and after. Expect about 37–45K against about 51K today (plan: Non-Functional Impact). Record both in the PR.
  - Suggestion: `buildGroundingBlock` is a pure function over a fixture snapshot, which makes it a good candidate for broad unit tests.

---

### CB-10: Retriever for the Contributor conversation and the library overview

**As a** Contributor or library visitor
**I want** the same relevance-first grounding in the contributor conversation and the general library chat
**So that** every corpus-grounded conversation behaves the same way (architecture Q3)

**Priority:** P1
**Depends on:** CB-09

**Acceptance Criteria:**
- **Contributor conversation.** Given brain mode and a contributor `companion` turn, then `contributorSystemPrompt` receives the grounding block from `retrieve.ts`, using the contributor's material and `meta` as the query, in place of `loadWikiContext()`. `extract-insights` and `pathway-draft` still get no corpus (unchanged).
- **General library chat.** Given a library chat with no `pathwayId`, then the system prompt receives the brain catalogue overview (one entry per published pathway, with the count stated as today) plus the grounding block for the pathways selected from the visitor's latest messages. The kickoff turn (empty history) uses the overview only, with no selection call.
- **Usage recording.** Given a library selection call, then it is recorded in `ai_usage` with `area: 'explore'`, and the per-IP rate limit is checked **before** it, as today.

**Test Plan:**
- *Positive (automated):*
  - Extend `tests/api/chat.test.ts`: in brain mode the library overview names 10 pathways and the count line says 10; a follow-up message triggers one selection call.
- *Edge cases (automated):*
  - The kickoff message (empty history) makes no selection call.
  - A contributor whose material matches nothing: the no-match marker is present and the response is a normal stream.
- *Negative cases (automated):*
  - A rate-limited IP gets 429 with **no** Anthropic call at all (the selection is not reached).
  - The selection fails in library mode: the overview-only prompt is used, and `sys_errors` is recorded.
- *Non-functional:*
  - On dev, the average cost of a general library reply is about $0.03 or less (plan estimate). Record it in the PR.

---

### CB-11: Test-set gate and production flip

**As a** Program Team member
**I want** to compare the old and new answers on agreed questions before users see the change
**So that** we only switch when relevance is actually better (business Q2; requirement Assumption 1)

**Priority:** P0
**Depends on:** CB-07, CB-08, CB-09, CB-10

**Acceptance Criteria:**
- **Test set.** Given a test set of about 20 questions, written by the Solution and Program teams, covering all 4 dimensions and 4 stages, **at least 4 questions for each of the three must-have retrieval capabilities** (specific pathway, across pathways, common patterns), plus at least 3 questions that should get a "no matching pathway" answer, then it is stored in `docs/features/cube-brain-knowledge-source/test_set_cube_brain_knowledge_source.md`.
- **Comparison.** Given dev with `KNOWLEDGE_SOURCE=legacy` and then `brain`, when each question is asked in Analyse (and the 5 library-relevant ones in Explore), then both answers are recorded side by side. Each answer is judged relevant or not relevant by a Program Team member who doesn't know which mode produced it.
- **Pass mark.** The pass mark is agreed before the run (open item in the business clarifications).
  - Given the brain mode meets it, then prod gets `KNOWLEDGE_SOURCE=brain` and `BRAIN_BRANCH=main`, after CB-02 is on `main`.
  - If brain mode misses, prod stays on legacy and the findings go back to the plan.
- **Prod cost check.** Given prod has run in brain mode for a week, then average Analyse cost per turn from prod `ai_usage` is recorded next to the dev estimate.

**Test Plan:**
- *Positive (manual, 💲):*
  - Run all questions in both modes on dev and fill the results table.
- *Edge cases:*
  - The "no match" questions: brain mode states absence plainly and does not fall back to general advice.
  - A question that spans two sectors: the answer names both relevant pathways or says what's missing. It never presents the unrelated one as a match.
- *Negative cases:*
  - Stop the brain fetch mid-run by setting `BRAIN_REPO` to a wrong value on dev: answers continue from the saved copy and `sys_errors` shows the fetch failure.
- *Non-functional:*
  - Note the time to first token for 5 turns in each mode. Expect brain mode about 1–3 seconds slower on turns that run a selection.

---

### CB-12: GitHub pull-request operations

**As a** Solution Team engineer
**I want** `lib/github.ts` to create branches, multi-file commits and pull requests in the brain, and merge or close them
**So that** the write path can propose and publish pathways (architecture Q9, Q12)

**Priority:** P0
**Depends on:** CB-06 (brain token)

**Acceptance Criteria:**
- Given `lib/github.ts`, then it exports:
  - `brainCommitFiles(branch, files[], message)`: creates the branch from `BRAIN_BRANCH` if missing, then makes **one** commit with every file (Git Data API: blobs → tree → commit → ref update);
  - `brainOpenOrUpdatePR(branch, title, body)`: returns the existing open PR for that branch if there is one, otherwise opens one into `BRAIN_BRANCH`;
  - `brainMergePR(number)`;
  - `brainClosePR(number)`;
  - `brainGetPR(number)`: state, merged, and the head commit's check status.
- **Errors.** Given any GitHub call fails, then it throws an `Error` carrying the status and endpoint, never the token, so `withErrorHandling`/`logError` records it and scrubs secrets.
- **Branch name.** Given a branch name, then it is `pathway/<slug>`, and the slug has already passed `isValidSlug`.

**Test Plan:**
- *Positive (automated):*
  - Extend `tests/unit/server/github.test.ts` with `fetch` mocked: `brainCommitFiles` with 3 files issues 3 blob creates, 1 tree, 1 commit and 1 ref update, in that order.
  - `brainOpenOrUpdatePR` returns the existing PR when the list call finds one.
- *Edge cases (automated):*
  - The branch already exists: no create-ref call; the commit's parent is the branch head.
  - Merge when GitHub answers 405 (checks not passed): it throws an error flagged as "not mergeable", which CB-16 turns into a 409.
- *Negative cases (automated):*
  - GitHub 401: the thrown message contains no `Bearer` or token text.
  - A slug with `/` never reaches these functions (guarded by the caller; asserted in the CB-14 tests).
- *Live check (💲, manual):*
  - Open, update and close a throwaway PR on the brain's `dev` branch from a script using these functions.

---

### CB-13: Unit extraction and brain-entry rendering

**As a** Contributor
**I want** my pathway's micro-innovations picked out automatically when I send it for review
**So that** new pathways are as findable as existing ones, without waiting on a teammate (requirement item 5; architecture Q8)

**Priority:** P0
**Depends on:** CB-01

**Acceptance Criteria:**
- **Extraction call.** Given `lib/brain/extract.ts`, when `extractBrainEntries(document, pathwayMeta)` runs, then:
  - it makes one `claude-sonnet-4-6` call, streamed internally and awaited with `finalMessage()`, with a forced `brain_entries` tool;
  - the prompt includes the SCHEMA v3 pathway and unit field lists and the MASTERS vocabularies (dimensions, sub-categories, stages, unit types, sectors);
  - its extraction rules come from the brain's `skills/cube-brain/references/ingest-pathway.md` (synthesis test, condition tags, attribution to the contributor), carried into the app as a copied prompt file with a header naming the source file and its brain commit. That way a rule change in the skill is a visible, deliberate re-copy, not silent drift;
  - it returns the pathway entry fields plus a list of units.
  - The call writes one `ai_usage` row (`area: 'contribute'`).
- **Rendering.** Given `lib/brain/entries.ts`, when the result is rendered, then it produces:
  - `documents/<slug>.md`: the assembled document, verbatim;
  - `pathways/<slug>.md`: frontmatter values written as JSON, which is valid YAML; `schema_version: 3`, `lifecycle: published`, `sources` naming the app submission, and today's `first_logged`/`last_updated`;
  - one `units/<slug>-<short-kebab>.md` per unit, with slugs unique against the snapshot and each other;
  - one `activities/` entry, following the brain's activity convention.
- **Vocabulary.** Given an extracted value outside a MASTERS vocabulary, then the renderer leaves that field blank instead of writing the invalid value ("blank beats plausible"), so the brain validator doesn't fail on vocabulary.
- **No document text in errors.** Given extraction fails, or returns no units, then `extractBrainEntries` throws, and the caller commits nothing.

**Test Plan:**
- *Positive (automated):*
  - `tests/unit/lib/brain-entries.test.ts`: rendering a fixture result gives files whose frontmatter parses as YAML (parse with the brain's validator in a manual step; in Vitest, `JSON.parse` each value line), plus a units count equal to the input.
- *Positive (manual, 💲):*
  - Run extraction on the Sahayak for Health document and run `validate_wiki.py` on a branch with the output: it exits 0.
- *Edge cases (automated):*
  - Two units with the same title get distinct slugs (`-2` suffix).
  - A unit slug that already exists in the snapshot gets a suffix.
  - A document with no Section 5 produces no Problem-Solution Pattern units.
- *Negative cases (automated):*
  - The tool result is missing `units`: throws.
  - `dimension: "people"` (not in MASTERS): the field is rendered blank, and a warning is logged.
  - The Anthropic mock throws: throws, with no GitHub mock called (asserted in CB-14).
- *Non-functional:*
  - Cost per extraction is recorded in the CB-14 PR (plan estimate about $0.17).
  - Suggestion: `entries.ts` is pure and is a strong candidate for broad unit tests.

---

### CB-14: Send for review opens a brain pull request

**As a** Contributor (`pathway_contributor`)
**I want** Send for review to propose my pathway to the brain for admin review
**So that** my pathway joins the shared knowledge base once approved, with no GitHub account needed (requirement items 5, 7; W2)

**Priority:** P0
**Depends on:** CB-12, CB-13, CB-08

**Acceptance Criteria:**
- **Unchanged checks.** Given brain mode, when `POST /api/pathways/assemble` runs, then auth, role, membership, own-design, `isValidSlug`, reserved-slug (CB-08) and latest-draft checks run first, exactly as today.
- **Brain mode flow.** Then the route:
  1. builds the assembled document with `applyToolkitAssetFiles` as today;
  2. calls `extractBrainEntries`;
  3. commits everything in one commit to `pathway/<slug>` (`brainCommitFiles`);
  4. opens or updates the PR (`brainOpenOrUpdatePR`), whose description lists the units in readable form;
  5. sets on `pathways`: `content_cache`, `review_requested=true`, `assembled_design_doc_id`, `brain_pr_number`, `brain_pr_url`, `brain_pr_state='open'`, `brain_validation='pending'`.
- **No legacy commit.** Given brain mode, then **no** commit is made to the diffusion-cube repo (`GITHUB_REPO`).
- **Resend.** Given a PR is already open for this pathway, when the contributor sends again, then a new commit is added to the same PR, and the PR number is unchanged.
- **Failure.** Given extraction or GitHub fails, then nothing is written to `pathways`, the contributor sees the generic message, and the error is recorded in `sys_errors`.
- **Response.** Then the response adds `{prUrl, prNumber}`, and the route exports a `maxDuration` long enough for extraction (plan: Non-Functional Impact).
- **Contributor status.** Given the contributor's workspace, when the pathway has `brain_pr_state='open'`, then it shows "awaiting review" as it does today for `review_requested`.
- **Not live yet.** Given only assemble has run, then the pathway is **not** visible in `/explore`, `/wiki` or Analyse, because only a merge publishes it (W2 rule).

**Test Plan:**
- *Positive (automated):*
  - Extend `tests/api/pathways/assemble.test.ts` with a brain-mode branch: GitHub and Anthropic are mocked, the PR helpers are called with a `pathway/<slug>` branch, the `pathways` update carries the PR fields, and `ghWriteFile` is **not** called.
- *Positive (manual, 💲):*
  - On dev, send a test pathway for review: a PR appears on the brain's `dev` branch with document, pathway, units and activity files, and "Validate wiki" runs on it.
- *Edge cases (automated):*
  - The second send with an open PR: the same PR number; `brainOpenOrUpdatePR` returns the existing PR.
  - A pathway with toolkit assets: the document in the commit contains the Section 4 asset links (`applyToolkitAssetFiles`).
- *Negative cases (automated):*
  - An `adopter` without `pathway_contributor` gets 403 before any extraction (unchanged).
  - A member using another user's `designId` gets 403 (unchanged).
  - Extraction throws: 500 with the generic message, no GitHub call, no `pathways` update.
  - The commit succeeds but the PR call throws: 500, and no `pathways` update. The orphan branch is reused on the next send, because `brainCommitFiles` handles an existing branch.
- *Non-functional:*
  - Legacy mode: the existing assemble tests pass unchanged.
  - Invariant: after assemble only, the CB-07 tests confirm the slug is not served.

---

### CB-15: GitHub webhook and the post-merge handler

**As an** admin and Contributor
**I want** the app to react to merges, closes and checks wherever they happen
**So that** status, toolkit assets and the "published" email stay right even when an admin merges on GitHub (requirement item 6; architecture Q11)

**Priority:** P0
**Depends on:** CB-12, CB-05

**Acceptance Criteria:**
- **Signature first.** Given `POST /api/brain/webhook`:
  - when the `X-Hub-Signature-256` HMAC over the raw body doesn't match `GITHUB_WEBHOOK_SECRET` (constant-time compare), then it returns 401 and does nothing else;
  - the route is in the public allow-list in `proxy.ts`, and is exported through `withErrorHandling`.
- **Post-merge handler.** Given a `pull_request` event, action `closed`, `merged: true`, for a PR found in `pathways.brain_pr_number`, then the shared post-merge handler runs:
  - it moves `brain_pr_state` from `open` to `merged` in one conditional update (`where brain_pr_state = 'open'`);
  - only if that update changed a row, it sets `review_requested=false` and `published_design_doc_id`, publishes the toolkit assets listed in the document (`contribution_units.published_at`, the logic moved from `publish/route.ts`), and emails the contributor (`notifyContributor`, moved).
- **Closed without merge.** Given action `closed` with `merged: false`, then `brain_pr_state='closed'` and `review_requested=false`; the pathway is back to draft for the contributor.
- **Checks.** Given a `check_suite` `completed` event for a PR's head commit, then `brain_validation` becomes `passed` or `failed`. On failure, `brain_validation_detail` gets the check's summary text.
- **Push.** Given a `push` to `BRAIN_BRANCH`, then the saved snapshot is refreshed (one `getBrainSnapshot` forced fetch).
- **Other events.** Given an event for an unknown PR, or an event type not handled, then it answers 200 and does nothing.

**Test Plan:**
- *Positive (automated):*
  - `tests/api/brain/webhook.test.ts` with a signed fixture payload: merged → `pathways` updated, the assets update issued, `sendContributionEmail` called once.
- *Edge cases (automated):*
  - The same merged delivery twice (GitHub redelivery): the email is sent **once**, because the second conditional update changes no row.
  - A merge already seen by CB-16's publish route: the webhook makes no second email.
  - `check_suite` for a commit that isn't the PR's head: ignored.
- *Negative cases (automated):*
  - Missing or wrong signature: 401, no Supabase call.
  - Malformed JSON with a valid signature: 400 through `ValidationError`.
  - Email sending throws: the pathway is still marked merged, and the error is logged (best-effort, as today).
- *Live check (💲, manual):*
  - Merge a dev test PR on GitHub, not in the console. Within seconds the admin console shows Published, and the contributor email arrives (dev SMTP).
- *Non-functional:*
  - Extend `tests/proxy/proxy.test.ts`: `/api/brain/webhook` is reachable without a session; other `/api/brain/*` paths are not.

---

### CB-16: Admin Publish (merge), Decline, Resync and console UI

**As an** admin (Program Team)
**I want** to publish, decline and resync from the admin console, and see each review's state
**So that** one approval step governs everything that reaches users (requirement items 6, 7, 12; W2)

**Priority:** P0
**Depends on:** CB-14, CB-15

**Acceptance Criteria:**
- **Publish.** Given brain mode, when an admin calls `POST /api/admin/pathways/publish`, then the route:
  - checks `isAdmin` (unchanged);
  - reads the PR with `brainGetPR`. If it is already merged, it runs the post-merge handler and returns ok. If its checks have not passed, it returns **409** `{error, detail}` with the validation summary. Otherwise it merges, then runs the post-merge handler;
  - does **not** write to `published_pathways` in brain mode.
- **Decline.** Given `POST /api/admin/pathways/decline {pathway_id}` from an admin, then the PR is closed, and `brain_pr_state='closed'` and `review_requested=false`. A non-admin gets 403.
- **Resync.** Given `POST /api/admin/brain/resync` from an admin, then it forces a snapshot fetch, re-reads every `open` PR with `brainGetPR`, applies merged, closed and validation changes through the same handlers, and returns the counts. A non-admin gets 403.
- **Console.** Given `AdminPathwaysPanel` / `AdminPathwayRowCard`, then each awaiting-review row shows:
  - a link to its PR;
  - a validation badge (pending / passed / failed), with the failure detail on failed;
  - **Publish** disabled while validation isn't passed;
  - a **Decline** button with a confirm step.

  The panel header has a **Resync from brain** button. The existing status filter (All / Awaiting review / Published / Draft) keeps working.
- **Legacy mode.** Given legacy mode, then the publish route and the console behave exactly as today.

**Test Plan:**
- *Positive (automated):*
  - Extend `tests/api/admin/pathways-publish.test.ts` with a brain-mode branch: checks passed → the merge is called and the post-merge handler runs.
  - Add `decline.test.ts` and `resync.test.ts`.
  - Extend `tests/features/admin/AdminPathwayRowCard.test.tsx` for the badge, the disabled Publish and the Decline confirm.
- *Edge cases (automated):*
  - The PR was already merged on GitHub when Publish is clicked: no merge call, ok response, no double email.
  - The PR was closed on GitHub: Publish returns 409 "This review was closed". The row shows Draft after Resync.
  - Resync with no open PRs: it returns zero counts and still refreshes the snapshot.
- *Negative cases (automated):*
  - A non-admin calling publish, decline or resync gets 403 with no GitHub call.
  - Checks failed: 409, and the detail text is shown on the card.
  - GitHub down during Publish: 500 with the generic message, and the row stays Awaiting review.
- *Live check (💲, manual):*
  - On dev, Publish a passing test PR from the console. Within about 5 minutes (or straight away after Resync) it appears on `/explore` in brain mode.
- *Non-functional:*
  - The row layout with the new badge and two buttons works at phone width (Tailwind classes already used by the panel; no new tokens).

---

### CB-17: Intent-aware retrieval for the three must-have capabilities

*Added 2026-10-30 (business Q18; architecture plan-review decision).*

**As an** Explorer, Contributor or library visitor
**I want** Cube to understand what kind of question I'm asking and fetch the right pathways for it
**So that**:
1. Cube accurately retrieves specific information from individual pathways based on understood user intent.
2. Cube retrieves relevant answers across multiple pathways for broader user queries.
3. Cube identifies and synthesizes common patterns across multiple pathways for advanced insights.

**Priority:** P0
**Depends on:** CB-09, CB-10

**Acceptance Criteria:**
- **Classification.** Given any new user message (Analyse, Contributor, library general chat), when grounding runs, then the selection call returns a `query_type` (`specific` | `situation` | `broad` | `patterns`), ranked slugs and optional focus dimensions and stages. It runs for **every** new message; there is no grid-hash reuse for companion turns.
- **Specific.** Given a `specific` question naming a pathway in another sector than the person's, then that pathway's full document is in the grounding block (≤2 pathways), labelled with its sector.
- **Situation.** Given a `situation` question, then behaviour is as in CB-09: ≤3 same-sector, same-problem pathways, full documents of the top 2, and the "no matching pathway" marker when none match.
- **Broad.** Given a `broad` question, then up to 6 pathways from any sector contribute their units on the topic (focus dimensions and stages first), each unit labelled with its pathway and sector. The block tells Cube to answer point by point naming the pathway behind each point.
- **Patterns.** Given a `patterns` question, then:
  - the brain's Problem-Solution Patterns touching the selected pathways come first, then units sharing a dimension and stage across ≥2 selected pathways;
  - the block tells Cube to name the pathways behind each pattern, to call a one-pathway finding "a single example", and never to invent a pattern.
- **Unknown slugs and limits.** Unknown slugs are dropped, the per-type limits are enforced, and the units cap is 30 (`specific`/`situation`) or 40 (`broad`/`patterns`).
- **Documents.** Given `analysis-doc` / `executive-summary`, then they reuse the design's last `situation` selection, or select in `situation` mode when there is none.
- **Unchanged rules.** A selection failure falls back to the whole published corpus. The library strips Source Trace. The selection call is recorded in `ai_usage`.

**Test Plan:**
- *Positive (automated, `tests/unit/server/brain-retrieve.test.ts`):* one test per query type asserting what the block contains: documents, units, patterns, sector labels, instructions.
- *Positive (manual, 💲):* the CB-11 test-set questions for each capability on dev, in brain mode.
- *Edge cases:*
  - A `patterns` question where only one pathway shows the lesson: the block marks it as a single example.
  - A `specific` question for a pathway that isn't published: no match marker.
  - Two messages in a row with an unchanged grid but different questions: two selection calls.
- *Negative cases:*
  - A `query_type` outside the enum: treated as `situation`.
  - The selection fails: whole corpus.
  - More slugs than the type's limit: truncated.
- *Non-functional:* record the per-message selection cost on dev `ai_usage` in the PR (expected ~$0.0135 per message on Sonnet).

## Not covered by these stories

- **Removing the legacy path:** `content/wiki/pathways/`, `lib/library-pathways.ts`, `published_pathways` reads, the diffusion-cube commit in assemble, and the `GITHUB_REPO`/`GITHUB_BRANCH` variables. Follow-up after CB-11 passes.
- **Reading the update base from the snapshot.** `pathway-draft` still merges against `content_cache`, so a teammate's direct brain edit can be overwritten by the next contributor update (plan: Risks & Open Items).
- **Haiku 5.5 for the selection call:** an open option, switchable later in `retrieve.ts`.
- **A console button to retire a pathway:** retiring is a brain change approved by an admin.
- **The Claude Chat channel** (Claude Desktop / claude.ai with the `cube-brain` skill): the next release.
- **Moving `content/framework.md` or toolkit asset files** into the brain.
- **Wiki refresh** (`llm-wiki`) for the new env vars, routes, tables and the Vitest suite, which `architecture/testing.md` still says doesn't exist.
- **Periodic reset of the brain's `dev` branch from `main`:** an operational routine, not a story.
