// Saved connections (the ☆ on a journey, as in SBB Mobile), stored only on this device. A
// saved connection is kept until it has arrived; the Plan screen lists the ones still ahead.
// Its times are a copy from when it was saved, so the journey screen asks the planner for the
// same connection again (refreshConnection) before trusting them.

import AsyncStorage from '@react-native-async-storage/async-storage';
import { useEffect, useSyncExternalStore } from 'react';

import { type Journey, planJourneys, shownTime } from '../api/journeys';
import { useNow } from '../hooks';
import type { Place } from './planner';

export interface SavedConnection {
  journey: Journey;
  /** What was planned: needed to ask the planner for this connection again. */
  from: Place;
  to: Place;
  /** When the times were last fetched (ms). */
  updatedAt: number;
}

const KEY = 'madridgo.connections.v1';
const MAX = 20;
/** Kept a little after arrival, then dropped. */
const KEEP_AFTER_ARRIVAL_MS = 10 * 60_000;

let list: SavedConnection[] = [];
const listeners = new Set<() => void>();
let loading: Promise<void> | null = null;

const arrivalMs = (c: SavedConnection) => Date.parse(shownTime(c.journey.arrival));
const departureMs = (c: SavedConnection) => Date.parse(shownTime(c.journey.departure));

function current(now = Date.now()): SavedConnection[] {
  return list
    .filter((c) => arrivalMs(c) + KEEP_AFTER_ARRIVAL_MS > now)
    .sort((a, b) => departureMs(a) - departureMs(b));
}

function persist(next: SavedConnection[]) {
  list = next;
  listeners.forEach((l) => l());
  void AsyncStorage.setItem(KEY, JSON.stringify(list));
}

async function load() {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    list = Array.isArray(parsed)
      ? (parsed as SavedConnection[]).filter((c) => c?.journey?.id && c.from && c.to)
      : [];
  } catch {
    list = [];
  }
  persist(current());
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

/** Saved connections that have not arrived yet, earliest first; re-renders on change. */
export function useSavedConnections(): SavedConnection[] {
  useEffect(() => {
    loading ??= load();
  }, []);
  const now = useNow(60_000);
  const all = useSyncExternalStore(
    subscribe,
    () => list,
    () => list,
  );
  return all.filter((c) => arrivalMs(c) + KEEP_AFTER_ARRIVAL_MS > now);
}

export function isConnectionSaved(id: string, saved: SavedConnection[] = list): boolean {
  return saved.some((c) => c.journey.id === id);
}

export function savedConnection(id: string): SavedConnection | undefined {
  return list.find((c) => c.journey.id === id);
}

/** Saves the connection, or removes it when it is already saved. */
export function toggleConnection(journey: Journey, from: Place, to: Place) {
  if (isConnectionSaved(journey.id)) {
    persist(list.filter((c) => c.journey.id !== journey.id));
  } else {
    persist([...current(), { journey, from, to, updatedAt: Date.now() }].slice(-MAX));
  }
}

export function removeConnection(id: string) {
  persist(list.filter((c) => c.journey.id !== id));
}

/** A stop id, or the point for "Current location". */
const planPlace = (p: Place) => (p.lat != null && p.lon != null ? { lat: p.lat, lon: p.lon } : p.id);

/**
 * Asks the planner for the same connection again (same trains, same stops: the same id) to get
 * current times and labels. Returns it, or null when the planner no longer offers it.
 */
export async function refreshConnection(c: SavedConnection): Promise<Journey | null> {
  const at = Date.parse(c.journey.departure.scheduled) - 60_000;
  const plan = await planJourneys({ from: planPlace(c.from), to: planPlace(c.to), at });
  const fresh = plan.journeys.find((j) => j.id === c.journey.id) ?? null;
  if (fresh && isConnectionSaved(fresh.id)) {
    persist(
      list.map((x) =>
        x.journey.id === fresh.id ? { ...x, journey: fresh, updatedAt: Date.now() } : x,
      ),
    );
  }
  return fresh;
}

/** More → "Delete starred and recent stops" also forgets saved connections. */
export function clearConnections() {
  persist([]);
}

/** Tests: start again empty. */
export function resetConnectionsForTests() {
  loading = null;
  list = [];
}
