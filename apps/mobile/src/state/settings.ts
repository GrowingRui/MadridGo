// Display settings, stored only on this device: appearance, light (default) or dark, and
// whether to show step-free travel information (off by default, as in SBB Mobile).
// Language has its own store in i18n/.

import AsyncStorage from '@react-native-async-storage/async-storage';
import { useEffect, useSyncExternalStore } from 'react';
import { Platform } from 'react-native';

import { applyScheme, palettes, type Scheme } from '../theme';

export type AppearancePreference = Scheme;

interface Settings {
  appearance: AppearancePreference;
  /** Wheelchair icons on connections, rides, trips and station boards (Cercanías data). */
  stepFree: boolean;
  loaded: boolean;
}

const KEY = 'madridgo.settings.v1';

let state: Settings = { appearance: 'light', stepFree: false, loaded: false };
const listeners = new Set<() => void>();
let loading: Promise<void> | null = null;

/** The website's page background and native form controls follow the scheme too. */
function paintDocument(scheme: Scheme) {
  if (Platform.OS !== 'web' || typeof document === 'undefined') return;
  const root = document.documentElement;
  root.style.colorScheme = scheme;
  root.style.backgroundColor = palettes[scheme].bg;
  document.body.style.backgroundColor = palettes[scheme].bg;
}

function set(next: Partial<Settings>) {
  const merged = { ...state, ...next };
  if (
    merged.appearance === state.appearance &&
    merged.stepFree === state.stepFree &&
    merged.loaded === state.loaded
  )
    return;
  applyScheme(merged.appearance);
  paintDocument(merged.appearance);
  state = merged;
  listeners.forEach((l) => l());
}

function save() {
  const { appearance, stepFree } = state;
  void AsyncStorage.setItem(KEY, JSON.stringify({ appearance, stepFree }));
}

export function setAppearance(appearance: AppearancePreference) {
  set({ appearance });
  save();
}

export function setStepFree(stepFree: boolean) {
  set({ stepFree });
  save();
}

async function load() {
  let appearance: AppearancePreference = 'light';
  let stepFree = false;
  try {
    const raw = await AsyncStorage.getItem(KEY);
    const parsed = raw ? (JSON.parse(raw) as { appearance?: unknown; stepFree?: unknown }) : {};
    if (parsed.appearance === 'dark') appearance = 'dark';
    stepFree = parsed.stepFree === true;
  } catch {
    // Keep the defaults.
  }
  set({ appearance, stepFree, loaded: true });
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

/** The settings; re-renders on change. Loads the stored choice once. */
export function useSettings(): Settings {
  useEffect(() => {
    loading ??= load();
  }, []);
  return useSyncExternalStore(
    subscribe,
    () => state,
    () => state,
  );
}

/** Tests: start again from the defaults. */
export function resetSettingsForTests() {
  loading = null;
  state = { appearance: 'light', stepFree: false, loaded: false };
  applyScheme('light');
}
