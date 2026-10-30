import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createSupabaseMock, type SupabaseMock } from '../../helpers/supabase-mock';

vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: vi.fn() }));
vi.mock('@/lib/errors', () => ({ sessionUserId: vi.fn(async () => 'session-user') }));

import { createAdminClient } from '@/lib/supabase/admin';
import { sessionUserId } from '@/lib/errors';
import { areaFor, recordAiUsage } from '@/lib/ai-usage';

let admin: SupabaseMock;
const rows = () => admin.ops('ai_usage', 'insert').map((o) => o.payload as Record<string, unknown>);

async function settle(rounds = 5) {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setTimeout(r, 0));
}

beforeEach(() => {
  admin = createSupabaseMock();
  vi.mocked(createAdminClient).mockReturnValue(admin.client);
  vi.mocked(sessionUserId).mockResolvedValue('session-user');
});

describe('areaFor', () => {
  it.each([
    ['library', undefined, 'explore'],
    ['library', 'contributor', 'explore'],
    ['companion', 'explorer', 'analyse'],
    ['companion', 'contributor', 'contribute'],
    ['companion', null, 'analyse'],
    ['companion', '', 'analyse'],
    ['extract-insights', 'contributor', 'contribute'],
    ['extract-insights', 'explorer', 'analyse'],
    ['pathway-draft', undefined, 'contribute'],
    ['asset-reuse', undefined, 'contribute'],
    ['check-similar', undefined, 'contribute'],
    ['brain-extract', undefined, 'contribute'],
    ['explorer-doc', undefined, 'analyse'],
    ['something-new', 'contributor', 'analyse'],
    ['', undefined, 'analyse'],
  ])('maps mode %j / flow %j to %s', (mode, flow, area) => {
    expect(areaFor(mode, flow)).toBe(area);
  });
});

describe('recordAiUsage', () => {
  it('inserts token counts only — no text — for the given user', async () => {
    recordAiUsage({
      mode: 'companion',
      flow: 'contributor',
      model: 'claude-sonnet-4-6',
      usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 10, cache_creation_input_tokens: 5 },
      ok: true,
      userId: 'u1',
    });
    await vi.waitFor(() => expect(rows()).toHaveLength(1));
    expect(rows()[0]).toEqual({
      user_id: 'u1',
      area: 'contribute',
      mode: 'companion',
      flow: 'contributor',
      model: 'claude-sonnet-4-6',
      input_tokens: 100,
      output_tokens: 50,
      cache_read_tokens: 10,
      cache_creation_tokens: 5,
      ok: true,
    });
    expect(sessionUserId).not.toHaveBeenCalled();
  });

  it('resolves the user from the session when userId is not given', async () => {
    recordAiUsage({ mode: 'library', model: 'm', ok: true });
    await vi.waitFor(() => expect(rows()).toHaveLength(1));
    expect(rows()[0].user_id).toBe('session-user');
    expect(sessionUserId).toHaveBeenCalledTimes(1);
  });

  it('records an explicit null user (anonymous) without a session lookup', async () => {
    recordAiUsage({ mode: 'library', model: 'm', ok: true, userId: null });
    await vi.waitFor(() => expect(rows()).toHaveLength(1));
    expect(rows()[0].user_id).toBeNull();
    expect(sessionUserId).not.toHaveBeenCalled();
  });

  it('writes null input/output and 0 cache tokens when usage is missing; empty flow becomes null', async () => {
    recordAiUsage({ mode: 'pathway-draft', flow: '', model: 'm', usage: null, ok: false, userId: 'u' });
    await vi.waitFor(() => expect(rows()).toHaveLength(1));
    expect(rows()[0]).toMatchObject({
      flow: null,
      input_tokens: null,
      output_tokens: null,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
      ok: false,
    });
  });

  it('handles a usage block with null fields', async () => {
    recordAiUsage({
      mode: 'companion',
      model: 'm',
      usage: { input_tokens: null, output_tokens: 3, cache_read_input_tokens: null },
      ok: true,
      userId: 'u',
    });
    await vi.waitFor(() => expect(rows()).toHaveLength(1));
    expect(rows()[0]).toMatchObject({ input_tokens: null, output_tokens: 3, cache_read_tokens: 0 });
  });

  it('never throws when the insert errors', async () => {
    admin = createSupabaseMock({ tables: { ai_usage: { error: { message: 'no table' } } } });
    vi.mocked(createAdminClient).mockReturnValue(admin.client);
    expect(() => recordAiUsage({ mode: 'library', model: 'm', ok: true, userId: 'u' })).not.toThrow();
    await vi.waitFor(() => expect(console.error).toHaveBeenCalledWith('[ai-usage] insert failed:', 'no table'));
  });

  it('never throws when the admin client or session lookup throws', async () => {
    vi.mocked(createAdminClient).mockImplementation(() => {
      throw new Error('no key');
    });
    expect(() => recordAiUsage({ mode: 'library', model: 'm', ok: true, userId: 'u' })).not.toThrow();
    vi.mocked(sessionUserId).mockRejectedValue(new Error('no scope'));
    expect(() => recordAiUsage({ mode: 'library', model: 'm', ok: true })).not.toThrow();
    await settle();
  });

  it('returns synchronously (does not delay the caller)', () => {
    const result = recordAiUsage({ mode: 'library', model: 'm', ok: true, userId: 'u' });
    expect(result).toBeUndefined();
  });
});
