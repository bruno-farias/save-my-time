import { Readability } from '@mozilla/readability';
import { expect, it, vi } from 'vitest';
import { extractArticle } from '../src/lib/extract';

const parse = (html = '<main>Fallback article content</main>') => new DOMParser().parseFromString(html, 'text/html');
const content = 'Useful article content, with enough detail to read. '.repeat(4);
function parsed(text = content, extra: Record<string, unknown> = {}) {
  vi.spyOn(Readability.prototype, 'parse').mockReturnValue({ textContent: text, title: '', siteName: '', byline: '', lang: '', ...extra } as never);
}

it('falls back to a main landmark when Readability finds no article', () => {
  vi.spyOn(Readability.prototype, 'parse').mockReturnValue(null);
  for (const tag of ['article', 'main', 'div role="main"']) {
    const closing = tag.split(' ')[0];
    const doc = parse(`<${tag}>${content}</${closing}>`);
    const result = extractArticle(doc, 'https://www.example.com/story');
    expect(result.text).toBe(content.trim()); expect(result.title).toBe('Untitled article');
    expect(result.siteName).toBe('example.com'); expect(result.byline).toBe(''); expect(result.language).toBe('');
  }
});
it('removes hidden and editable data before fallback extraction without changing the original page', () => {
  vi.spyOn(Readability.prototype, 'parse').mockReturnValue(null);
  const privateElements = '<script>PRIVATE_SCRIPT</script><style>PRIVATE_STYLE</style><nav>PRIVATE_NAV</nav><form>PRIVATE_FORM</form><textarea>PRIVATE_EDIT</textarea><span hidden>PRIVATE_HIDDEN</span><span aria-hidden="true">PRIVATE_ARIA</span><div contenteditable>PRIVATE_DRAFT</div><div style="display: none">PRIVATE_CSS</div>';
  const doc = parse(`<main><p>${content}</p>${privateElements}</main>`);
  const before = doc.documentElement.outerHTML;
  const result = extractArticle(doc, 'https://example.com/story');
  expect(result.text).toBe(content.trim()); expect(result.text).not.toContain('PRIVATE_');
  expect(doc.documentElement.outerHTML).toBe(before);
});
it('uses the landmark fallback for a short parser result, but keeps a sufficient result', () => {
  parsed(' '.repeat(120));
  expect(extractArticle(parse(`<main>${content}</main>`), 'https://example.com').text).toBe(content.trim());
  parsed('x'.repeat(100));
  expect(extractArticle(parse(`<main>${content}</main>`), 'https://example.com').text).toBe('x'.repeat(100));
});
it.each([99, 100])('enforces the minimum article length at %i characters', length => {
  parsed('x'.repeat(length));
  const operation = () => extractArticle(parse(`<main>${'x'.repeat(length)}</main>`), 'https://example.com');
  if (length === 99) expect(operation).toThrow('not enough article text');
  else expect(operation().text).toHaveLength(100);
});
it('normalizes whitespace and counts words consistently', () => {
  const sentence = 'Alpha beta gamma delta '.repeat(8).trim();
  parsed(`  \r\n${sentence}\t \u00a0\t extra\n\n\n\n  last\nnext  \n end  `);
  const result = extractArticle(parse(), 'https://example.com');
  expect(result.text).toBe(`${sentence} extra\n\nlast\nnext\nend`);
  expect(result.wordCount).toBe(36);
});
it('bounds metadata, normalizes language, and retains the original source URL', () => {
  parsed(content, { title: `  ${'T'.repeat(501)}  `, siteName: 'S'.repeat(201), byline: 'A'.repeat(201), lang: 'PT-BR' });
  vi.spyOn(Date, 'now').mockReturnValue(12345);
  const result = extractArticle(parse(), 'https://example.com/story?view=reader#section');
  expect(result).toMatchObject({ title: 'T'.repeat(500), siteName: 'S'.repeat(200), byline: 'A'.repeat(200), language: 'pt', extractedAt: 12345, url: 'https://example.com/story?view=reader#section', truncated: false });
});
it('uses document metadata and only strips a leading www hostname prefix', () => {
  parsed();
  const doc = parse('<html lang="IT-it"><head><title>Document title</title></head><body></body></html>');
  expect(extractArticle(doc, 'https://news.www.example.com')).toMatchObject({ title: 'Document title', language: 'it', siteName: 'news.www.example.com' });
});
it.each([180000, 180001])('marks extraction truncation only beyond 180,000 characters: %i', length => {
  parsed('x'.repeat(length));
  const result = extractArticle(parse(), 'https://example.com');
  expect(result.text).toHaveLength(180000); expect(result.truncated).toBe(length > 180000);
});
