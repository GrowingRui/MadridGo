// Offline copies: when the network is unreachable, the last answer for a stop board or a saved
// route is shown instead of an error, marked as a saved copy with the time it was saved. Live
// information is removed from a copy (it would be out of date): only the timetable remains.
// Kept on this device only, at most MAX_COPIES, oldest dropped first.

import AsyncStorage from '@react-native-async-storage/async-storage';

import type { Journey, JourneyPlan, LegTime } from '../api/journeys';
import { ApiError } from '../api/client';
import type { StopBoard } from '../api/stops';

const INDEX_KEY = 'madridgo.copies.index.v1';
const copyKey = (key: string) => `madridgo.copy.v1.${key}`;
export const MAX_COPIES = 20;

interface Stored<T> {
  savedAt: number;
  data: T;
}

/** Answers that came from a saved copy, and when that copy was saved. */
const fromCopy = new WeakMap<object, number>();

/** When the copy this answer came from was saved (ms), or null for a fresh answer. */
export function copySavedAt(data: object | null | undefined): number | null {
  return data ? (fromCopy.get(data) ?? null) : null;
}

async function readIndex(): Promise<string[]> {
  try {
    const raw = await AsyncStorage.getItem(INDEX_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(parsed) ? parsed.filter((k): k is string => typeof k === 'string') : [];
  } catch {
    return [];
  }
}

export async function rememberCopy<T>(key: string, data: T, now = Date.now()): Promise<void> {
  try {
    const index = (await readIndex()).filter((k) => k !== key);
    index.push(key); // most recently saved last
    const dropped = index.splice(0, Math.max(0, index.length - MAX_COPIES));
    await Promise.all([
      AsyncStorage.setItem(copyKey(key), JSON.stringify({ savedAt: now, data } satisfies Stored<T>)),
      AsyncStorage.setItem(INDEX_KEY, JSON.stringify(index)),
      ...dropped.map((k) => AsyncStorage.removeItem(copyKey(k))),
    ]);
  } catch {
    // Storage full or unavailable: the app works without copies.
  }
}

export async function recallCopy<T>(key: string): Promise<Stored<T> | null> {
  try {
    const raw = await AsyncStorage.getItem(copyKey(key));
    const parsed = raw ? (JSON.parse(raw) as Stored<T>) : null;
    return parsed && typeof parsed.savedAt === 'number' && parsed.data ? parsed : null;
  } catch {
    return null;
  }
}

/** No connection, a timeout or the server being down: a saved copy is better than an error. */
export function isUnreachable(err: unknown): boolean {
  return err instanceof ApiError && (err.status === null || err.status >= 500);
}

/**
 * Asks `fetcher`; a good answer is saved as the copy for `key`. When the network is
 * unreachable, the saved copy (made timetable-only by `clean`) is returned instead and marked,
 * see `copySavedAt`. Without a copy the original error is thrown.
 */
export async function withOfflineCopy<T extends object>(
  key: string,
  fetcher: () => Promise<T>,
  clean: (copy: T) => T,
): Promise<T> {
  try {
    const data = await fetcher();
    void rememberCopy(key, data);
    return data;
  } catch (err) {
    if (!isUnreachable(err)) throw err;
    const copy = await recallCopy<T>(key);
    if (!copy) throw err;
    const data = clean(copy.data);
    fromCopy.set(data, copy.savedAt);
    return data;
  }
}

/** A saved time without its live estimate: the timetable's time. */
function timetableTime(t: LegTime): LegTime {
  return {
    scheduled: t.scheduled,
    status: t.status === 'frequency' ? 'frequency' : 'scheduled',
    estimated: null,
    realtime: null,
  };
}

/** A saved board as the timetable alone: no live times, cancellations or live sources. */
export function boardAsTimetable(b: StopBoard): StopBoard {
  const plain = <D extends StopBoard['departures'][number]>(d: D): D => ({
    ...d,
    status: 'scheduled',
    realtime: null,
    usual_delay: null,
  });
  return {
    ...b,
    data_quality: 'scheduled',
    departures: b.departures.map(plain),
    arrivals: b.arrivals?.map(plain),
    live_arrivals: [],
    realtime: [],
    alerts: [],
  };
}

function plainJourney(j: Journey): Journey {
  return {
    ...j,
    departure: timetableTime(j.departure),
    arrival: timetableTime(j.arrival),
    legs: j.legs.map((l) => ({
      ...l,
      departure: timetableTime(l.departure),
      arrival: timetableTime(l.arrival),
      usual_delay: null,
    })),
    changes: j.changes.map((c) => ({ ...c, basis: 'scheduled' as const })),
    data_quality: 'scheduled',
    alerts: [],
  };
}

/** A saved plan as the timetable alone, without the connections that have already left. */
export function planAsTimetable(p: JourneyPlan, now = Date.now()): JourneyPlan {
  return {
    ...p,
    journeys: p.journeys
      .map(plainJourney)
      .filter((j) => Date.parse(j.departure.scheduled) >= now - 60_000),
    realtime: [],
  };
}
