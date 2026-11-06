import type { Article, GenerationInput, ProviderId } from './lib/types';
import type { ModelOption } from './providers/models';

export function previewModels(provider: Exclude<ProviderId, 'chrome'>): ModelOption[] {
  const models = { ollama: ['llama3.2', 'qwen3:4b', 'gemma3:4b'], openai: ['gpt-4.1', 'gpt-4.1-mini'], anthropic: ['claude-sonnet-4-6', 'claude-opus-4-6'], gemini: ['gemini-3.8-flash', 'gemini-3.1-pro-preview'] };
  return models[provider].map(id => ({ id, name: id }));
}

// Imported only in Vite development mode. Production never returns sample AI
// responses or falls back to a demo after a failed provider request.
export const previewArticle: Article = {
  title: 'The quiet case for doing less',
  url: 'https://fieldnotes.example/the-case-for-doing-less',
  siteName: 'Field Notes', byline: 'An example article', language: 'en',
  wordCount: 1_680, extractedAt: 0, truncated: false,
  text: 'A busy calendar is not the same as a meaningful day. When we leave space between tasks, we give our attention a chance to recover. This article explores how fewer commitments and more deliberate reading can improve the quality of our work. The author suggests choosing one essential task each morning, protecting time for deep concentration, and ending the day by noticing what mattered. These are practical suggestions, not a claim that one routine works for everyone. Rest is part of the process rather than a reward reserved for the end.',
};

export async function previewGenerate(input: GenerationInput, signal: AbortSignal, onDelta: (text: string) => void) {
  const text = input.kind === 'summary'
    ? '**Making room for less can help us pay more attention to what matters.**\n\n- **Choose one essential thing.** Start the day with a clear priority instead of a longer to-do list.\n- **Protect your attention.** Leave space between tasks and make time for uninterrupted work.\n- **Treat rest as part of the process.** A pause can help you return with a clearer perspective.\n- **Make it your own.** The author offers practical suggestions, not a universal productivity formula.\n\nThe takeaway: a meaningful day is measured by what deserves your attention, not how much you fit in.'
    : 'In this example article, the author suggests **choosing one essential task each morning** and protecting uninterrupted time for it.\n\nThe idea is to make room for deliberate attention. The article does not provide research proving that this approach works for everyone.\n\n*This is a sample response in the UI preview. Load the extension to use your selected model.*';
  for (const chunk of text.match(/.{1,18}/gs) || []) {
    signal.throwIfAborted();
    onDelta(chunk);
    await new Promise(resolve => setTimeout(resolve, 22));
  }
}
