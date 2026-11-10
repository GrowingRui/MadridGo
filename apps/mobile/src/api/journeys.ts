// Types and call for the backend's journey planner (services/api/app/journeys.py).

import { getJson } from './client';
import type { DataNotice, Line, Mode, RealtimeInfo, ServiceAlert, SourceStatus } from './stops';

/**
 * live: a live estimate exists (`estimated`); scheduled: timetable only; frequency: a
 * headway-based service, so the time is approximate; cancelled: the operator cancelled it.
 */
export type TimeStatus = 'live' | 'scheduled' | 'frequency' | 'cancelled';

export interface LegTime {
  scheduled: string; // ISO time
  estimated?: string | null; // ISO time, only when status is 'live'
  status: TimeStatus;
  platform?: string | null;
  /** Where the live estimate (or the cancellation) comes from. */
  realtime?: RealtimeInfo | null;
}

export interface LegStop {
  name: string;
  stop_id?: string | null;
  time: string;
}

export interface Leg {
  mode: Mode | 'walk';
  line?: Line | null;
  headsign?: string | null;
  trip_id?: string | null;
  from: string;
  to: string;
  from_stop_id?: string | null;
  to_stop_id?: string | null;
  departure: LegTime;
  arrival: LegTime;
  duration_min: number;
  distance_m?: number | null;
  headway_min?: number | null;
  intermediate: LegStop[];
}

/** RELIABILITY_STRATEGY.md §5. No percentages until a delay model is validated. */
export type TransferLabel = 'comfortable' | 'tight' | 'at_risk' | 'not_feasible' | 'uncertain';

export interface Transfer {
  at: string;
  stop_id: string | null;
  from_leg: number;
  to_leg: number;
  walk_min: number;
  /** null: onto a frequent service, see wait_up_to_min. */
  label: TransferLabel | null;
  margin_min: number | null;
  wait_up_to_min: number | null;
  basis: 'live' | 'scheduled';
  message: string;
}

export interface Journey {
  id: string;
  departure: LegTime;
  arrival: LegTime;
  duration_min: number;
  transfers: number;
  walk_min: number;
  legs: Leg[];
  changes: Transfer[];
  /** The worst change; null without changes (or only changes onto frequent services). */
  reliability: TransferLabel | null;
  feasible: boolean;
  issues: string[];
  data_quality: 'scheduled' | 'partly_live';
  alerts: ServiceAlert[];
  is_preview: boolean;
}

export interface JourneyPlace {
  name: string;
  stop_id: string | null;
  lat: number;
  lon: number;
}

export type SortOption = 'earliest_arrival' | 'fastest' | 'fewest_transfers' | 'least_walking';

export interface JourneyPlan {
  from: JourneyPlace;
  to: JourneyPlace;
  generated_at: string;
  search_time: string;
  arrive_by: boolean;
  sort: SortOption;
  journeys: Journey[];
  earlier_cursor: string | null;
  later_cursor: string | null;
  notices: DataNotice[];
  realtime: SourceStatus[];
  routing_error: string | null;
  message: string | null;
}

/** A stop id, or a point (the traveller's current location). */
export type PlanPlace = string | { lat: number; lon: number };

export interface PlanParams {
  from: PlanPlace;
  to: PlanPlace;
  at?: number | null; // ms; omitted: now
  arriveBy?: boolean;
  sort?: SortOption;
  cursor?: string | null; // earlier_cursor or later_cursor of a previous answer
}

/** Routing can take a few seconds (OTP); allow more than the default timeout. */
const PLAN_TIMEOUT_MS = 15_000;

function placeParams(end: 'from' | 'to', p: PlanPlace) {
  if (typeof p === 'string') return { [end]: p };
  return { [`${end}_lat`]: p.lat.toFixed(5), [`${end}_lon`]: p.lon.toFixed(5) };
}

export function planJourneys(p: PlanParams, fetchImpl: typeof fetch = fetch): Promise<JourneyPlan> {
  return getJson<JourneyPlan>(
    '/journeys',
    {
      ...placeParams('from', p.from),
      ...placeParams('to', p.to),
      at: p.cursor || p.at == null ? undefined : new Date(p.at).toISOString(),
      arrive_by: p.arriveBy ? 'true' : undefined,
      sort: p.sort,
      cursor: p.cursor ?? undefined,
    },
    PLAN_TIMEOUT_MS,
    fetchImpl,
  );
}

/**
 * Minutes of delay on a live time (0 when on time, not live, or not comparable). Headway
 * services (EMT) have no timetable to compare with: the source sends no delay, so none is shown.
 */
export function delayMin(t: LegTime): number {
  if (t.status !== 'live' || !t.estimated) return 0;
  if (t.realtime && t.realtime.delay_s == null) return 0;
  return Math.round((Date.parse(t.estimated) - Date.parse(t.scheduled)) / 60_000);
}

/**
 * The time to print. Normally the scheduled time (the delay is shown next to it). A live time
 * with no delay to compare with (headway services) is printed as the live time itself.
 */
export function shownTime(t: LegTime): string {
  if (t.status === 'live' && t.estimated && t.realtime && t.realtime.delay_s == null) {
    return t.estimated;
  }
  return t.scheduled;
}
