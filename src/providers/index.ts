import { t } from '../lib/i18n';
import { streamChromeAI } from './chrome-ai';
import { streamRemote } from './remote';
import { PROVIDERS } from '../lib/settings';
import type { GenerationInput, Settings } from '../lib/types';

export async function generate(settings: Settings, input: GenerationInput, signal: AbortSignal, onDelta: (text: string) => void): Promise<void> {
  const controller = new AbortController();
  let timedOut = false;
  const cancel = () => controller.abort();
  signal.addEventListener('abort', cancel, { once: true });
  if (signal.aborted) controller.abort();
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, 180_000);
  try {
    if (settings.provider === 'chrome') await streamChromeAI(input, controller.signal, onDelta);
    else await streamRemote(settings.provider, settings.providers[settings.provider], input, controller.signal, onDelta);
  } catch (error) {
    if (timedOut) throw new Error(t("The model took longer than 3 minutes. Try a smaller model or a shorter article."));
    if (signal.aborted) throw new DOMException('Stopped', 'AbortError');
    if (error instanceof TypeError) throw new Error(settings.provider === 'ollama'
      ? t('Could not reach Ollama. Check that it is running, the server URL is correct, and the extension origin is allowed. See setup in settings.')
      : t('Could not reach {provider}. Check your connection and provider access in settings.', { provider: PROVIDERS[settings.provider].name }));
    throw error;
  } finally { clearTimeout(timer); signal.removeEventListener('abort', cancel); }
}
