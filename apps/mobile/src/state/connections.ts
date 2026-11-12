// Saved connections (the ☆ on a journey, as in SBB Mobile), stored only on this device. A
// saved connection is kept until it has arrived (live arrival when known); the Trips tab lists
// the ones still ahead or on the way.
// Its times are a copy from when it was saved, so the journey screen asks the planner for the
// same connection again (refreshConnection) before trusting them.

import AsyncStorage from '@react-native-async-storage/async-storage';
import { useEffect, useSyncExternalStore } from 'react';

import { type Journey, type LegTime, planJourneys, shownTime } from '../api/journeys';
import { useNow } from '../hooks';
import { type Place, planPlace } from './planner';

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

let list: SavedConnection[] = [];
const listeners = new Set<() => void>();
let loading: Promise<void> | null = null;

/** The expected time: the live estimate when there is one, else the timetable. */
export function expectedMs(time: LegTime): number {
  const scheduled = Date.parse(time.scheduled);
  if (time.status !== 'live') return scheduled;
  if (time.estimated) return Date.parse(time.estimated);
  const delay = time.realtime?.delay_s;
  return delay != null ? scheduled + delay * 1000 : Date.parse(shownTime(time));
}

/** When the trip is over: the expected arrival, never before the timetable's. */
export function tripEndMs(journey: Journey): number {
  return Math.max(Date.parse(journey.arrival.scheduled), expectedMs(journey.arrival));
}

export type TripPhase = 'upcoming' | 'ongoing' | 'over';

export function tripPhase(journey: Journey, now: number = Date.now()): TripPhase {
  if (now >= tripEndMs(journey)) return 'over';
  return now >= expectedMs(journey.departure) ? 'ongoing' : 'upcoming';
}

const departureMs = (c: SavedConnection) => Date.parse(shownTime(c.journey.departure));

function current(now = Date.now()): SavedConnection[] {
  return list
    .filter((c) => tripEndMs(c.journey) > now)
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
export function useSavedConnections(tick = 30_000): SavedConnection[] {
  useEffect(() => {
    loading ??= load();
  }, []);
  const now = useNow(tick);
  const all = useSyncExternalStore(
    subscribe,
    () => list,
    () => list,
  );
  return all
    .filter((c) => tripEndMs(c.journey) > now)
    .sort((a, b) => departureMs(a) - departureMs(b));
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


/**
 * Asks the planner for the same connection again (same trains, same stops: the same id) to get
 * current times and labels. Returns it, or null when the planner no longer offers it.
 */
export async function refreshConnection(c: SavedConnection): Promise<Journey | null> {
  const saved = c.journey;
  // From just before the expected departure: a live bus may come before the planner's time.
  const at = Math.min(Date.parse(saved.departure.scheduled), expectedMs(saved.departure)) - 60_000;
  const plan = await planJourneys({ from: planPlace(c.from), to: planPlace(c.to), at });
  const match = plan.journeys.find((j) => j.id === saved.id) ?? sameRide(saved, plan.journeys);
  if (!match) return null;
  // On the bus already: the boarding stop no longer lists it, so the answer has lost its
  // live times. The saved ones are still the best there is.
  if (
    saved.departure.status === 'live' &&
    match.departure.status !== 'live' &&
    tripPhase(saved) === 'ongoing'
  ) {
    return saved;
  }
  // Kept under the saved id: screens and the list refer to it.
  const fresh = { ...match, id: saved.id };
  if (isConnectionSaved(saved.id)) {
    persist(
      list.map((x) =>
        x.journey.id === saved.id ? { ...x, journey: fresh, updatedAt: Date.now() } : x,
      ),
    );
  }
  return fresh;
}

/** What a journey rides: each vehicle's line (or trip, when timetabled) and its stops. */
function ridePattern(j: Journey): string {
  return j.legs
    .filter((l) => l.mode !== 'walk')
    .map((l) =>
      [
        l.mode,
        l.headway_min != null ? (l.line?.route_id ?? l.trip_id) : l.trip_id,
        l.from_stop_id,
        l.to_stop_id,
      ].join(':'),
    )
    .join('|');
}

/**
 * The same connection in a new answer when its id changed. A journey's id holds the planner's
 * own time on a frequency line (EMT), which moves with every search (found 2026-11-12: saved
 * bus trips never refreshed). Same lines and stops, timetabled trips the same, leaving within
 * one headway of the saved one: the closest.
 */
export function sameRide(saved: Journey, journeys: Journey[]): Journey | null {
  const headway = Math.max(0, ...saved.legs.map((l) => l.headway_min ?? 0));
  if (!headway) return null; // a timetabled connection keeps its id
  const pattern = ridePattern(saved);
  const at = expectedMs(saved.departure);
  let best: Journey | null = null;
  let bestGap = headway * 60_000;
  for (const j of journeys) {
    if (ridePattern(j) !== pattern) continue;
    const gap = Math.abs(expectedMs(j.departure) - at);
    if (gap < bestGap) [best, bestGap] = [j, gap];
  }
  return best;
}

/** Trips leaving within this time (or on the way) get their live times refreshed. */
const REFRESH_AHEAD_MS = 2 * 3600_000;
const REFRESH_EVERY_MS = 60_000;
let refreshing = false;

/** One pass: asks the planner again for each trip that is due, one after the other. */
export async function refreshDueTrips(now: number = Date.now()): Promise<void> {
  if (refreshing) return;
  refreshing = true;
  try {
    const due = current(now).filter(
      (c) =>
        now - c.updatedAt >= REFRESH_EVERY_MS &&
        expectedMs(c.journey.departure) - now <= REFRESH_AHEAD_MS,
    );
    for (const c of due) {
      // Offline or no longer offered: keep the saved times; the trip screen says so.
      await refreshConnection(c).catch(() => null);
    }
  } finally {
    refreshing = false;
  }
}

/** While a screen showing trips is open: refresh their live times every minute. */
export function useTripRefresh(active = true) {
  useEffect(() => {
    if (!active) return;
    const run = () => void (loading ?? (loading = load())).then(() => refreshDueTrips());
    run();
    const timer = setInterval(run, REFRESH_EVERY_MS);
    return () => clearInterval(timer);
  }, [active]);
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
