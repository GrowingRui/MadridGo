// Spanish and English. The app follows the device language (Spanish for es, ca, gl and eu;
// English for everything else) unless the user picks one in More; the choice is stored only on
// this device. The server answers in the same language (Accept-Language, api/client.ts).
//
// Components read texts with useT(), which re-renders them when the language changes. Plain
// functions (utils/time.ts, utils/trainPosition.ts) call t() directly: they run while a
// component that uses useT() renders.

import AsyncStorage from '@react-native-async-storage/async-storage';
import { getLocales } from 'expo-localization';
import { useEffect, useSyncExternalStore } from 'react';
import { Platform } from 'react-native';

import { en, type MessageKey } from './en';
import { es } from './es';

export type { MessageKey } from './en';
export type Lang = 'es' | 'en';
export type LangPreference = Lang | 'system';
export type Params = Record<string, string | number>;

const DICTS: Record<Lang, Record<MessageKey, string>> = { en, es };
/** Languages of Spain: their speakers get Spanish rather than English. */
const SPANISH = new Set(['es', 'ca', 'gl', 'eu']);
const KEY = 'madridgo.language.v1';

export function deviceLanguage(): Lang {
  try {
    const code = getLocales()[0]?.languageCode?.toLowerCase();
    return code && SPANISH.has(code) ? 'es' : 'en';
  } catch {
    return 'en';
  }
}

interface State {
  preference: LangPreference;
  lang: Lang;
}

let state: State = { preference: 'system', lang: deviceLanguage() };
const listeners = new Set<() => void>();
let loading: Promise<void> | null = null;

function apply(preference: LangPreference) {
  const lang = preference === 'system' ? deviceLanguage() : preference;
  if (preference === state.preference && lang === state.lang) return;
  state = { preference, lang };
  if (Platform.OS === 'web' && typeof document !== 'undefined') {
    document.documentElement.lang = lang;
  }
  listeners.forEach((l) => l());
}

/** The language for texts and for requests to the server. */
export function currentLang(): Lang {
  return state.lang;
}

/** Changes the language now and remembers the choice on this device. */
export function setLanguagePreference(preference: LangPreference) {
  apply(preference);
  void AsyncStorage.setItem(KEY, preference);
}

/** Tests: use one language without touching storage. */
export function setLanguageForTests(lang: Lang) {
  apply(lang);
}

async function load() {
  try {
    const saved = await AsyncStorage.getItem(KEY);
    if (saved === 'es' || saved === 'en' || saved === 'system') apply(saved);
  } catch {
    // Keep the device language.
  }
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

/** The language and the user's choice; re-renders on change. Loads the stored choice once. */
export function useLanguage(): State {
  useEffect(() => {
    loading ??= load();
  }, []);
  return useSyncExternalStore(
    subscribe,
    () => state,
    () => state,
  );
}

function fill(text: string, params?: Params): string {
  if (!params) return text;
  return text.replace(/\{(\w+)\}/g, (m, name: string) =>
    name in params ? String(params[name]) : m,
  );
}

/** The text `key` in the current language, with `{name}` placeholders filled. */
export function t(key: MessageKey, params?: Params): string {
  return fill(DICTS[state.lang][key] ?? en[key], params);
}

type PluralBase = MessageKey extends infer K ? (K extends `${infer B}.one` ? B : never) : never;

/** Plural: `${base}.one` for 1, `${base}.other` otherwise (Spanish and English agree). */
export function tn(base: PluralBase, n: number, params?: Params): string {
  const key = `${base}.${n === 1 ? 'one' : 'other'}` as MessageKey;
  return t(key, { n, ...params });
}

/** Locale for dates and numbers. */
export function locale(): string {
  return state.lang === 'es' ? 'es-ES' : 'en-GB';
}

/** Texts for components: re-renders the caller when the language changes. */
export function useT() {
  const { lang } = useLanguage();
  return { t, tn, lang };
}

/**
 * Splits a text with `{name}` slots into pieces, for texts that mix plain words with styled
 * ones (see components/Rich.tsx).
 */
export function splitSlots(text: string): ({ text: string } | { slot: string })[] {
  const out: ({ text: string } | { slot: string })[] = [];
  let last = 0;
  for (const m of text.matchAll(/\{(\w+)\}/g)) {
    if (m.index > last) out.push({ text: text.slice(last, m.index) });
    out.push({ slot: m[1] });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last) });
  return out;
}
