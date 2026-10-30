# Architecture Clarifications: Cube-Brain as the Knowledge Source

Technical clarifications (`architecture-plan`). **Answered 2026-10-30** (two rounds; Q4 decided on re-ask). Business decisions are
in [`business_clarifications_cube_brain_knowledge_source.md`](business_clarifications_cube_brain_knowledge_source.md).

## Repo findings these questions are based on

- **Whole-corpus grounding.** `loadWikiContext()` in [`lib/wiki-loader.ts`](../../../lib/wiki-loader.ts) injects every indexed pathway document in full on every Analyse turn: the 8 curated files (~174 KB), every `published_pathways` row, and `content/framework.md` (~32 KB). That comes to roughly 55–65K input tokens per turn. Its own comment defers retrieval "once it grows meaningfully". The wiki's ~22K-token figure is stale.
- **Corpus read sites:**
  - `lib/wiki-loader.ts`: Analyse grounding, curated-slug reservation
  - `lib/library-documents.ts`: library chat document and overview
  - `lib/wiki-content.ts`: `/wiki`, `/api/wiki-pathways`, wiki stats
  - `lib/library-pathways.ts`: 8 hard-coded `/explore` cards
  - `app/explore/page.tsx`, `app/explore/ExploreLibrary.tsx`: card merge
  - `app/api/pathways/check-similar/route.ts`: duplicate check
  - `app/admin/page.tsx`: published slugs
  - `app/api/chat/route.ts`: the `library` mode branch, `loadWikiContext`

  `lib/static-content.ts` memoises `content/` files per instance in production.
- **Publish path:**
  - `app/api/pathways/assemble/route.ts` commits the draft to the diffusion-cube repo via [`lib/github.ts`](../../../lib/github.ts). That module uses the Contents API only, on a single `GITHUB_REPO`/`GITHUB_BRANCH`, with no branch, PR or merge support. The route then sets `pathways.content_cache`/`review_requested`.
  - `app/api/admin/pathways/publish/route.ts` upserts into `published_pathways`, marks toolkit assets published (`contribution_units.published_at`), and emails the contributor.
- **No YAML parser** in `package.json`. `lib/strip-frontmatter.ts` is a line-based parser and cannot read the brain's folded multi-line YAML.
- **Brain (`anurag14-10/Cube-Brain`, schema v2):**
  - Pathway entries carry `sector`, `use_case_category`, `coverage` (grid key → density), `lifecycle` (MASTERS 11: drafting / assembled / published / unindexed / retired) and `doc_refs`. The body is a structured summary, not the document.
  - Unit entries carry `pathway`, `unit_type`, `dimension`, `sub_category`, `stage`, `also_relevant_at`, `applies_when`/`fails_when`, `adopter_intents`, `related_units`.
  - CI (`.github/workflows/validate.yml`) runs on push to `main` and on every PR: it rebuilds derived pages and runs `validate_wiki.py`, where errors fail the build.
  - `scripts/build_site.py` already emits `site/data.json`, the whole graph as JSON, with redaction.
- **Invariants kept:**
  - The model never writes to Supabase; persistence stays client-side via `<grid_update>`.
  - Source Trace is stripped before any adopter-facing use (`stripProvenanceAppendix`).
  - The admin publish gate stays; its mechanism becomes the PR merge.
- **Technical debt touched:**
  - TD-05: no retry on any Anthropic call. The new selection and extraction calls match that, failing soft.
  - TD-16: the Anthropic account expiry. The account has been renewed, confirmed 2026-10-30.

## Technical questions

