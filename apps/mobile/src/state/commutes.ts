// Saved routes ("commutes"), stored only on this device: a From and a To you travel often
// (home -> work). The Trips tab shows the next departures for each, live, without planning
// anything. Unlike a saved connection (state/connections.ts) it is a pair of places, not one
// train, so it never expires.

import AsyncStorage from '@react-native-async-storage/async-storage';
import { useEffect, useSyncExternalStore } from 'react';

import { HERE_ID, type Place, placeKey } from './planner';

export interface Commute {
  /** From and To as planned, in the direction shown first. */
  id: string;
  from: Place;
  to: Place;
}

const KEY = 'madridgo.commutes.v1';
export const MAX_COMMUTES = 5;

let list: Commute[] = [];
let loaded = false;
const listeners = new Set<() => void>();
let loading: Promise<void> | null = null;

export function commuteId(from: Place, to: Place): string {
  return `${placeKey(from)}>${placeKey(to)}`;
}

/** "Current location" moves with you, so it cannot be a regular route. */
export function canSaveRoute(from: Place | null, to: Place | null): boolean {
  return !!from && !!to && from.id !== HERE_ID && to.id !== HERE_ID && from.id !== to.id;
}

function persist(next: Commute[]) {
  list = next;
  listeners.forEach((l) => l());
  void AsyncStorage.setItem(KEY, JSON.stringify(list));
}

function valid(c: unknown): c is Commute {
  const x = c as Commute | null;
  return !!x?.id && !!x.from?.id && !!x.from.name && !!x.to?.id && !!x.to.name;
}

async function load() {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    list = Array.isArray(parsed) ? parsed.filter(valid).slice(0, MAX_COMMUTES) : [];
  } catch {
    list = [];
  }
  loaded = true;
  listeners.forEach((l) => l());
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

export function useCommutes(): { commutes: Commute[]; loaded: boolean } {
  useEffect(() => {
    loading ??= load();
  }, []);
  const commutes = useSyncExternalStore(
    subscribe,
    () => list,
    () => list,
  );
  return { commutes, loaded };
}

/** The route in either direction is already saved. */
export function isRouteSaved(from: Place, to: Place, saved: Commute[] = list): boolean {
  const a = commuteId(from, to);
  const b = commuteId(to, from);
  return saved.some((c) => c.id === a || c.id === b);
}

export type AddResult = 'added' | 'exists' | 'full' | 'invalid';

/** Saves the route (the return trip is shown with the swap button, not saved twice). */
export function addCommute(from: Place, to: Place): AddResult {
  if (!canSaveRoute(from, to)) return 'invalid';
  if (isRouteSaved(from, to)) return 'exists';
  if (list.length >= MAX_COMMUTES) return 'full';
  persist([...list, { id: commuteId(from, to), from, to }]);
  return 'added';
}

export function removeCommute(id: string) {
  persist(list.filter((c) => c.id !== id));
}

/** Home -> work becomes work -> home, kept for next time. */
export function swapCommute(id: string) {
  persist(
    list.map((c) => (c.id === id ? { id: commuteId(c.to, c.from), from: c.to, to: c.from } : c)),
  );
}

/** Tests: start again empty. */
export function resetCommutesForTests() {
  loading = null;
  loaded = false;
  list = [];
}
