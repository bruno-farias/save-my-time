import { Readability } from '@mozilla/readability';
import type { Article } from './types';

export const MAX_EXTRACTED_CHARACTERS = 180_000;

export function extractArticle(doc: Document, href: string): Article {
  const url = new URL(href);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Open an article on a regular website to get started. Browser pages and PDFs are not supported.');
  const clone = doc.cloneNode(true) as Document;
  clone.querySelectorAll('script, style, noscript, iframe, canvas, svg, nav, footer, aside, form, input, textarea, select, button, [hidden], [aria-hidden="true"], [contenteditable], [style*="display: none"], [style*="display:none"]').forEach(el => el.remove());
  const parsed = new Readability(clone, { charThreshold: 100 }).parse();
  // Never insert extracted HTML into a document (even a detached element can
  // fetch image resources). Only the plain text leaves this isolated script.
  let text = parsed?.textContent ?? '';
  if (text.trim().length < 100) {
    const fallback = clone.querySelector('article, main, [role="main"]');
    text = fallback?.textContent ?? '';
  }
  text = text.replace(/\r/g, '').replace(/[\t \u00a0]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (text.length < 100) throw new Error('There is not enough article text on this page. Open the full article, wait for it to load, and try again.');
  const wordCount = text.split(/\s+/u).filter(Boolean).length;
  return {
    title: (parsed?.title || doc.title || 'Untitled article').trim().slice(0, 500),
    url: url.href,
    siteName: (parsed?.siteName || url.hostname.replace(/^www\./, '')).slice(0, 200),
    byline: (parsed?.byline || '').slice(0, 200),
    language: (parsed?.lang || doc.documentElement.lang || '').toLowerCase().split('-')[0],
    text: text.slice(0, MAX_EXTRACTED_CHARACTERS),
    wordCount,
    extractedAt: Date.now(),
    truncated: text.length > MAX_EXTRACTED_CHARACTERS,
  };
}