| # | Theme | Question | Answer / decision |
|---|-------|----------|-------------------|
| 1 | Retrieval | Retrieval method: (a) two-step: a small Claude selection call over the brain's pathway catalogue (sector, use case, summary), then units of the selected pathways filtered by the dimension × stage cells under discussion; (b) metadata filter only; (c) embeddings/vector search | **(a)** |
| 2 | Retrieval | Besides units, send the full documents of the top 2–3 selected pathways? | **Yes** |
| 3 | Retrieval | Should the general library chat (no pathway selected) use the same retriever; per-pathway chat keeps one full document, now from the brain? | **Yes** |
| 4 | Sync | How the app reads the brain: CI push to an app endpoint into Supabase cache tables, build-time bundle, or runtime GitHub fetch *(parked from brd-validation)* | **Runtime GitHub fetch** (decided on re-ask, 2026-10-30), over the recommended CI push into DB cache tables and over a build-time bundle. Made safe by: brain CI builds one `snapshot.json` per branch; the app fetches it with a conditional (ETag) request at most once per TTL per server instance; the last good copy is saved in Supabase and served whenever GitHub fails or on a cold start that can't reach it. |
| 5 | Sync | Snapshot JSON built brain-side in Python (reusing `build_site.py`), not a YAML parser added to the app? | **Yes** |
| 6 | Brain schema | Full text in a new `documents/<slug>.md` folder (verbatim, Source Trace included), linked from the pathway's `doc_refs`. Brain schema v3 + migrator + `validate_wiki` change *(parked)* | **Yes** |
| 7 | Brain schema | Optional `card_hook` field on pathway entries for `/explore` cards, seeded with today's 8 hooks; accent derived from slug | **Yes** |
| 8 | Ingestion | Unit extraction for new pathways: (a) one Claude extraction call at Send for review producing the pathway entry + units into the PR; (b) a teammate runs the skill; (c) no units *(parked)* | **(a)** |
| 9 | Ingestion | GitHub identity: GitHub App vs fine-grained PAT *(parked)* | ~~GitHub App~~ → **fine-grained PAT** (changed 2026-10-30, see Plan-review decisions) |
| 10 | Ingestion | Require "Validate wiki" to pass before a PR merges (admins may bypass for direct pushes); the admin console shows the failure and blocks Publish *(parked)* | **Yes** |
| 11 | Ingestion | Detect merges made on GitHub through a webhook (update status, email the contributor); Decline in the console closes the PR *(parked)* | **Yes** |
| 12 | Ingestion | Re-sending while a PR is open adds a commit to the same PR | **Yes** |
| 13 | Rollout | `KNOWLEDGE_SOURCE=legacy\|brain` flag, legacy path kept until the test set passes, cleanup as follow-up work *(parked)* | **Yes** |
| 14 | Environments | Brain `dev` branch for the dev app (reads and PRs), `main` for prod | **Yes** |
| 15 | Assets | Toolkit asset files stay in app storage; brain units link to the app download route *(parked)* | **Yes** |
| 16 | Performance | Accept 1–3 s extra before the reply starts; reuse the previous selection while the grid is unchanged | **Yes** |
| 17 | Dependency | Anthropic account renewed? | **Yes, renewed** (confirmed 2026-10-30) |

## Plan-review decisions

