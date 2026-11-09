// Planner state shared between the planner and the stop picker (tiny external store).

import { useSyncExternalStore } from 'react';

export interface Place {
  id: string;
  name: string;
}

export interface PlannerState {
  from: Place | null;
  to: Place | null;
  /** Departure time in ms; null means "now". */
  when: number | null;
}

let state: PlannerState = { from: null, to: null, when: null };
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
