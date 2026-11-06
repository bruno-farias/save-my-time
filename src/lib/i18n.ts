import { useEffect, useSyncExternalStore } from 'react';
import { resolveLanguage, translate } from '../locales/catalog';
let current = resolveLanguage('en');
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
// Mark dynamic labels for extraction without translating before a language is selected.
export const mark = (message: string) => message;
export const t = (message: string, values?: Record<string, string | number>) => translate(current, message, values);
export function useTranslation() { useSyncExternalStore(subscribe, () => current.code, () => current.code); return t; }
export function setInterfaceLanguage(preference: string) {
  const next = resolveLanguage(preference);
  if (typeof document !== 'undefined') { document.documentElement.lang = next.code; document.documentElement.dir = next.direction; }
  if (next.code === current.code) return;
  current = next;
  listeners.forEach(listener => listener());
}
export function useInterfaceLanguage(preference: string) { useEffect(() => setInterfaceLanguage(preference), [preference]); }
