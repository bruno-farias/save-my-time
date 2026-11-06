import { expect, it, vi } from 'vitest';
import { readLines, readSSE } from '../src/lib/streams';

function stream(text: string) {
  return new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode(text)); controller.close(); } });
}
async function collect(values: AsyncIterable<string>) { const result = []; for await (const value of values) result.push(value); return result; }

it.each([
  ['', []], ['\n', ['']], ['first\r\nsecond\r', ['first', 'second']], ['a\rb\n', ['a\rb']],
])('frames empty and final records: %j', async (input, expected) => {
  expect(await collect(readLines(stream(input as string)))).toEqual(expected);
});
it('flushes an incomplete UTF-8 sequence at EOF instead of silently losing it', async () => {
  const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array([0x41, 0xe2])); controller.close(); } });
  expect(await collect(readLines(body))).toEqual(['A�']);
  expect(body.locked).toBe(false);
});
it('ignores SSE metadata, strips only one leading space, and flushes the final event', async () => {
  const input = '\n: heartbeat\nevent: ignored\nid: 7\nretry: 100\ndata:  padded\ndata:unspaced\n\n\ndata: trailing';
  expect(await collect(readSSE(stream(input)))).toEqual([' padded\nunspaced', 'trailing']);
});
it('preserves an empty SSE data event while ignoring empty separators', async () => {
  expect(await collect(readSSE(stream('\n\ndata:\n\n\n')))).toEqual(['']);
});
it('cancels and unlocks the reader when a consumer stops early, even if cancellation rejects', async () => {
  const cancel = vi.fn(async () => { throw new Error('Already disconnected'); });
  const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode('first\nsecond\n')); }, cancel });
  for await (const line of readLines(body)) { expect(line).toBe('first'); break; }
  expect(cancel).toHaveBeenCalledOnce(); expect(body.locked).toBe(false);
});
it('preserves a transport failure and releases the reader', async () => {
  const failure = new Error('Connection reset');
  const body = new ReadableStream<Uint8Array>({ start(controller) { controller.error(failure); } });
  await expect(collect(readLines(body))).rejects.toBe(failure);
  expect(body.locked).toBe(false);
});
it.each(['', '\n'])('rejects oversized stream records with terminator %j', async ending => {
  const body = stream('x'.repeat(2_000_001) + ending);
  await expect(collect(readLines(body)).then(() => undefined)).rejects.toThrow('oversized stream record');
  expect(body.locked).toBe(false);
});
it.each(['', '\n'])('allows a record exactly at the stream limit with terminator %j', async ending => {
  const text = 'x'.repeat(2_000_000);
  expect(await collect(readLines(stream(text + ending)))).toEqual([text]);
});
