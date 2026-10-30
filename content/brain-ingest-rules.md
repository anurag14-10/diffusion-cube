<!--
Copied from the Cube-Brain skill: skills/cube-brain/references/ingest-pathway.md
(sections 2, 3 and 5), anurag14-10/Cube-Brain, branch app-knowledge-source on top of 2f93720.
lib/brain/extract.ts sends these rules to Claude when a contributor's pathway is sent
for review, so units extracted by the app follow the same rules as units ingested with
the skill. When the skill's rules change, re-copy this file deliberately: don't edit it here.
-->

# Rules for turning a pathway document into Cube-Brain units

## 2. Units — one per micro-innovation

For every unit in Section 3 (keep its number in `source_unit_id`):

| Field | How |
|---|---|
| `unit_type` | Exact MASTERS 1 term. A single procedural-sounding decision is a Decision, not a Playbook. A decision about how to structure something is a Decision, not a Toolkit Asset. |
| `dimension`, `sub_category` | The sub-category MUST belong to the dimension (`institution-c` only with `institution`). The dimension's concept page (`concepts/<dimension>.md`) lists its sub-categories, their names and stage weights. All three tags are MASTERS variables (2, 4, 3). |
| `stage` | Stage of ORIGIN — where the evidence came from. This is what counts in the grid. |
| `also_relevant_at` | Retrieval only. Never includes the origin stage. |
| `applies_when` / `fails_when` | The condition tag. Required. `Not documented in the source` if absent — never invent. |
| Decision units | `decision`, `before`, `after` required; `alternative_considered`, `reason`, `context` when stated. |
| Failure and Fix | `failure`, `fix`, `insight` (the structural lesson the fix revealed). |
| Playbook | `steps` in order, with the gate between them; `common_failure_mode`. |
| Toolkit Asset | `purpose`, `reuse_condition`; `asset_kind`/`asset_link`/`share_consent: true` only if an actual file/https link exists and was consented. |
| `adopter_intents` | From the Section 6 retrieval guide entries that point at this unit. |

Slug: `<pathway>-<short-name>` (kebab, ≤ 6 words). Body: `## Unit` ·
`## Condition` · `## Before → after` · `## Why it is reusable`, attributing
the account to the contributor.

Apply **the synthesis test** to each: could someone who never saw the raw
material make a different decision because of it? If not, do not create it.

Section 4 (toolkits & playbooks): create a unit only for rows that are a real
artifact or gated sequence not already captured; otherwise link the existing
unit via `related_units`.

## 3. Patterns

From Section 5 (problem → root cause → solution → result → condition). A
pattern is a unit with `unit_type: Problem-Solution Pattern`, carrying
`problem`, `root_cause`, `solution`, `result`, `condition`, `evidence_units`
and the `pathways` / `dimensions` / `stages` it spans. Grep
`grep -l "^unit_type: Problem-Solution Pattern" units/*.md` first — if the same
problem exists, extend its `evidence_units` and `pathways` instead of creating
a duplicate. Slug `<pathway>-<short-name>`, or `pattern-<short-name>` once it
spans pathways. A pattern with one piece of evidence is fine to record but say
so in the body.

## 5. Never

- Never copy the **Source Trace / Provenance appendix** into any entry — it is
  contributor-only. Record source files only in `sources` / `doc_refs`. The
  verbatim copy in `documents/<slug>.md` is the one place it may appear.
- Never add facts the document does not contain. The brain summarises; it does
  not improve the contributor's account.
- Never use sub-category codes or density symbols in prose meant for adopters.
