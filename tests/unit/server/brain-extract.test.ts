import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FAKE_USAGE } from '../../helpers/anthropic-mock';

const anthropic = vi.hoisted(() => ({ stream: vi.fn() }));
vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = { stream: anthropic.stream };
  },
}));
vi.mock('@/lib/ai-usage', () => ({ recordAiUsage: vi.fn() }));

import { recordAiUsage } from '@/lib/ai-usage';
import { extractBrainEntries } from '@/lib/brain/extract';

// Send for review → pathway entry + units from one Claude call (CB-13).

const GOOD = {
  pathway: { name: 'Sahayak', summary: 'A helper.' },
  units: [{ short_name: 'a', name: 'A', unit_type: 'Tactical Decision', unit_text: 'x' }],
};

function replies(message: object | Error) {
  anthropic.stream.mockReturnValue({
    finalMessage: () => (message instanceof Error ? Promise.reject(message) : Promise.resolve(message)),
  });
}

const toolMessage = (input: unknown, extra: object = {}) => ({
  model: 'claude-sonnet-4-6',
  usage: FAKE_USAGE,
  stop_reason: 'tool_use',
  content: [{ type: 'tool_use', id: 't', name: 'brain_entries', input }],
  ...extra,
});

beforeEach(() => {
  anthropic.stream.mockReset();
});

describe('extractBrainEntries', () => {
  it('sends the skill\'s ingest rules and the document, forcing the brain_entries tool', async () => {
    replies(toolMessage(GOOD));
    expect(await extractBrainEntries('# THE-DOCUMENT', { slug: 'sahayak', title: 'Sahayak' })).toEqual(GOOD);
    const args = anthropic.stream.mock.calls[0][0];
    expect(args.tool_choice).toEqual({ type: 'tool', name: 'brain_entries' });
    expect(args.model).toBe('claude-sonnet-4-6');
    const prompt = args.messages[0].content as string;
    expect(prompt).toContain('# THE-DOCUMENT');
    expect(prompt).toContain('synthesis test');
    expect(prompt).toContain('Never copy anything from the Source Trace');
    expect(recordAiUsage).toHaveBeenCalledWith(expect.objectContaining({ mode: 'brain-extract', ok: true }));
  });

  it('offers only the brain\'s vocabularies in the tool schema', async () => {
    replies(toolMessage(GOOD));
    await extractBrainEntries('#', { slug: 's', title: 't' });
    const schema = anthropic.stream.mock.calls[0][0].tools[0].input_schema;
    expect(schema.properties.units.items.properties.dimension.enum).toEqual(['persona', 'solution', 'institution', 'ecosystem']);
    expect(schema.properties.pathway.properties.sector.enum).toContain('Public Health');
  });

  it.each([
    ['no units', toolMessage({ ...GOOD, units: [] }), /no units/],
    ['no pathway', toolMessage({ units: GOOD.units }), /no pathway/],
    ['a text reply', { model: 'm', usage: FAKE_USAGE, stop_reason: 'end_turn', content: [{ type: 'text', text: 'hi' }] }, /no pathway/],
    ['a cut-off reply', toolMessage(GOOD, { stop_reason: 'max_tokens' }), /max_tokens/],
  ])('throws on %s', async (_label, message, error) => {
    replies(message);
    await expect(extractBrainEntries('#', { slug: 's', title: 't' })).rejects.toThrow(error);
  });

  it('records a failed call and rethrows', async () => {
    replies(new Error('overloaded'));
    await expect(extractBrainEntries('#', { slug: 's', title: 't' })).rejects.toThrow('overloaded');
    expect(recordAiUsage).toHaveBeenCalledWith(expect.objectContaining({ mode: 'brain-extract', ok: false }));
  });
});
