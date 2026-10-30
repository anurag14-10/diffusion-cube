# Business Clarifications: Cube-Brain as the Knowledge Source

Business clarifications (`brd-validation`). **Answered 2026-10-30** (two rounds, Anurag Goutam; Q18 added later the same day).

## What we found

- **Why this is being asked.** The requester reports that the assistant's answers are often not relevant to the question. Today the Analyse conversation is given the whole pathway corpus on every turn: every indexed pathway's full document plus every admin-published one, with a single pathway running to about 10K tokens. The public library chat sees one document at a time, so it cannot answer questions that cut across pathways. Nothing picks out only the parts that fit the person's situation.
- **What Cube-Brain already has.** It holds 14 pathways broken into 161 micro-innovation units, each tagged by dimension and stage. It also holds 50 organisations, 10 people, 37 framework concept pages, and the project's decisions, risks and milestones. Every pathway carries a `lifecycle` value: 8 are `published`, the same 8 the app ships, and 6 are `unindexed`, so they are not live in the app (e.g. Amul AI / Sarla Ben, Nivesh Suvidha).
- **The brain is behind the app** (drift check, 2026-10-30 session). Two pathways the app publishes are missing from it: Advanced Citizen Grievances System and Sahayak for Health. Two others are older than the app's copy: CEEW Climate Intelligence and Data DHARA. Eight of its links point to a folder the app removed on 2026-10-20.
- **The brain's own rules say it does not hold full pathway text.** It summarises and links, and the canonical text stays in the app. This requirement reverses that.
- **The brain's approval model:** admins push straight to `main`, everyone else opens a pull request that an admin merges. The repo is currently **public**.
- **Product rules touched:**
  - Nothing goes public without an admin.
  - Source Trace is contributor-only.
  - Answers come from the corpus, and absence is stated plainly.
  - A pathway is relevant only when it is the same sector and the same kind of problem.
  - There are two pathway collections: what the assistant reasons over, and the public library.
- **Roadmap fit:**
  - Partly the charter backlog item "Corpus synthesis process (LLM Wiki approach)" (not started).
  - Groundwork for the **EkStep Contribution via Claude** milestone (15-Dec-26), which needs a Claude Chat channel.
  - Touches W6, the pathway curation lifecycle.
- **Earlier advice reversed.** In an earlier session (2026-10-29) the recommendation was to keep the app on its own repo and database and feed the brain one way only. The requester has chosen the opposite: the brain becomes the source.

## Business questions

