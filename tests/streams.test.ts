import { describe, expect, it } from 'vitest';
import { readLines, readSSE } from '../src/lib/streams';

function body(text: string) {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream<Uint8Array>({ start(controller) { for (const byte of bytes) controller.enqueue(new Uint8Array([byte])); controller.close(); } });
}
describe('incremental framing', () => {
  it('preserves UTF-8 characters, CRLF boundaries, comments, and multiline SSE data', async () => {
    const events = [];
    for await (const value of readSSE(body(': keepalive\r\nevent: message\r\ndata: {"text":\r\ndata: "olá 🙂"}\r\n\r\ndata: [DONE]\r\n\r\n'))) events.push(value);
    expect(events).toEqual(['{"text":\n"olá 🙂"}', '[DONE]']);
  });
  it('keeps a final NDJSON record without a newline', async () => {
    const records = [];
    for await (const value of readLines(body('{"message":"hello"}\n{"done":true}'))) records.push(value);
    expect(records).toHaveLength(2);
    expect(JSON.parse(records[1])).toEqual({ done: true });
  });
});
