'use client';

import { useEffect, useRef, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { GENERIC_ERROR_MESSAGE } from '@/lib/error-messages';
import { libraryPathways, libraryStages, type Accent, type LibraryPathway, type Stage } from '@/lib/library-pathways';
import { parseToolkitAssetsTag, stripToolkitAssetsTag } from '@/lib/toolkit-assets';
import ToolkitAssetCards from '@/components/ToolkitAssetCards';
import VoiceInputButton from '@/components/VoiceInputButton';

// toolkitAssets: ids of published toolkit assets an assistant reply offered
// (parsed from its trailing <toolkit_assets> tag, which is never shown) —
// rendered as download cards under that reply and saved with the chat.
// `notice` marks a client-made status bubble (a rejected request) — shown, but
// never sent back to /api/chat as history and never saved.
type ChatMessage = { role: 'user' | 'assistant'; content: string; toolkitAssets?: string[]; notice?: true };
type View = 'library' | 'chat';

// A signed-in visitor's saved chat (library_conversations) — an anonymous
// visitor never has any of these, and their own chats stay purely in-memory.
// Listed in the sidebar's "Recent Explorations" (alongside Analyse
// sessions), not as blocks on this page — reopened here via ?open=<id>,
// resolved server-side into `initialConversation` (see app/explore/page.tsx).
// pathway_slug holds the LibraryPathway's `id` (column name is generic).
interface SavedConversation {
  id: string;
  pathway_slug: string | null;
  pathway_title: string | null;
  messages: ChatMessage[];
}

// Same theme tokens the whole app already uses (bg-coral-soft, text-blue,
// etc. are all defined in globals.css) — the Diffusion Library app these
// cards are ported from pulled its own theme from the same source, so no
// visual adaptation was needed here, only the data plumbing underneath.
const accentGradient: Record<Accent, string> = {
  coral: 'from-[#ff6543] to-[#ffb199]',
  yellow: 'from-[#feda09] to-[#fff3b0]',
  blue: 'from-[#0099ff] to-[#9fd8ff]',
  navy: 'from-[#1b1b42] to-[#6290c3]',
};
const accentText: Record<Accent, string> = {
  coral: 'text-coral',
  yellow: 'text-[#b98e00]',
  blue: 'text-blue',
  navy: 'text-navy',
};
const accentBadge: Record<Accent, string> = {
  coral: 'bg-coral-soft text-coral',
  yellow: 'bg-yellow-soft text-[#8a6b00]',
  blue: 'bg-blue-soft text-blue',
  navy: 'bg-navy/10 text-navy',
};

export default function ExploreLibrary({
  signedIn = false,
  dbPathways = [],
  includeStatic = true,
  initialConversation = null,
}: {
  signedIn?: boolean;
  // False when the cards come from the brain (KNOWLEDGE_SOURCE=brain): then
  // dbPathways is the whole library and the static list is not merged in.
  includeStatic?: boolean;
  // Pathways fetched server-side from published_pathways — merged with the
  // static libraryPathways list, with DB entries taking precedence by slug.
  dbPathways?: LibraryPathway[];
  // Set when this page was opened via ?open=<id> (a sidebar "Recent
  // Explorations" link) — resolved server-side in app/explore/page.tsx.
  initialConversation?: SavedConversation | null;
}) {
  // DB pathways take precedence over static ones with the same slug so a
  // re-published pathway is always the latest version.
  const dbSlugs = new Set(dbPathways.map((p) => p.id));
  const allPathways = includeStatic ? [...dbPathways, ...libraryPathways.filter((p) => !dbSlugs.has(p.id))] : dbPathways;

  const allSectors = Array.from(new Set(allPathways.map((p) => p.sector).filter((s): s is string => !!s)));
  const allTags = Array.from(new Set(allPathways.flatMap((p) => p.tags))).sort();

  const [filterStages, setFilterStages] = useState<Set<Stage>>(new Set());
  const [filterSectors, setFilterSectors] = useState<Set<string>>(new Set());
  const [filterTags, setFilterTags] = useState<Set<string>>(new Set());
  const [popoverOpen, setPopoverOpen] = useState(false);
  const popoverRef = useRef<HTMLDivElement>(null);
  const filterBtnRef = useRef<HTMLButtonElement>(null);
  const [selected, setSelected] = useState<LibraryPathway | null>(
    initialConversation?.pathway_slug
      ? (allPathways.find((p) => p.id === initialConversation.pathway_slug) ?? null)
      : null
  );
  const [messages, setMessages] = useState<ChatMessage[]>(initialConversation?.messages ?? []);
  const [draft, setDraft] = useState('');
  const [isThinking, setIsThinking] = useState(false);
  const [view, setView] = useState<View>(initialConversation ? 'chat' : 'library');
  const bottomRef = useRef<HTMLDivElement>(null);

  // Signed-in only — see SavedConversation's comment. currentConversationId
  // tracks which row (if any) this chat continues, so saves after the first
  // one update in place instead of creating a new row per turn.
  const [currentConversationId, setCurrentConversationId] = useState<string | null>(initialConversation?.id ?? null);

  // Upserts the current conversation for a signed-in visitor — fire-and-
  // forget, called right after each assistant reply finishes so a refresh
  // mid-conversation never loses anything, and so it shows up promptly under
  // the sidebar's "Recent Explorations". Silent on failure: this is a
  // convenience cache, not the primary experience.
  async function saveConversation(history: ChatMessage[], pathway: LibraryPathway | null | undefined) {
    if (!signedIn) return;
    const supabase = createClient();
    if (currentConversationId) {
      await supabase
        .from('library_conversations')
        .update({ messages: history, updated_at: new Date().toISOString() })
        .eq('id', currentConversationId);
      return;
    }
    const { data } = await supabase
      .from('library_conversations')
      .insert({ pathway_slug: pathway?.id ?? null, pathway_title: pathway?.title ?? null, messages: history })
      .select('id')
      .single();
    if (data) setCurrentConversationId(data.id);
  }

  const filtered = allPathways.filter((p) => {
    if (filterStages.size > 0 && !filterStages.has(p.stage)) return false;
    if (filterSectors.size > 0 && (!p.sector || !filterSectors.has(p.sector))) return false;
    if (filterTags.size > 0 && !p.tags.some((t) => filterTags.has(t))) return false;
    return true;
  });

  const activeFilterCount = filterStages.size + filterSectors.size + filterTags.size;

  function toggleStage(stage: Stage) {
    setFilterStages((prev) => {
      const next = new Set(prev);
      next.has(stage) ? next.delete(stage) : next.add(stage);
      return next;
    });
  }
  function toggleSector(sector: string) {
    setFilterSectors((prev) => {
      const next = new Set(prev);
      next.has(sector) ? next.delete(sector) : next.add(sector);
      return next;
    });
  }
  function toggleTag(tag: string) {
    setFilterTags((prev) => {
      const next = new Set(prev);
      next.has(tag) ? next.delete(tag) : next.add(tag);
      return next;
    });
  }
  function clearFilters() {
    setFilterStages(new Set());
    setFilterSectors(new Set());
    setFilterTags(new Set());
  }

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (
        popoverOpen &&
        popoverRef.current &&
        filterBtnRef.current &&
        !popoverRef.current.contains(e.target as Node) &&
        !filterBtnRef.current.contains(e.target as Node)
      ) {
        setPopoverOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [popoverOpen]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages, isThinking]);

  // Streams from this app's own /api/chat (mode: 'library'), a lightweight
  // Q&A prompt with no grid/flow tracking (see librarySystemPrompt in
  // lib/system-prompts.ts), unlike the tracked, persisted Explorer/
  // Contributor conversations. `pathway` (not just its title) is threaded
  // through explicitly rather than read from `selected` state here, so
  // saveConversation always gets the pathway this exact turn belongs to,
  // never a stale value from a state update that hasn't landed yet.
  // Streams a reply for `history` (the full conversation so far, including
  // the just-added user turn — or empty, for the pathway kickoff below).
  // `pathwayId`, not just its title, is threaded through and resent every
  // turn — matches the original backend, which stays grounded in that one
  // pathway's full document for the whole conversation, not just the first
  // message.
  async function streamReply(history: ChatMessage[], pathwayId: string | undefined, pathway: LibraryPathway | null) {
    setMessages([...history, { role: 'assistant', content: '' }]);
    setIsThinking(true);
    // What has streamed in so far — kept if the reply breaks off partway.
    let text = '';
    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // Only role/content go to the model — never UI-only fields like toolkitAssets.
        body: JSON.stringify({
          messages: history.filter((m) => !m.notice).map(({ role, content }) => ({ role, content })),
          mode: 'library',
          pathwayId,
        }),
      });
      // A rejected request comes back as JSON, not a stream — show a plain
      // notice instead of rendering that JSON as Cube's reply. For a 400/429
      // the visitor's message is taken back out of the conversation and
      // returned to the input box, so the next send doesn't resend it.
      if (!res.ok) {
        const last = history[history.length - 1];
        const giveBack = (res.status === 400 || res.status === 429) && last?.role === 'user' ? last : null;
        let notice: string;
        if (res.status === 429) {
          notice = 'Too many requests. Please try again later.';
        } else if (res.status === 400) {
          notice = "Your message couldn't be sent. Please shorten it or start a new chat.";
        } else if (res.status < 500) {
          const body = await res.json().catch(() => null);
          notice = typeof body?.error === 'string' ? body.error : GENERIC_ERROR_MESSAGE;
        } else {
          notice = GENERIC_ERROR_MESSAGE;
        }
        if (giveBack) setDraft(giveBack.content);
        setMessages([...(giveBack ? history.slice(0, -1) : history), { role: 'assistant', content: notice, notice: true }]);
        return;
      }
      if (!res.body) throw new Error('No response body');

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let firstChunk = true;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
        if (firstChunk) {
          firstChunk = false;
          setIsThinking(false);
        }
        // Hide the <toolkit_assets> tag from the moment it starts streaming.
        setMessages([...history, { role: 'assistant', content: stripToolkitAssetsTag(text) }]);
      }
      const assetIds = parseToolkitAssetsTag(text);
      const reply: ChatMessage = {
        role: 'assistant',
        content: stripToolkitAssetsTag(text),
        ...(assetIds.length ? { toolkitAssets: assetIds } : {}),
      };
      setMessages([...history, reply]);
      void saveConversation([...history.filter((m) => !m.notice), reply], pathway);
    } catch {
      // Couldn't reach the server, or the reply broke off partway: keep what
      // arrived, put the generic message under it, and don't save the turn.
      const partial = stripToolkitAssetsTag(text).trim();
      setMessages([
        ...history,
        {
          role: 'assistant',
          content: partial ? `${partial}\n\n${GENERIC_ERROR_MESSAGE}` : GENERIC_ERROR_MESSAGE,
          notice: true,
        },
      ]);
    } finally {
      setIsThinking(false);
    }
  }

  function sendMessage(text: string, options?: { pathway?: LibraryPathway | null; historyOverride?: ChatMessage[] }) {
    const trimmed = text.trim();
    if (!trimmed) return;
    const base = options?.historyOverride ?? messages;
    const next = [...base, { role: 'user' as const, content: trimmed }];
    setDraft('');
    void streamReply(next, options?.pathway?.id, options?.pathway ?? null);
  }

  // Starts a library-wide conversation without selecting a single pathway.
  // The API uses the overview prompt in this mode, so the assistant can help
  // the user orient across multiple adoptions before narrowing to one.
  function startLibraryConversation(text: string) {
    const trimmed = text.trim();
    if (!trimmed) return;
    setSelected(null);
    setMessages([]);
    setCurrentConversationId(null);
    setView('chat');
    sendMessage(trimmed, { pathway: null, historyOverride: [] });
  }

  // Opening a pathway shows only the assistant's kickoff overview — no
  // "Tell me about X" user bubble — matching the original library exactly:
  // an empty message history plus pathwayId elicits the fixed kickoff turn
  // server-side (see LIBRARY_KICKOFF_PROMPT in lib/system-prompts.ts).
  function startPathwayChat(pathway: LibraryPathway) {
    setSelected(pathway);
    setView('chat');
    setMessages([]);
    setCurrentConversationId(null);
    void streamReply([], pathway.id, pathway);
  }

  if (view === 'chat') {
    return (
      <ChatView
        selected={selected}
        messages={messages}
        draft={draft}
        setDraft={setDraft}
        isThinking={isThinking}
        bottomRef={bottomRef}
        onSend={(text) => sendMessage(text, { pathway: selected })}
        onBack={() => setView('library')}
      />
    );
  }

  return (
    <div className="animate-fade-in flex-1 overflow-y-auto bg-paper">
      <section className="mx-auto flex max-w-6xl flex-col items-center px-6 pt-12 pb-10 text-center sm:pt-16 sm:pb-14">
        <p className="font-mono text-xs uppercase tracking-[0.2em] text-coral">Explore</p>
        <h1 className="mt-4 max-w-3xl font-display text-4xl font-medium leading-[1.1] tracking-tight text-navy sm:text-5xl">
          Every deployment adds new evidence.{' '}
          <span className="font-serif italic text-coral">Every adopter</span> begins further ahead.
        </h1>
        <p className="mt-6 max-w-2xl text-base leading-relaxed text-ink-soft sm:text-lg">
          A use case shows what worked in one place. A pathway captures what can travel to the next — and what has to
          be adapted. Browse the deployments below.
        </p>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            startLibraryConversation(draft);
          }}
          className="glow-input mt-8 flex w-full max-w-2xl items-end gap-3 rounded-2xl border border-navy/10 bg-white p-2 text-left shadow-sm"
        >
          <ComposerTextarea
            value={draft}
            onChange={setDraft}
            onSubmit={() => startLibraryConversation(draft)}
            placeholder="Ask about what multiple adoptions have learned…"
            className="min-h-11 flex-1 resize-none bg-transparent px-4 py-2.5 text-[15px] outline-none placeholder:text-ink-soft"
            minHeight={24}
            maxHeight={120}
          />
          <VoiceInputButton value={draft} onChange={setDraft} className="h-12 w-12" />
          <SendButton disabled={!draft.trim() || isThinking} size="lg" />
        </form>
        <p className="mt-3 text-xs text-ink-soft">Start with a question, then follow the thread into a specific pathway.</p>
      </section>

      <section className="mx-auto max-w-6xl px-6 pb-24">
        <p className="mb-4 font-mono text-xs uppercase tracking-[0.2em] text-coral">Browse the library</p>

        <div className="mb-6">
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative">
              <button
                ref={filterBtnRef}
                type="button"
                onClick={() => setPopoverOpen((o) => !o)}
                className={`inline-flex items-center gap-2 rounded-full border px-4 py-1.5 text-sm font-medium transition ${
                  activeFilterCount > 0
                    ? 'border-navy bg-navy text-paper'
                    : 'border-navy/15 bg-white text-navy hover:border-navy/40'
                }`}
              >
                <svg width="15" height="15" viewBox="0 0 15 15" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
                  <path d="M1 3h13M3 7.5h9M5.5 12h4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                </svg>
                Filter
                {activeFilterCount > 0 && (
                  <span className="flex h-4 w-4 items-center justify-center rounded-full bg-coral text-[10px] font-semibold text-white">
                    {activeFilterCount}
                  </span>
                )}
              </button>

              {popoverOpen && (
                <div
                  ref={popoverRef}
                  className="absolute left-0 top-[calc(100%+8px)] z-20 w-72 rounded-2xl border border-navy/10 bg-white p-4 shadow-lg"
                >
                  <div className="mb-3">
                    <p className="mb-2 font-mono text-[10px] uppercase tracking-[0.15em] text-ink-soft">Stage</p>
                    <div className="flex flex-wrap gap-1.5">
                      {libraryStages.map((stage) => (
                        <button
                          key={stage}
                          type="button"
                          onClick={() => toggleStage(stage)}
                          className={`rounded-full border px-3 py-1 text-xs font-medium transition ${
                            filterStages.has(stage)
                              ? 'border-navy bg-navy text-paper'
                              : 'border-navy/15 bg-white text-navy hover:border-navy/40'
                          }`}
                        >
                          {stage}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="my-3 border-t border-navy/8" />

                  <div className="mb-3">
                    <p className="mb-2 font-mono text-[10px] uppercase tracking-[0.15em] text-ink-soft">Sector</p>
                    <div className="flex flex-wrap gap-1.5">
                      {allSectors.map((sector) => (
                        <button
                          key={sector}
                          type="button"
                          onClick={() => toggleSector(sector)}
                          className={`rounded-full border px-3 py-1 text-xs font-medium transition ${
                            filterSectors.has(sector)
                              ? 'border-navy bg-navy text-paper'
                              : 'border-navy/15 bg-white text-navy hover:border-navy/40'
                          }`}
                        >
                          {sector}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="my-3 border-t border-navy/8" />

                  <div>
                    <p className="mb-2 font-mono text-[10px] uppercase tracking-[0.15em] text-ink-soft">Tags</p>
                    <div className="flex flex-wrap gap-1.5">
                      {allTags.map((tag) => (
                        <button
                          key={tag}
                          type="button"
                          onClick={() => toggleTag(tag)}
                          className={`rounded-full border px-3 py-1 text-xs font-medium transition ${
                            filterTags.has(tag)
                              ? 'border-navy bg-navy text-paper'
                              : 'border-navy/15 bg-white text-navy hover:border-navy/40'
                          }`}
                        >
                          {tag}
                        </button>
                      ))}
                    </div>
                  </div>

                  {activeFilterCount > 0 && (
                    <div className="mt-4 flex items-center justify-between border-t border-navy/8 pt-3">
                      <button
                        type="button"
                        onClick={clearFilters}
                        className="text-xs text-ink-soft transition hover:text-coral"
                      >
                        Clear all
                      </button>
                      <button
                        type="button"
                        onClick={() => setPopoverOpen(false)}
                        className="rounded-full bg-navy px-3 py-1 text-xs font-medium text-paper transition hover:bg-coral"
                      >
                        Done
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>

            {[...filterStages].map((s) => (
              <ActiveFilterChip key={s} label={s} onRemove={() => toggleStage(s)} />
            ))}
            {[...filterSectors].map((s) => (
              <ActiveFilterChip key={s} label={s} onRemove={() => toggleSector(s)} />
            ))}
            {[...filterTags].map((t) => (
              <ActiveFilterChip key={t} label={t} onRemove={() => toggleTag(t)} />
            ))}
          </div>
        </div>

        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {filtered.map((pathway) => (
            <PathwayCard key={pathway.id} pathway={pathway} selected={selected?.id === pathway.id} onSelect={startPathwayChat} />
          ))}
        </div>
      </section>
    </div>
  );
}

function PathwayCard({
  pathway,
  selected,
  onSelect,
}: {
  pathway: LibraryPathway;
  selected: boolean;
  onSelect: (pathway: LibraryPathway) => void;
}) {
  const initial = pathway.title.charAt(0);

  return (
    <button
      type="button"
      onClick={() => onSelect(pathway)}
      className={`group flex flex-col overflow-hidden rounded-2xl border bg-white text-left shadow-sm transition hover:-translate-y-1 hover:shadow-lg ${
        selected ? 'border-coral ring-2 ring-coral/40' : 'border-navy/10'
      }`}
    >
      <div className={`relative flex h-36 items-center justify-center bg-gradient-to-br ${accentGradient[pathway.accent]}`}>
        <span className="font-display text-6xl font-semibold text-white/25">{initial}</span>
        <span className="absolute right-3 top-3 rounded-full bg-white/85 px-3 py-1 text-xs font-medium text-navy">
          {pathway.stage}
        </span>
      </div>

      <div className="flex flex-1 flex-col gap-3 p-5">
        <div>
          <h3 className="font-display text-lg font-medium text-navy">{pathway.title}</h3>
          <p className={`mt-0.5 text-xs font-medium ${accentText[pathway.accent]}`}>{pathway.sector || pathway.category}</p>
          <p className="text-xs text-ink-soft">{pathway.location}</p>
        </div>

        <p className="flex-1 text-sm font-medium leading-relaxed text-navy">{pathway.hook}</p>

        <div className="flex flex-wrap gap-1.5 pt-1">
          {pathway.tags.map((tag) => (
            <span key={tag} className={`rounded-full px-2.5 py-1 text-[11px] font-medium ${accentBadge[pathway.accent]}`}>
              {tag}
            </span>
          ))}
        </div>

        <span className="mt-1 inline-flex items-center gap-1 text-sm font-medium text-navy group-hover:text-coral">
          Ask about this pathway
          <span aria-hidden className="transition group-hover:translate-x-0.5">
            →
          </span>
        </span>
      </div>
    </button>
  );
}

function ChatView({
  selected,
  messages,
  draft,
  setDraft,
  isThinking,
  bottomRef,
  onSend,
  onBack,
}: {
  selected: LibraryPathway | null;
  messages: ChatMessage[];
  draft: string;
  setDraft: (v: string) => void;
  isThinking: boolean;
  bottomRef: React.RefObject<HTMLDivElement | null>;
  onSend: (text: string) => void;
  onBack: () => void;
}) {
  return (
    <div className="animate-fade-in-up flex flex-1 flex-col overflow-hidden bg-paper">
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-5xl px-6 pt-6">
          <button
            type="button"
            onClick={onBack}
            className="mb-6 inline-flex w-fit items-center gap-1.5 text-sm font-medium text-navy transition hover:gap-2.5 hover:text-coral"
          >
            <span aria-hidden className="transition-transform">
              ←
            </span>{' '}
            Back to library
          </button>

          {selected ? (
            <div className="mb-6 flex items-center gap-3 border-b border-navy/10 pb-6">
              <div
                className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br text-base font-semibold text-white ${accentGradient[selected.accent]}`}
              >
                {selected.title.charAt(0)}
              </div>
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h1 className="font-display text-lg font-medium text-navy">{selected.title}</h1>
                  <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${accentBadge[selected.accent]}`}>
                    {selected.stage}
                  </span>
                </div>
                <p className={`text-xs font-medium ${accentText[selected.accent]}`}>
                  {selected.category} · {selected.location}
                </p>
              </div>
            </div>
          ) : (
            <div className="mb-6 border-b border-navy/10 pb-6">
              <h1 className="font-display text-lg font-medium text-navy">Ask the Diffusion Library</h1>
              <p className="text-xs text-ink-soft">A general question — not tied to one pathway yet</p>
            </div>
          )}
        </div>

        <div className="mx-auto flex max-w-5xl flex-col gap-6 px-6 pb-8">
          {messages.map((m, i) => (
            <div
              key={i}
              className={`animate-fade-in-up max-w-[80%] rounded-2xl px-5 py-3 text-[15px] leading-relaxed ${m.role === 'user' ? 'ml-auto bg-coral text-white' : 'mr-auto bg-paper-dim text-ink'
                }`}
            >
              <MessageText content={m.content} />
              {m.role === 'assistant' && m.toolkitAssets?.length && selected ? (
                <ToolkitAssetCards ids={m.toolkitAssets} pathwaySlug={selected.id} />
              ) : null}
            </div>
          ))}
          {isThinking && (
            <div className="animate-fade-in-up mr-auto flex items-center gap-1.5 rounded-2xl bg-paper-dim px-5 py-4">
              <span className="animate-bounce-dot h-1.5 w-1.5 rounded-full bg-ink-soft [animation-delay:0ms]" />
              <span className="animate-bounce-dot h-1.5 w-1.5 rounded-full bg-ink-soft [animation-delay:150ms]" />
              <span className="animate-bounce-dot h-1.5 w-1.5 rounded-full bg-ink-soft [animation-delay:300ms]" />
            </div>
          )}
          <div ref={bottomRef} />
        </div>
      </div>

      <div className="shrink-0 border-t border-navy/10 bg-paper/90 px-6 py-4 backdrop-blur-sm">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            onSend(draft);
          }}
          className="mx-auto flex max-w-5xl items-end gap-3 rounded-2xl border border-navy/15 bg-white p-2 shadow-sm transition focus-within:border-coral"
        >
          <ComposerTextarea
            value={draft}
            onChange={setDraft}
            onSubmit={() => onSend(draft)}
            placeholder="Ask a follow-up…"
            className="flex-1 resize-none bg-transparent px-4 py-2.5 text-[15px] outline-none placeholder:text-ink-soft"
            minHeight={24}
            maxHeight={160}
          />
          <VoiceInputButton value={draft} onChange={setDraft} />
          <SendButton disabled={!draft.trim() || isThinking} />
        </form>
      </div>
    </div>
  );
}

/** Renders **bold** markers as <strong> — the only inline markdown supported here. */
function renderBold(text: string) {
  const segments = text.split(/(\*\*[^*]+\*\*)/g).filter(Boolean);
  return segments.map((segment, i) =>
    segment.startsWith('**') && segment.endsWith('**') ? (
      <strong key={i} className="font-semibold">
        {segment.slice(2, -2)}
      </strong>
    ) : (
      <span key={i}>{segment}</span>
    )
  );
}

function MessageText({ content }: { content: string }) {
  const paragraphs = content
    .split(/\n+/)
    .map((p) => p.trim())
    .filter(Boolean);

  return (
    <>
      {paragraphs.map((paragraph, i) => (
        <p key={i} className={i === 0 ? undefined : 'mt-3'}>
          {renderBold(paragraph)}
        </p>
      ))}
    </>
  );
}

// Auto-growing textarea — Enter sends, Shift+Enter inserts a newline and
// lets the box grow (same idiom as ChatPanel's own composer).
function ComposerTextarea({
  value,
  onChange,
  onSubmit,
  placeholder,
  className,
  minHeight,
  maxHeight,
}: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  placeholder: string;
  className: string;
  minHeight: number;
  maxHeight: number;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(Math.max(el.scrollHeight, minHeight), maxHeight)}px`;
  }, [value, minHeight, maxHeight]);

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      onSubmit();
    }
  }

  return (
    <textarea
      ref={ref}
      rows={1}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={handleKeyDown}
      placeholder={placeholder}
      style={{ height: minHeight, maxHeight }}
      className={className}
    />
  );
}

function SendButton({ disabled, size = 'md' }: { disabled: boolean; size?: 'md' | 'lg' }) {
  const dim = size === 'lg' ? 'h-12 w-12' : 'h-11 w-11';
  const icon = size === 'lg' ? 18 : 16;
  return (
    <button
      type="submit"
      disabled={disabled}
      aria-label="Send"
      className={`flex ${dim} shrink-0 items-center justify-center rounded-full bg-navy text-paper transition hover:scale-105 hover:bg-coral active:scale-95 disabled:opacity-30 disabled:hover:scale-100`}
    >
      <svg width={icon} height={icon} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path
          d="M8 13V3M8 3L3.5 7.5M8 3L12.5 7.5"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </button>
  );
}

function ActiveFilterChip({ label, onRemove }: { label: string; onRemove: () => void }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-navy/12 bg-navy/6 px-3 py-1.5 text-sm font-medium text-navy">
      {label}
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove ${label} filter`}
        className="leading-none text-navy/40 transition hover:text-coral"
      >
        ×
      </button>
    </span>
  );
}