| # | Theme | Question | Answer / decision |
|---|-------|----------|-------------------|
| 1 | Goal | What problem does this solve? | **Answered:** the assistant's answers are not relevant. The aim is to stop grounding on the current process and make Cube-Brain the knowledge base everything reads from. |
| 2 | Success | Concrete examples of wrong answers, to use as success criteria? | **Answered: none available**, only "what comes back is not relevant". Waived. Assumed: the team builds its own test set (see Assumptions in the requirement). |
| 3 | Scope | What stays in the database? | **Answered:** the database stays for app data (users, roles, conversations, documents, usage). Knowledge comes from the brain. |
| 4 | Scope | Does "Claude chat via the brain" mean (a) the app's own chat grounded on the brain, or (b) users chatting with the brain in Claude Desktop / claude.ai? | **Answered:** (a) now; (b) later, as a separate release. |
| 5 | Scope | Should the brain hold full pathway text, or only structure plus links? | **Answered:** go with the recommendation. The brain holds the full text and becomes the single source; its own rule changes. |
| 6 | Visibility | The repo is public. Keep it public or make it private? | **Answered:** the requester asked for a recommendation. **Decision: private.** Unapproved drafts and contributor-only Source Trace will live in it as pull requests. Published pathways stay public through the app's library, so the corpus stays open where it matters. |
| 7 | Approval | Is merging the pull request what "publish" means? | **Answered: yes.** Merging is publishing. |
| 8 | Approval | Do teammates' direct edits to the brain reach users without approval? | **Answered: no.** Edits also go live only after admin approval. |
| 9 | Timing | Which phases go in the first release, and is there a deadline? | **Answered: not fixed.** Assumed: this release covers retrieval and ingestion (phases 1 and 2); the Claude Chat channel is later. |
| 10 | Scope | Which surfaces read from the brain? | Waived. Assumed: every surface that shows knowledge (Analyse, library chat, `/explore` cards, `/wiki`, the contributor's "similar pathway" check). |
| 11 | Scope | What may the assistant draw on? | Waived. Assumed: published pathways, their units and patterns, the organisations named in them. Never people pages, decisions, risks or milestones. |
| 12 | Approval | Where does the admin review, and are app admins and brain admins the same people? | Waived. Assumed: the admin console stays the place to review, and Publish there merges the pull request; merging on GitHub counts too. The Program Team needs merge rights. |
| 13 | Journey | What happens when an admin does not approve? | Waived. Assumed: the admin can decline; the pathway goes back to the contributor as a draft, and nothing reaches users. |
| 14 | Lifecycle | Removing a published pathway? | Waived. Assumed: an admin-approved change marks it retired in the brain, and it disappears from the app. No new admin-console button in this release. |
| 15 | Freshness | How soon after merging must a pathway be live? | Waived. Assumed: within a few minutes; today it is instant. |
| 16 | Failure | What do users see if the brain can't be reached? | Waived. Assumed: the app keeps answering from the last copy it had; users notice nothing. |
| 17 | Content | What goes in first? | Waived. Assumed: catch the brain up with the app's 10 live pathways first. Of the 6 brain-only pathways, the 2 unpublished drafts and `test-assets-langchat`, none goes live unless an admin publishes it. |
| 18 | Goal | Which retrieval capabilities are must-haves? *(added by the requester, 2026-10-30)* | **Decided, non-negotiable:** (1) Cube must accurately retrieve specific information from individual pathways based on understood user intent. (2) Cube must retrieve relevant answers across multiple pathways for broader user queries. (3) Cube must identify and synthesize common patterns across multiple pathways for advanced insights. "Relevant to your situation" still means same sector AND same kind of problem; pathways reached through a specific, broad or pattern question may come from other sectors, and Cube says so plainly, as for an adjacent match today. |

## Open items

- **The three must-have retrieval capabilities (Q18)** must each pass the test set before prod switches. The questions per capability are written with the rest of the test set.

- **Success target.** The test-set size and the pass mark need agreeing between the Solution Team and the Program Team before work is judged done.
- **Merge rights.** The Program Team members who publish today need write access to the private brain repo. They may need GitHub accounts. Program Team to confirm.
- **Admin self-edits.** Assumed: an admin's own direct change to the brain counts as approved, as an admin's own Publish does today. Confirm, or require a second admin.
- **The 6 brain-only pathways** (Amul AI / Sarla Ben, Nivesh Suvidha and 4 others). Publishing them would take the live corpus from 10 to 16, towards the ≥20 target for 15-Nov-26. Program Team to decide.
- **Anthropic account.** The charter dated its expiry 28-Oct-2026, which has passed. Confirm it has been renewed or replaced; every assistant feature, this one included, depends on it.

## Technical questions for architecture-plan

- How the app reads the brain: at build time, a cached snapshot refreshed on merge, or live. How "within a few minutes" is met.
- The retrieval method: picking pathways by sector and use case, then units by the grid cells under discussion; any search or index needed.
- Mapping brain entries (frontmatter plus body) to what each prompt mode needs. Keeping Source Trace out of adopter-facing prompts.
- How the app opens, updates and merges pull requests for contributors who have no GitHub account. The token, and its expiry.
- Admin-console Publish → merge. Keeping the console's status (awaiting review / published / draft) in step with pull-request state.
- What happens to `published_pathways`, `pathways.content_cache`, the hard-coded library cards and `content/wiki/pathways/` once the brain is the source. The order of retirement.
- Keeping the current grounding available as a fallback, or for side-by-side comparison, until the brain-based answers are proven.
- Toolkit asset files: they stay in app storage, and brain units link to them.
- The brain's validation (`validate_wiki.py`) on app-opened pull requests, and what happens when validation fails.
- Changes the brain's CONVENTIONS/SCHEMA need for full text, and a schema-version bump with a migrator.
- Making the repo private: the effect on the `cube-brain` skill's fork-based write route for non-collaborators.
