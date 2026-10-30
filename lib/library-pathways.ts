// Card-tile data for /explore (the Diffusion Library), ported verbatim from
// the standalone Diffusion Library app's app/lib/pathways.ts. Kept as static
// data (not fetched): this file only carries what the card needs to display.
// The chat backend reads each pathway's full document from the grounding
// corpus, content/wiki/pathways/<id>.md (see lib/library-documents.ts) —
// the library's own content/library-wiki/ copy was removed on 2026-10-20.
export type Stage = 'Explore' | 'Define' | 'Pilot' | 'Scale';

export type Accent = 'coral' | 'yellow' | 'blue' | 'navy';

export type LibraryPathway = {
  /** Matches the filename (minus .md) under content/wiki/pathways/. */
  id: string;
  title: string;
  location: string;
  category: string;
  stage: Stage;
  accent: Accent;
  /** Short, impact-driven hook shown on the tile — not the full context. */
  hook: string;
  /** Sector this pathway belongs to (Agriculture, Livelihoods, etc.). Absent for cross-cutting pathways. */
  sector?: string;
  /** Horizontal technology / approach tags — no sector values. */
  tags: string[];
};

export const libraryPathways: LibraryPathway[] = [
  {
    id: 'mahavistaar',
    title: 'Voice AI for Farmer Advisory — Maharashtra',
    location: 'Maharashtra, India',
    category: 'Voice AI · Agriculture',
    stage: 'Scale',
    accent: 'coral',
    hook: '342,000 farmers dial one number — and now get an answer 180x cheaper than it cost a year ago.',
    sector: 'Agriculture',
    tags: ['Voice AI', 'Government'],
  },
  {
    id: 'bhili-language-enablement',
    title: 'Voice AI for Tribal Language Inclusion — Nandurbar',
    location: 'Nandurbar, Maharashtra',
    category: 'Voice AI · Language Inclusion',
    stage: 'Pilot',
    accent: 'yellow',
    hook: 'A tribal language with zero digital footprint learned to talk back to its own speakers — in about 100 days.',
    tags: ['Voice AI', 'Tribal Inclusion'],
  },
  {
    id: 'blue-dots',
    title: 'AI for Hyperlocal Job Discovery — National',
    location: 'Ghaziabad district, India',
    category: 'AI · Local Economy',
    stage: 'Scale',
    accent: 'blue',
    hook: '₹500 to find a job the old way. ₹10 and a 3-minute phone call the new way.',
    sector: 'Livelihoods',
    tags: ['Discovery', 'District Economy'],
  },
  {
    id: 'ceew-climate-intelligence',
    title: 'AI for Public Health Early-Warning — National',
    location: 'National, India',
    category: 'AI · Public Decision-Making',
    stage: 'Pilot',
    accent: 'navy',
    hook: 'An early-warning system that forecasts dengue outbreaks weeks before the first case shows up.',
    sector: 'Public Health',
    tags: ['Climate', 'Policy'],
  },
  {
    id: 'data-dhara',
    title: 'AI for Government Data Interoperability — National',
    location: 'Nivesh Suvidha',
    category: 'AI · Government Data Infrastructure',
    stage: 'Define',
    accent: 'coral',
    hook: "A PDF is not data — it's a picture of data. This pathway teaches government records to talk to each other.",
    sector: 'Governance',
    tags: ['Data Infrastructure'],
  },
  {
    id: 'voice-ai-for-inclusion',
    title: 'Voice AI — Cross-Deployment Synthesis — Multi-Geography',
    location: 'Cross-deployment synthesis',
    category: 'Voice AI · Horizontal',
    stage: 'Scale',
    accent: 'yellow',
    hook: "9 months to build the first voice deployment. 3 weeks for the fifth. That's what a pathway buys you.",
    tags: ['Voice AI', 'Inclusion', 'Cross-deployment'],
  },
  {
    id: 'voice-ai-adoption-barriers',
    title: 'Voice AI Adoption Barriers — Organizational Readiness',
    location: 'Organizational readiness',
    category: 'Voice AI · Adoption Research',
    stage: 'Explore',
    accent: 'blue',
    hook: "EkStep gave away Voice AI for free. Most organizations still didn't build anything. Here's why.",
    tags: ['Voice AI', 'Organizational Readiness'],
  },
  {
    id: 'african-voice-ai',
    title: 'African Voice AI — Offline-First Voice for Kenya',
    location: 'Kenya',
    category: 'Voice AI · Agriculture',
    stage: 'Pilot',
    accent: 'blue',
    hook: "	Adapting an India-built voice-AI stack (Voicera Africa) for offline-first agricultural advisory in Kenya.",
    tags: ['Voice AI', 'Agriculture', 'Africa'],
  },
  
];

export const libraryStages: Stage[] = ['Explore', 'Define', 'Pilot', 'Scale'];

// Derives an accent colour from a slug, for a card that isn't hard-coded above
// (published_pathways, and every card when KNOWLEDGE_SOURCE=brain), so its
// colour never changes between visits.
export function slugToAccent(slug: string): Accent {
  const accents = ['coral', 'yellow', 'blue', 'navy'] as const;
  const hash = slug.split('').reduce((a, c) => a + c.charCodeAt(0), 0);
  return accents[hash % 4];
}

export const librarySectors: string[] = Array.from(
  new Set(libraryPathways.map((p) => p.sector).filter((s): s is string => !!s))
);

export const libraryTags: string[] = Array.from(
  new Set(libraryPathways.flatMap((p) => p.tags))
).sort();
