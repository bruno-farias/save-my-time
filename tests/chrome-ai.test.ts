import { afterEach, describe, expect, it, vi } from 'vitest';
import { chromeAIStatus, prepareChromeAI, streamChromeAI } from '../src/providers/chrome-ai';
import { input } from './fixtures';

afterEach(() => vi.unstubAllGlobals());
describe('Chrome AI capability handling', () => {
  it('reports unsupported browsers instead of falling back to a cloud provider', async () => {
    vi.stubGlobal('Summarizer', undefined); vi.stubGlobal('LanguageModel', undefined);
    expect(await chromeAIStatus()).toBe('unavailable');
    await expect(streamChromeAI(input(), new AbortController().signal, () => {})).rejects.toThrow('unavailable');
  });
  it('starts both downloads and releases models even if one fails', async () => {
    const destroy = vi.fn();
    vi.stubGlobal('Summarizer', { create: vi.fn().mockResolvedValue({ destroy }) });
    vi.stubGlobal('LanguageModel', { create: vi.fn().mockRejectedValue(new Error('Not supported')) });
    await expect(prepareChromeAI(new AbortController().signal, () => {})).rejects.toThrow('Not supported');
    expect(destroy).toHaveBeenCalledOnce();
  });
  it('surfaces unsupported language pairs without changing the requested language', async () => {
    const availability = vi.fn().mockResolvedValue('unavailable');
    vi.stubGlobal('Summarizer', { availability }); vi.stubGlobal('LanguageModel', {});
    await expect(streamChromeAI({ ...input(), outputLanguage: 'pt' }, new AbortController().signal, () => {})).rejects.toThrow('language combination');
    expect(availability).toHaveBeenCalledWith(expect.objectContaining({ outputLanguage: 'pt' }));
  });
  it('does not silently discard the source when a chat exceeds the context window', async () => {
    const destroy = vi.fn();
    vi.stubGlobal('Summarizer', {});
    vi.stubGlobal('LanguageModel', { availability: async () => 'available', create: async () => ({ measureContextUsage: async () => 10_000, contextUsage: 200, contextWindow: 8_000, destroy }) });
    await expect(streamChromeAI({ ...input(), kind: 'question' }, new AbortController().signal, () => {})).rejects.toThrow('context window');
    expect(destroy).toHaveBeenCalledOnce();
  });
});
