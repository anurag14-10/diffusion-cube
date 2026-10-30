# Test Set: Cube-Brain as the Knowledge Source

The CB-11 test set for the three must-have retrieval capabilities (business Q18), plus questions that should find nothing. Each question's expectation is taken from the brain's own content.

> **Status: first run 2026-10-30.** All 15 passed after two fixes (see "Fixes found by this test"). Done so far: local app, brain mode (`KNOWLEDGE_SOURCE=brain`, brain `dev` branch, 9 published pathways incl. A4KIOSK), through the **public library chat** (no pathway open), judged by the Solution Team.
>
> **Still to do for the CB-11 gate:**
> - the same questions in **Analyse**;
> - a side-by-side run with `KNOWLEDGE_SOURCE=legacy`;
> - judging by the Program Team against an agreed pass mark;
> - at least 4 more questions per capability written by the Program Team.

## How to run it

1. Run the local app in brain mode: `npm run dev`, with `KNOWLEDGE_SOURCE=brain`, `BRAIN_BRANCH=dev` and `BRAIN_GITHUB_TOKEN` in `.env.local`.
2. Ask each question in a new conversation, in the library (`/explore`, no pathway open) and in Analyse.
3. Judge each answer against its expectation. 💲 Each answer is a real Anthropic call.

## Capability 1: specific information from an individual pathway

| # | Question | Expected | Result (2026-10-30) |
|---|---|---|---|
| S1 | How did MahaVISTAAR bring its cost per question down? | From MahaVISTAAR only: ₹9.4 → ₹0.05 (180×), moved off Azure OpenAI to a self-hosted model; input tokens ~80% of spend → prefix caching | ✅ All of it, plus the GPU allocation fix and the ₹2 cr vs ₹18 cr comparison |
| S2 | Which districts did Blue Dots start in? | Dharwad, Karnataka (pioneer, 2024), then Ghaziabad, UP | ✅ Plus 10 months vs 4 months |
| S3 | What two AI systems were built with CEEW? | A conversational climate-data agent (CRAVIS.AI) and a dengue early-warning system | ✅ |
| S4 | Who is the Bhili language enablement work meant to serve? | Dehwali Bhili speakers (10M+), above all tribal women farmers in Nandurbar with least Marathi exposure | ✅ |

## Capability 2: relevant answers across multiple pathways

| # | Question | Expected | Result (2026-10-30) |
|---|---|---|---|
| B1 | How have teams handled working with government departments and data ownership? | Several pathways, each point attributed: Data DHARA (nodal officer, PDFs across 45 departments), MahaVISTAAR (federated ownership, named owners), others | ✅ Data DHARA and MahaVISTAAR, attributed point by point |
| B2 | What have deployments learned about supporting low-resource languages and dialects? | African Voice AI (dialect/register is the low-resource problem), Bhili (8 kHz phone-quality data, fine-tune from Marathi), Voice AI for Inclusion | ✅ African Voice AI and Bhili, attributed |
| B3 | How did different teams deal with data readiness before building the AI? | MahaVISTAAR (5-question source checklist, named owners), Data DHARA ("a PDF is not data"), CEEW | ✅ |
| B4 | What do the pathways say about making voice AI work over phone calls? | MahaVISTAAR (silence/hold message, WebSocket not WebRTC, <30 s opening), Voice AI Adoption Barriers (pickup is an operations problem), African Voice AI (telephony doesn't port) | ✅ |

## Capability 3: common patterns across multiple pathways

| # | Question | Expected | Result (2026-10-30) |
|---|---|---|---|
| P1 | What problems commonly come up across deployments at the Pilot stage? | Patterns that name ≥2 pathways (e.g. integration/operations problems misread as model problems; ownership of quality checks) | ✅ Named Voice AI Adoption Barriers, MahaVISTAAR and others |
| P2 | What patterns repeat across deployments around institutional ownership and governance? | "Name the owner before code" across MahaVISTAAR, Data DHARA, Blue Dots, Bhili; governance deferred → nobody owns it | ✅ |
| P3 | What do the deployments that reached scale have in common? | Shared traits named with their pathways (MahaVISTAAR, Blue Dots, Voice AI for Inclusion) | ✅ |
| P4 | Is there a common pattern across deployments in using prefix caching to cut GPU inference cost? | **A single example, not a pattern**: only MahaVISTAAR documents it | ❌ first run ("not covered anywhere"), then ✅ after fixes: "Honestly, no — that's a single example, not a pattern. Only MahaVISTAAR…" |

## Nothing in the corpus (absence stated plainly)

| # | Question | Expected | Result (2026-10-30) |
|---|---|---|---|
| N1 | Do you have a pathway on AI for fisheries in Kerala? | Says plainly there's none; may offer adjacent pathways, labelled as such | ✅ |
| N2 | How did the Tamil Nadu education department roll out chatbots in schools? | Says plainly there's none | ✅ Offered A4KIOSK as "the closest education-sector pathway" |
| N3 | What did a hospital learn from deploying AI for radiology image triage? | Says plainly there's none; no general medical advice | ✅ |

## Fixes found by this test (2026-10-30)

1. **One-pathway "patterns".** For a pattern question whose answer is in only one pathway, the selection returned no pathways, so Cube said the topic wasn't covered at all.
   - The selection is now told to keep a one-pathway finding.
   - The block tells Cube to call it "a single example, not a pattern".
   - Pattern questions now carry the top pathway's full document.
2. **Details below the summary level.** The selection saw each pathway's one-line summary only, so a detail recorded in a micro-innovation (e.g. MahaVISTAAR's prefix caching) was invisible to it. The catalogue now lists each pathway's micro-innovation names, about 2K extra tokens per selection with today's corpus.

## Notes

- **The brain has no recorded Problem-Solution Patterns yet.** Capability 3 currently comes from Cube synthesising across micro-innovations, under the rule that every pattern names its pathways. Recording patterns in the brain (the `cube-brain` skill's ingest, §3) would make these answers firmer.
- **A4KIOSK appears in answers by design.** It was sent for review from the app and merged into the brain's `dev` branch (PR #2) during testing, so it is published there.
