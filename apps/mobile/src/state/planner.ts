// Planner state shared between the planner and the stop picker (tiny external store).

import { useSyncExternalStore } from 'react';

import type { SortOption } from '../api/journeys';

export interface Place {
  id: string;
  name: string;
}

export interface PlannerState {
  from: Place | null;
  to: Place | null;
  /** Time in ms; null means "now". */
  when: number | null;
  /** true: `when` is the latest arrival; false: the earliest departure. */
  arriveBy: boolean;
  sort: SortOption;
}

export const DEFAULT_SORT: SortOption = 'earliest_arrival';

let state: PlannerState = {
  from: null,
  to: null,
  when: null,
  arriveBy: false,
  sort: DEFAULT_SORT,
};
const listeners = new Set<() => void>();

export function setPlanner(patch: Partial<PlannerState>) {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
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