- **2026-10-30: cost question.** Asked whether the plan raises token cost. Measured on dev `ai_usage`: the Analyse turn today costs ~$0.107, ~86% of it cache writes. The plan estimate is ~$0.08–0.095 per Analyse turn, plus a new ~$0.17 per Send for review. Recorded in the plan's Non-Functional Impact.
- **2026-10-30: selection model.** Haiku 5.5 for the selection call was offered; no answer was given, so it stays on `claude-sonnet-4-6` per the plan, recorded as an open option.
- **2026-10-30: plan approved** ("Continue with next process").
- **2026-10-30: no brain schema bump (during CB-01).** The brain's own `skills/cube-brain/references/schema-change.md` says an optional field (`card_hook`) and a non-entity folder (`documents/`) need **no** version bump; a bump is only for a renamed, removed or reshaped field. So the brain stays on schema v2 with no migrator. The plan's "schema v3 + migrator" is superseded. The snapshot carries its own format version (`schema_version: 1`), which is what the app checks.
- **2026-10-30: CEEW Climate Intelligence and Data DHARA were not actually changed (during CB-02).** Their 2026-10-22 grounding files are byte-identical to the library copies the brain was built from (moved by TD-02). Only `doc_refs`/`corpora` needed fixing, with no re-ingest.
- **2026-10-30: snapshot carries `lifecycle` (during CB-06).** Added so the app can re-check `published` (defence in depth), as the plan requires.
- **2026-10-30: PAT instead of a GitHub App (Q9 reversed by the requester).** The app reaches the brain with a fine-grained token, `BRAIN_GITHUB_TOKEN`, limited to `anurag14-10/Cube-Brain` with these permissions:
  - Contents: read & write
  - Pull requests: read & write
  - Actions: read
  - Metadata: read

  It is separate from `GITHUB_TOKEN`. Validation is read from the Actions API (`/actions/runs?head_sha=`) instead of the Checks API, which a fine-grained token may not cover.
  - **Whose token:** a fine-grained token can only reach repos owned by its own account (or its organisation). Since the brain is a personal repo of `anurag14-10`, either:
    - (a) a fine-grained token of `anurag14-10` limited to Cube-Brain (simplest, but PRs show that name); or
    - (b) a classic token (`repo` scope) of a dedicated bot account that is a collaborator on Cube-Brain only. Its reach is then just that repo.

    Moving the brain into a GitHub organisation would allow a bot's fine-grained token.
  - **Accepted costs:** the token expires (max ~1 year) and must be renewed; PRs and commits show that account's name. If it expires, users keep the last snapshot, while Send for review and Publish fail with the generic message (401 in `sys_errors`).
  - **Merge checks:** if the account is a repo admin, GitHub may let it merge past the required check. The app itself merges only after validation has passed.
- **2026-10-30: intent-aware retrieval for the three must-have capabilities** (business Q18). Supersedes the parts of Q1 and Q16 that limited retrieval to ≤3 same-sector pathways and reused a selection while the grid was unchanged.
  - **Query types.** The selection call also classifies the latest message:
    - `specific`: a named or identified pathway; ≤2 pathways, full documents.
    - `situation`: the person's own adoption; ≤3, same sector AND same problem, as before.
    - `broad`: a question across pathways; ≤6, any sector, micro-innovations on the topic.
    - `patterns`: common patterns; ≤6, the brain's Problem-Solution Patterns plus micro-innovations, with synthesis instructions.

    It optionally returns the dimensions and stages the question is about, to order units.
  - **Selection runs on every new user message.** Caching by grid hash would answer a new question with the previous question's pathways. `knowledge_selections` now keeps only the last `situation` pick, for `analysis-doc` / `executive-summary`.
  - **Cost:** +~$0.0135 per message (Sonnet). The Analyse turn estimate stays below today's ~$0.107. Haiku 5.5 for this call remains the open cost option.
  - **Fixed after the first test-set run (2026-10-30, see [`test_set_cube_brain_knowledge_source.md`](test_set_cube_brain_knowledge_source.md)):**
    - The selection catalogue lists each pathway's micro-innovation names, so details below the summary are findable (~2K tokens).
    - A pattern question keeps a one-pathway finding, which Cube calls "a single example".
    - Pattern questions carry the top pathway's document.
  - **The matching rule keeps its meaning** for "relevant to your situation". Pathways reached through a `specific`, `broad` or `patterns` query are labelled with their sector, and the prompt's existing exact/adjacent-match rule applies.
- **2026-10-30: decisions taken during execution** (requester):
  - **Card fields.** The brain pathway also gets optional `card_title` and `card_location` (no schema bump), seeded from `lib/library-pathways.ts`, so the 8 cards keep their titles and places. The card colour is derived from the slug (`slugToAccent`, now shared), so some cards change colour.
  - **Migration 0042** is applied to **dev** (verified: both tables have RLS on with 0 policies, and the 5 `pathways` columns exist). Prod is not touched.
  - **The 2 database-only published pathways** (Advanced Citizen Grievances System, Sahayak for Health) are deferred. They must be ingested before prod switches to `KNOWLEDGE_SOURCE=brain`, or they disappear for users.
  - **`documents/` keeps the full document, Source Trace included**, as planned.

## Open items

_None. All 17 questions are answered (Q4 on re-ask)._
