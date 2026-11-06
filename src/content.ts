import { extractArticle } from './lib/extract';
import type { ExtractionResult } from './lib/types';

export const result: ExtractionResult = (() => {
  try { return { ok: true, article: extractArticle(document, location.href) }; }
  catch (error) { return { ok: false, error: error instanceof Error ? error.message : 'This page could not be read.' }; }
})();
