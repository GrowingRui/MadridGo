// Live train position for a journey leg (services/api/app/trips.py).

import { getJson } from './client';
import type { Freshness } from './stops';

export interface PositionStop {
  index: number; // in the trip's full stop sequence
  stop_id: string;
  name: string;
}

export interface TripPosition {
  trip_id: string;
  status: 'at_stop' | 'between' | 'unavailable';
  /** live: Renfe's vehicle position. estimated: from the timetable (+ live delay). */
  kind?: 'live' | 'estimated' | null;
  reason?: 'not_supported' | 'cancelled' | 'not_started' | 'not_running' | null;
  message: string;
  /** The station the train is at (at_stop) or has just left (between). */
  last_stop?: PositionStop | null;
  next_stop?: PositionStop | null;
  /** 0..1 from last_stop to next_stop; 0 when at_stop; null when unknown. */
  progress?: number | null;
  progress_basis?: 'gps' | 'timetable' | null;
  /** Scheduled seconds from last_stop to next_stop: the pace of the point between updates. */
  segment_run_s?: number | null;
  expected_at_next?: string | null;
  /** between: when the train left last_stop (predicted or estimated). */
  left_at?: string | null;
  /** estimated at_stop: when the train is due to leave. */
  departs_at?: string | null;
  delay_s?: number | null;
  board_index?: number | null;
  /** Stations from last_stop to the boarding stop; 0 at it; negative once passed. */
  stops_away?: number | null;
  observed_at?: string | null;
  freshness?: Freshness | null;
  source?: string | null;
  attribution?: string | null;
  poll_after_s: number;
}

export function getTripPosition(
  tripId: string,
  fromStop?: string | null,
  fetchImpl: typeof fetch = fetch,
): Promise<TripPosition> {
  return getJson<TripPosition>(
    `/trips/${encodeURIComponent(tripId)}/position`,
    { from_stop: fromStop ?? undefined },
    8000,
    fetchImpl,
  );
}
