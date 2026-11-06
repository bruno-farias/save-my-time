import { defaultSettings } from '../src/lib/settings';
import { prepareInput } from '../src/lib/prompts';
import type { Article } from '../src/lib/types';

export const article: Article = {
  title: 'A quieter way to work', url: 'https://example.com/article', siteName: 'Example', byline: 'Example Author',
  language: 'en', text: 'Protect your attention by choosing one important task. Rest helps people recover. The article offers suggestions, not proof of a universal benefit.',
  wordCount: 26, extractedAt: 1, truncated: false,
};
export const input = () => prepareInput(article, [], defaultSettings());

export { articleHTML } from './article-html';
