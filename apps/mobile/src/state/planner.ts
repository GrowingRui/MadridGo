// Planner state shared between the planner and the stop picker (tiny external store).

import { useSyncExternalStore } from 'react';

import type { SortOption } from '../api/journeys';

export interface Place {
  id: string;
  name: string;
  /**
   * Set for "Current location" and for addresses and places from the address search: the
   * journey starts or ends at this point, not at a stop.
   */
  lat?: number;
  lon?: number;
}

/** Id of the "Current location" place (never a real stop id). */
export const HERE_ID = 'here';

/**
 * What the planner API gets for a place: its stop id, or its point, with the name for an
 * address (the API names "Current location" itself, in the app's language).
 */
export function planPlace(p: Place): string | { lat: number; lon: number; name?: string } {
  if (p.lat == null || p.lon == null) return p.id;
  return p.id === HERE_ID ? { lat: p.lat, lon: p.lon } : { lat: p.lat, lon: p.lon, name: p.name };
}

/** What the planner sends for a place: its stop id, or its point for "Current location". */
export function placeKey(p: Place): string {
  return p.lat != null && p.lon != null ? `${p.lat.toFixed(5)},${p.lon.toFixed(5)}` : p.id;
}

export interface PlannerState {
  from: Place | null;
  to: Place | null;
  /** Time in ms; null means "now". */
  when: number | null;
  /** true: `when` is the latest arrival; false: the earliest departure. */
  arriveBy: boolean;
  sort: SortOption;
  /** Plan screen view: From/To form, stop tiles, or map. */
  view: PlanView;
  /**
   * Trip ids the search leaves out: set when re-planning around a cancelled train
   * (utils/replan.ts); forgotten as soon as From or To changes.
   */
  avoid: string[];
}

export type PlanView = 'timetable' | 'touch' | 'map';

export const DEFAULT_SORT: SortOption = 'earliest_arrival';

let state: PlannerState = {
  from: null,
  to: null,
  when: null,
  arriveBy: false,
  sort: DEFAULT_SORT,
  view: 'timetable',
  avoid: [],
};
const listeners = new Set<() => void>();

export function setPlanner(patch: Partial<PlannerState>) {
  const placesChanged = 'from' in patch || 'to' in patch;
  state = { ...state, ...(placesChanged ? { avoid: [] } : null), ...patch };
  listeners.forEach((l) => l());
}

/** Set by startSearch: the Plan screen opens the connections even if they were open before. */
let newSearch = false;

/**
 * A search started from elsewhere (re-planning from a connection): fills the planner; the
 * caller then goes to the Plan screen, which opens the connections for it.
 */
export function startSearch(patch: Pick<PlannerState, 'from' | 'to'> & Partial<PlannerState>) {
  newSearch = true;
  setPlanner({ when: null, arriveBy: false, sort: DEFAULT_SORT, view: 'timetable', ...patch });
}

/** For the Plan screen: true once after startSearch. */
export function takeNewSearch(): boolean {
  const was = newSearch;
  newSearch = false;
  return was;
}

export function swapPlaces() {
  setPlanner({ from: state.to, to: state.from });
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

export function usePlanner(): PlannerState {
  return useSyncExternalStore(
    subscribe,
    () => state,
    () => state,
  );
}
