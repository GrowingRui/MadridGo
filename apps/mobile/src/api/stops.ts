// Types and calls for the backend's stop endpoints (services/api/app/stops.py).

import { getJson } from './client';

export type Mode = 'rail' | 'metro' | 'light_rail' | 'bus';

export interface Line {
  source: string;
  route_id: string;
  short_name: string;
  long_name: string | null;
  mode: Mode;
  color: string | null;
  text_color: string | null;
}

export interface StopSummary {
  id: string;
  name: string;
  code: string | null;
  lat: number | null;
  lon: number | null;
  is_station: boolean;
  modes: Mode[];
  lines: Line[];
  distance_m: number | null;
}

export type FreshnessState = 'FRESH' | 'DELAYED_UPDATE' | 'STALE' | 'UNAVAILABLE';

export interface Freshness {
  state: FreshnessState;
  age_s: number | null;
  /** 'retrieved': the source gives no observation time; the age is since MadridGo fetched it. */
  age_basis: 'source' | 'retrieved' | null;
  anomaly: string | null;
}

/** Provenance of a live value (backend app/realtime/models.py). */
export interface RealtimeInfo {
  classification: 'LIVE' | 'CANCELLED';
  source: string;
  retrieved_at: string;
  source_timestamp: string | null;
  freshness: Freshness;
  predicted_time: string | null;
  delay_s: number | null;
  /** The train's current delay applied to this stop, not a prediction for this stop. */
  estimated_from_trip_delay: boolean;
  vehicle_id: string | null;
  platform: string | null;
}

export interface Departure {
  kind: 'scheduled';
  /** Always the scheduled time. Live estimates are in `realtime.predicted_time`. */
  time: string;
  line: Line;
  headsign: string | null;
  stop_id: string;
  trip_id: string;
  wheelchair_accessible: boolean | null;
  status: 'scheduled' | 'live' | 'cancelled';
  realtime: RealtimeInfo | null;
}

/** A live prediction with no timetable row behind it (EMT buses). */
export interface LiveArrival {
  kind: 'live';
  line: Line;
  headsign: string | null;
  stop_id: string;
  /** null: beyond the source's horizon (EMT: more than 45 min). */
  time: string | null;
  distance_m: number | null;
  realtime: RealtimeInfo;
}

export interface SourceStatus {
  feed: string;
  operator: string;
  source: string | null;
  status: 'live' | 'delayed_update' | 'stale' | 'unavailable' | 'not_available';
  message: string;
  freshness: Freshness | null;
  retrieved_at: string | null;
  source_timestamp: string | null;
  attribution: string | null;
}

export interface ServiceAlert {
  source: string;
  source_alert_id: string;
  operator: string;
  header: string | null;
  description: string | null;
  url: string | null;
  cause: string | null;
  effect: string | null;
  active_from: string | null;
  active_to: string | null;
  route_ids: string[];
  stop_ids: string[];
}

/** GTFS-RT effects that mean the trip as planned may not happen: shown in red, listed first. */
const SEVERE_EFFECTS = new Set(['NO_SERVICE', 'REDUCED_SERVICE', 'SIGNIFICANT_DELAYS']);

export function isSevereAlert(a: ServiceAlert): boolean {
  return a.effect !== null && SEVERE_EFFECTS.has(a.effect);
}

/**
 * Most important first: severe effects, then alerts on a whole line (a strike, works), then
 * alerts about a station only (a lift out of service); otherwise the server's order.
 */
export function byAlertSeverity(alerts: ServiceAlert[]): ServiceAlert[] {
  const rank = (a: ServiceAlert) => (isSevereAlert(a) ? 0 : a.stop_ids.length === 0 ? 1 : 2);
  return alerts
    .map((a, i) => [a, i] as const)
    .sort(([a, i], [b, j]) => rank(a) - rank(b) || i - j)
    .map(([a]) => a);
}

/** The best known time: the live estimate when there is one, else the scheduled time. */
export function bestTime(d: Departure): string {
  return d.realtime?.predicted_time ?? d.time;
}

export interface FrequencyService {
  kind: 'frequency';
  line: Line;
  headsign: string | null;
  stop_id: string;
  headway_min: number;
  from_time: string;
  until_time: string;
}

export interface DataNotice {
  source: string;
  operator: string;
  expiry: 'ok' | 'expiring' | 'expired';
  service_end: string | null;
  message: string;
}

export interface StopBoard {
  stop: StopSummary;
  generated_at: string;
  window_start: string;
  window_end: string;
  data_quality: 'scheduled' | 'partly_live';
  departures: Departure[];
  frequencies: FrequencyService[];
  live_arrivals: LiveArrival[];
  notices: DataNotice[];
  realtime: SourceStatus[];
  alerts: ServiceAlert[];
  /** Step-free access to the platforms: Cercanías stations only (Renfe's data). */
  step_free?: boolean | null;
}

export interface FeedStatus {
  source: string;
  operator: string;
  mode: string;
  imported: boolean;
  feed_version_label: string | null;
  service_start: string | null;
  service_end: string | null;
  expiry: 'ok' | 'expiring' | 'expired' | null;
  days_left: number | null;
  validation_status: string | null;
  attribution: string;
  licence_url: string;
}

export const searchStops = (q: string, limit = 15) =>
  getJson<StopSummary[]>('/stops/search', { q, limit });

export const nearbyStops = (lat: number, lon: number, radius_m = 600, limit?: number) =>
  getJson<StopSummary[]>('/stops/nearby', { lat, lon, radius_m, limit });

export const stopBoard = (stopId: string, minutes = 90) =>
  getJson<StopBoard>(`/stops/${encodeURIComponent(stopId)}/departures`, { minutes, limit: 60 });

export const feedStatuses = () => getJson<FeedStatus[]>('/feeds');
