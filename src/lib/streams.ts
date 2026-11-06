import { t } from './i18n';
// Streaming bodies can split UTF-8 characters, CRLFs, JSON, and SSE events at
// arbitrary byte boundaries. Decode incrementally and only parse whole records.
export async function* readLines(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let newline: number;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        if (newline > 2_000_000) throw new Error(t('The provider sent an oversized stream record.'));
        yield buffer.slice(0, newline).replace(/\r$/, '');
        buffer = buffer.slice(newline + 1);
      }
      if (buffer.length > 2_000_000) throw new Error(t('The provider sent an oversized stream record.'));
      if (done) { if (buffer) yield buffer.replace(/\r$/, ''); break; }
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

export async function* readSSE(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  let data: string[] = [];
  for await (const line of readLines(body)) {
    if (line === '') { if (data.length) yield data.join('\n'); data = []; }
    else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
  }
  if (data.length) yield data.join('\n');
}
