import type { LanguageDefinition } from './catalog';

export function placeholders(message: string): string[] {
  return [...new Set([...message.matchAll(/\{([a-zA-Z][a-zA-Z0-9_]*)\}/g)].map(match => match[1]))].sort();
}

// Shared by the repository check and its tests. Translation files are data,
// never code or HTML; React renders every translated string as plain text.
export function validateLanguage(value: unknown, fileCode: string, english: Record<string, string>): string[] {
  const errors: string[] = [];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return ['Expected a JSON object.'];
  const language = value as LanguageDefinition;
  for (const key of Object.keys(value)) if (!['$schema', 'code', 'name', 'nativeName', 'direction', 'interface', 'messages'].includes(key)) errors.push(`Unknown field: ${key}`);
  try {
    if (typeof language.code !== 'string' || Intl.getCanonicalLocales(language.code)[0] !== language.code || language.code === 'auto') throw new Error();
  } catch { errors.push('code must be a canonical BCP 47 language tag, such as pt or pt-BR.'); }
  if (language.code !== fileCode) errors.push('The filename must match code.');
  for (const field of ['name', 'nativeName'] as const) if (typeof language[field] !== 'string' || !language[field].trim()) errors.push(`${field} must be a nonempty string.`);
  if (!['ltr', 'rtl'].includes(language.direction)) errors.push('direction must be ltr or rtl.');
  if (typeof language.interface !== 'boolean') errors.push('interface must be true or false.');
  if (!language.messages || typeof language.messages !== 'object' || Array.isArray(language.messages)) return [...errors, 'messages must be an object.'];
  if (language.interface && !Object.keys(language.messages).length) errors.push('An interface language needs at least one translation.');
  for (const [source, translation] of Object.entries(language.messages)) {
    if (!Object.hasOwn(english, source)) errors.push(`Unknown message: ${source}`);
    if (typeof translation !== 'string' || !translation.trim()) errors.push(`Empty or invalid translation: ${source}`);
    else if (placeholders(source).join(',') !== placeholders(translation).join(',')) errors.push(`Placeholder mismatch: ${source}`);
  }
  return errors;
}
