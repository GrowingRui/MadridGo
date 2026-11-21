// How late each Cercanías line usually is (services/api/app/realtime/api.py, GET /punctuality):
// the figures behind "Usually ~N min late", per line and per time of the week.

import { getJson } from './client';
import type { Line } from './stops';

export interface PunctualityEntry {
  /** Median lateness, rounded; 0 or 1 = on time. */
  minutes: number;
  /** 80% of trains came within this. */
  often_minutes: number;
  sample: number;
  days: number;
}

export interface LinePunctuality {
  line: Line;
  /** The whole week; null when only some times of the week have enough data. */
  overall: PunctualityEntry | null;
  /** By time of the week; a time without enough data is missing. */
  bands: Partial<Record<Band, PunctualityEntry>>;
}

export interface PunctualityReport {
  operator_name: string;
  generated_at: string;
  /** False until enough days of observations exist: no line is listed before that. */
  available: boolean;
  min_days: number;
  lines: LinePunctuality[];
}

export const BANDS = [
  'weekday_morning',
  'weekday_midday',
  'weekday_evening',
  'weekday_night',
  'weekend',
] as const;
export type Band = (typeof BANDS)[number];

export const getPunctuality = (fetchImpl: typeof fetch = fetch) =>
  getJson<PunctualityReport>('/punctuality', {}, 8000, fetchImpl);

/** 0 or 1 minute counts as on time (as the "Usually" line on a train). */
export const onTime = (e: PunctualityEntry): boolean => e.minutes <= 1;

/** The time of the week with the worst usual lateness, if clearly worse than the rest. */
export function worstBand(lp: LinePunctuality): Band | null {
  const found = BANDS.flatMap((b) => {
    const e = lp.bands[b];
    return e ? [[b, e.minutes] as const] : [];
  });
  if (found.length < 2) return null;
  const sorted = [...found].sort((a, b) => b[1] - a[1]);
  // Clearly worse: at least 2 min later than the next one.
  return sorted[0][1] - sorted[1][1] >= 2 ? sorted[0][0] : null;
}
