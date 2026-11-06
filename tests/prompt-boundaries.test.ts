import { expect, it } from 'vitest';
import { prepareInput, summaryInstruction, summaryLabel, truncateBytes } from '../src/lib/prompts';
import { defaultSettings } from '../src/lib/settings';
import type { ChatMessage, ProviderId } from '../src/lib/types';
import { article } from './fixtures';

const pair = (id: string, answer: string): ChatMessage[] => [
  { id: `${id}-u`, role: 'user', content: id, kind: 'question', status: 'complete' },
  { id: `${id}-a`, role: 'assistant', content: answer, kind: 'question', status: 'complete' },
];
it.each([['short', 60, 'Brief'], ['medium', 150, 'Balanced'], ['long', 300, 'Detailed']] as const)('distinguishes the %s summary size', (length, words, label) => {
  const settings = { ...defaultSettings(), length };
  expect(summaryInstruction(settings)).toContain(`about ${words} words`);
  expect(summaryLabel(settings)).toBe(`${label} summary`);
  settings.language = 'pt'; expect(summaryLabel(settings)).toBe(`${label} summary · Português`);
});
it.each([['ollama', 16_000], ['chrome', 16_000], ['openai', 64_000], ['anthropic', 64_000], ['gemini', 64_000]] as const)('bounds %s source context at %i bytes', (provider, budget) => {
  const settings = { ...defaultSettings(), provider: provider as ProviderId };
  const exact = prepareInput({ ...article, text: 'x'.repeat(budget) }, [], settings);
  expect(exact.sourceText).toHaveLength(budget); expect(exact.notices).toEqual([]);
  const overflow = prepareInput({ ...article, text: 'x'.repeat(budget + 1) }, [], settings);
  expect(overflow.sourceText).toHaveLength(budget); expect(overflow.notices).toHaveLength(1);
});
it('reports extraction truncation and keeps input language separate from the selected output', () => {
  const settings = { ...defaultSettings(), language: 'it' };
  const output = prepareInput({ ...article, language: 'pt', truncated: true }, [], settings);
  expect(output).toMatchObject({ inputLanguage: 'pt', outputLanguage: 'it', kind: 'summary', length: 'medium' });
  expect(output.notices).toHaveLength(1);
  expect(output.system).toContain('Italiano');
  expect(prepareInput({ ...article, language: '' }, [], defaultSettings()).system).toContain('the same language as the article');
  expect(prepareInput({ ...article, language: 'unknown-language' }, [], defaultSettings()).system).toContain('unknown-language');
});
it('keeps the latest complete exchanges in order and trims the current question', () => {
  const messages = [...pair('oldest', 'x'.repeat(6000)), ...pair('middle', 'answer two'), ...pair('newest', 'answer three')];
  const result = prepareInput(article, messages, defaultSettings(), '  current question  ');
  expect(result.turns.slice(2).map(turn => turn.content)).toEqual(['middle', 'answer two', 'newest', 'answer three', 'current question']);
  expect(result.notices).toHaveLength(1); expect(result.kind).toBe('question');
  expect(result.turns[0].content).toContain(article.text);
});
it.each(['ollama', 'openai'] as const)('includes exchanges exactly at the %s history budget', provider => {
  const budget = provider === 'ollama' ? 6000 : 16000;
  const settings = { ...defaultSettings(), provider };
  const messages = pair('q', 'x'.repeat(budget - 2)); // question plus separating newline
  const result = prepareInput(article, messages, settings, 'new');
  expect(result.turns.slice(2)).toHaveLength(3); expect(result.notices).toEqual([]);
  messages[1].content += 'x';
  const overflow = prepareInput(article, messages, settings, 'new');
  expect(overflow.turns).toHaveLength(3); expect(overflow.notices).toHaveLength(1);
});
it('does not treat orphaned, failed, or streaming messages as completed history', () => {
  const messages: ChatMessage[] = [pair('orphan', 'orphan answer')[1], ...pair('failed', 'partial'), ...pair('stream', 'streaming'), ...pair('last', 'complete')];
  messages[2].status = 'error'; messages[4].status = 'streaming';
  expect(prepareInput(article, messages, defaultSettings(), 'next').turns.slice(2).map(t => t.content)).toEqual(['last', 'complete', 'next']);
});
it.each([['abc', 0, ''], ['abc', 3, 'abc'], ['A🙂B', 5, 'A🙂'], ['文A', 2, ''], ['�A', 3, '�']] as const)('truncates %j at %i bytes without damaging complete code points', (text, limit, expected) => {
  expect(truncateBytes(text, limit)).toBe(expected);
});
