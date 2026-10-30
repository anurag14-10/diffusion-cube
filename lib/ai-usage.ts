import { after } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { sessionUserId } from '@/lib/errors';

// SERVER-ONLY. Records each Claude call's area and token counts in ai_usage
// (migration 0036) for the admin Usage page — counts only, never text.

export type UsageArea = 'explore' | 'analyse' | 'contribute';

// The one place internal modes map to the three product areas. `companion`
// and `extract-insights` serve both signed-in flows, so they go by `flow`.
// 'check-similar' is app/api/pathways/check-similar's duplicate-pathway check;
// 'brain-extract' is the unit extraction at Send for review (lib/brain/extract.ts).
export function areaFor(mode: string, flow?: string | null): UsageArea {
  if (mode === 'library') return 'explore';
  if (mode === 'companion' || mode === 'extract-insights') {
    return flow === 'contributor' ? 'contribute' : 'analyse';
  }
  if (mode === 'pathway-draft' || mode === 'asset-reuse' || mode === 'check-similar' || mode === 'brain-extract') {
    return 'contribute';
  }
  return 'analyse';
}

// The SDK's usage block (Message.usage); every field may be missing.
export interface UsageNumbers {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}

// Writes one row once the response has been sent (after()), or
// fire-and-forget outside a request scope. Never throws and never delays the
// caller. The signed-in user is resolved from the session unless given.
export function recordAiUsage(entry: {
  mode: string;
  flow?: string | null;
  model: string;
  usage?: UsageNumbers | null;
  ok: boolean;
  userId?: string | null;
}): void {
  const write = async () => {
    try {
      const userId = entry.userId !== undefined ? entry.userId : await sessionUserId();
      const { error } = await createAdminClient()
        .from('ai_usage')
        .insert({
          user_id: userId,
          area: areaFor(entry.mode, entry.flow),
          mode: entry.mode,
          flow: entry.flow || null,
          model: entry.model,
          input_tokens: entry.usage?.input_tokens ?? null,
          output_tokens: entry.usage?.output_tokens ?? null,
          cache_read_tokens: entry.usage?.cache_read_input_tokens ?? 0,
          cache_creation_tokens: entry.usage?.cache_creation_input_tokens ?? 0,
          ok: entry.ok,
        });
      if (error) console.error('[ai-usage] insert failed:', error.message);
    } catch (err) {
      console.error('[ai-usage] record failed:', err);
    }
  };
  try {
    after(write);
  } catch {
    void write();
  }
}
