import { describe, expect, it } from 'vitest';
import { extractArticle, MAX_EXTRACTED_CHARACTERS } from '../src/lib/extract';
import { articleHTML } from './fixtures';

describe('article extraction', () => {
  it('reads the article while excluding navigation, forms, and hidden text, without changing the page', () => {
    const doc = new DOMParser().parseFromString(articleHTML, 'text/html');
    const before = doc.documentElement.outerHTML;
    const article = extractArticle(doc, 'https://example.com/article');
    expect(article.title).toBe('A quieter way to work');
    expect(article.text).toContain('Rest is part of the process');
    expect(article.text).not.toMatch(/UNWANTED|SECRET_HIDDEN|PRIVATE_/);
    expect(article.language).toBe('en');
    expect(article.wordCount).toBeGreaterThan(80);
    expect(doc.documentElement.outerHTML).toBe(before);
  });
  it('rejects restricted URLs and pages without enough article text', () => {
    const doc = new DOMParser().parseFromString('<p>Hello</p>', 'text/html');
    expect(() => extractArticle(doc, 'chrome://extensions')).toThrow('regular website');
    expect(() => extractArticle(doc, 'https://example.com')).toThrow('not enough article text');
  });
  it('bounds extracted content and makes truncation explicit', () => {
    const doc = new DOMParser().parseFromString(`<article><p>${'The article is long. '.repeat(12_000)}</p></article>`, 'text/html');
    const article = extractArticle(doc, 'https://example.com');
    expect(article.text.length).toBe(MAX_EXTRACTED_CHARACTERS);
    expect(article.truncated).toBe(true);
  });
});
