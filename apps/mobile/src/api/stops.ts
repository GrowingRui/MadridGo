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

export interface Departure {
  kind: 'scheduled';
  time: string;
  line: Line;
  headsign: string | null;
  stop_id: string;
  trip_id: string;
  wheelchair_accessible: boolean | null;
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
  data_quality: 'scheduled';
  departures: Departure[];
  frequencies: FrequencyService[];
  notices: DataNotice[];
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

export const nearbyStops = (lat: number, lon: number, radius_m = 600) =>
  getJson<StopSummary[]>('/stops/nearby', { lat, lon, radius_m });

export const stopBoard = (stopId: string, minutes = 90) =>
  getJson<StopBoard>(`/stops/${encodeURIComponent(stopId)}/departures`, { minutes, limit: 60 });

export const feedStatuses = () => getJson<FeedStatus[]>('/feeds');
