/// <reference types="dom-chromium-ai" />
import { t } from '../lib/i18n';
import type { GenerationInput } from '../lib/types';

export async function chromeAIStatus(): Promise<string> {
  if (typeof Summarizer === 'undefined' || typeof LanguageModel === 'undefined') return 'unavailable';
  try {
    const [summary, chat] = await Promise.all([Summarizer.availability(), LanguageModel.availability()]);
    if (summary === 'unavailable' || chat === 'unavailable') return 'unavailable';
    if (summary === 'available' && chat === 'available') return 'available';
    return summary === 'downloading' || chat === 'downloading' ? 'downloading' : 'downloadable';
  } catch { return 'unavailable'; }
}

// Invoke directly from a button: create() may require transient user activation
// when Chrome needs to download its models. Both calls start before awaiting.
export async function prepareChromeAI(signal: AbortSignal, onProgress: (message: string) => void): Promise<void> {
  if (typeof Summarizer === 'undefined' || typeof LanguageModel === 'undefined') throw new Error(t("Chrome AI is not available in this browser. Use a supported desktop Chrome, or choose Ollama."));
  const monitor = (label: string) => (m: CreateMonitor) => m.addEventListener('downloadprogress', event => {
    onProgress(t('{model}: {percent}% downloaded', { model: label, percent: Math.round(event.loaded * 100) }));
  });
  const results = await Promise.allSettled([
    Summarizer.create({ signal, monitor: monitor(t('Summarizer')) }),
    LanguageModel.create({ signal, monitor: monitor(t('Chat model')) }),
  ]);
  for (const result of results) if (result.status === 'fulfilled') result.value.destroy();
  const failed = results.find(r => r.status === 'rejected');
  if (failed?.status === 'rejected') throw failed.reason;
  onProgress(t("Chrome AI is ready. Models are managed by your browser."));
}

async function readTextStream(stream: ReadableStream<string>, signal: AbortSignal, onDelta: (text: string) => void) {
  const reader = stream.getReader();
  let received = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      received += value.length;
      if (received > 60_000) throw new Error(t("The response exceeded the reading limit. Ask for a shorter answer."));
      onDelta(value);
    }
    if (!received) throw new Error(t("Chrome AI returned no text. Try another provider."));
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

export async function streamChromeAI(input: GenerationInput, signal: AbortSignal, onDelta: (text: string) => void): Promise<void> {
  if (typeof Summarizer === 'undefined' || typeof LanguageModel === 'undefined') throw new Error(t("Chrome AI is unavailable in this browser. Choose another provider in settings."));
  if (!input.outputLanguage) throw new Error(t("Choose an output language for Chrome AI. The article does not declare its language."));
  try {
    if (input.kind === 'summary') {
      const options: SummarizerCreateOptions = {
        type: 'key-points', format: 'markdown', length: input.length,
        outputLanguage: input.outputLanguage,
        ...(input.inputLanguage ? { expectedInputLanguages: [input.inputLanguage] } : {}),
      };
      const availability = await Summarizer.availability(options);
      if (availability === 'unavailable') throw new Error(t("Chrome AI cannot summarize this language combination on this device. Choose another language or provider."));
      if (availability !== 'available') throw new Error(t("Prepare Chrome AI in settings first. A model download is required."));
      const summarizer = await Summarizer.create({ ...options, signal });
      try {
        if (typeof summarizer.measureInputUsage === 'function' && await summarizer.measureInputUsage(input.sourceText) > summarizer.inputQuota) throw new Error(t("This article exceeds Chrome AI’s input limit. Choose Ollama or a cloud provider."));
        await readTextStream(summarizer.summarizeStreaming(input.sourceText, { signal }), signal, onDelta);
      }
      finally { summarizer.destroy(); }
    } else {
      const options: LanguageModelCreateOptions = {
        expectedInputs: [{ type: 'text', languages: [...new Set(['en', input.inputLanguage, input.outputLanguage].filter(Boolean))] }],
        expectedOutputs: [{ type: 'text', languages: [input.outputLanguage] }],
      };
      const availability = await LanguageModel.availability(options);
      if (availability === 'unavailable') throw new Error(t("Chrome AI chat cannot use this language combination on this device. Choose another provider."));
      if (availability !== 'available') throw new Error(t("Prepare Chrome AI in settings first. A model download is required."));
      const model = await LanguageModel.create({ ...options, signal, initialPrompts: [{ role: 'system', content: input.system }] });
      try {
        // Reject context overflow rather than silently losing the source article.
        const measure = model.measureContextUsage ?? model.measureInputUsage;
        const usage = await measure.call(model, input.turns);
        const used = model.contextUsage ?? model.inputUsage;
        const quota = model.contextWindow ?? model.inputQuota;
        if (used + usage + 1_024 > quota) throw new Error(t("This article and conversation exceed Chrome AI’s context window. Start a new chat, or use Ollama or a cloud provider."));
        await readTextStream(model.promptStreaming(input.turns, { signal }), signal, onDelta);
      } finally { model.destroy(); }
    }
  } catch (error) {
    if (error instanceof DOMException && error.name === 'NotSupportedError') throw new Error(t("Chrome AI does not support this language or device. Choose another provider."));
    throw error;
  }
}
