export interface LanguageDefinition {
  code: string;
  name: string;
  nativeName: string;
  direction: 'ltr' | 'rtl';
  interface: boolean;
  messages: Record<string, string>;
}
const files = import.meta.glob<LanguageDefinition>('./languages/*.json', { eager: true, import: 'default' });
export const languages = Object.values(files).sort((a, b) => a.code.localeCompare(b.code));
export const interfaceLanguages = languages.filter(language => language.interface);
export function resolveLanguage(preference: string, browserLanguages: readonly string[] = typeof navigator === 'undefined' ? ['en'] : navigator.languages): LanguageDefinition {
  for (const candidate of preference === 'auto' ? browserLanguages : [preference]) {
    const match = interfaceLanguages.find(language => language.code.toLowerCase() === candidate.toLowerCase())
      || interfaceLanguages.find(language => language.code === candidate.split('-')[0].toLowerCase());
    if (match) return match;
  }
  return languages.find(language => language.code === 'en')!;
}
export function translate(language: LanguageDefinition, message: string, values: Record<string, string | number> = {}): string {
  const translated = Object.hasOwn(language.messages, message) ? language.messages[message] : message;
  return translated.replace(/\{([a-zA-Z][a-zA-Z0-9_]*)\}/g, (placeholder, key: string) => Object.hasOwn(values, key) ? String(values[key]) : placeholder);
}
