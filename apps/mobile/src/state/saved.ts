// Favourite and recent stops, stored only on this device (no account, no server copy).

import AsyncStorage from '@react-native-async-storage/async-storage';
import { useEffect, useSyncExternalStore } from 'react';

import type { Line, Mode, StopSummary } from '../api/stops';

export interface SavedStop {
  id: string;
  name: string;
  modes: Mode[];
  lines: Line[];
}

interface Saved {
  favorites: SavedStop[];
  recents: SavedStop[];
  loaded: boolean;
}

const KEY = 'madridgo.saved.v1';
const MAX_RECENTS = 8;
let saved: Saved = { favorites: [], recents: [], loaded: false };
const listeners = new Set<() => void>();
let loading: Promise<void> | null = null;

function notify() {
  listeners.forEach((l) => l());
}

function persist(next: Saved) {
  saved = next;
  notify();
  void AsyncStorage.setItem(
    KEY,
    JSON.stringify({ favorites: next.favorites, recents: next.recents }),
  );
}

export function toSaved(s: Pick<StopSummary, 'id' | 'name' | 'modes' | 'lines'>): SavedStop {
  return { id: s.id, name: s.name, modes: s.modes, lines: s.lines.slice(0, 8) };
}

async function load() {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    const parsed = raw ? (JSON.parse(raw) as Partial<Saved>) : {};
    saved = {
      favorites: Array.isArray(parsed.favorites) ? parsed.favorites : [],
      recents: Array.isArray(parsed.recents) ? parsed.recents : [],
      loaded: true,
    };
  } catch {
    saved = { ...saved, loaded: true };
  }
  notify();
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

export function useSaved(): Saved {
  useEffect(() => {
    loading ??= load();
  }, []);
  return useSyncExternalStore(
    subscribe,
    () => saved,
    () => saved,
  );
}

export function isFavorite(id: string, s: Saved = saved) {
  return s.favorites.some((f) => f.id === id);
}

export function toggleFavorite(stop: SavedStop) {
  const favorites = isFavorite(stop.id)
    ? saved.favorites.filter((f) => f.id !== stop.id)
    : [...saved.favorites, stop];
  persist({ ...saved, favorites });
}

export function addRecent(stop: SavedStop) {
  const recents = [stop, ...saved.recents.filter((r) => r.id !== stop.id)].slice(0, MAX_RECENTS);
  persist({ ...saved, recents });
}

export function removeRecent(id: string) {
  persist({ ...saved, recents: saved.recents.filter((r) => r.id !== id) });
}

export function clearRecents() {
  persist({ ...saved, recents: [] });
}
