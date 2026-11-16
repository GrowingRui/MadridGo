// How accurate MadridGo's live times have been (services/api/app/realtime/api.py, GET /accuracy;
// RELIABILITY_STRATEGY.md §4). Renfe Cercanías only for now.

import { getJson } from './client';
import type { Line } from './stops';

export interface AccuracyRow {
  /** '*' = all lines together. */
  line: string;
  /** schedule = the timetable alone, i.e. how well trains kept it; not_departed = times
   * shown while the train still stood at its first station ("Not departed yet"). */
  kind: 'prediction' | 'not_departed' | 'schedule';
  /** Minutes before the arrival the time was shown; null for the timetable. */
  horizon_min: number | null;
  /** "Live · est.": the delay carried forward to a station after the one Renfe names. */
  estimated: boolean;
  n: number;
  mae_s: number;
  median_abs_s: number;
  p90_abs_s: number;
  /** Actual - shown, on average: > 0 means trains came later than shown. */
  bias_s: number;
  /** Shares (0-1) within 1, 2 and 5 minutes. */
  pct_1m: number;
  pct_2m: number;
  pct_5m: number;
}

export interface AccuracyReport {
  operator: string;
  operator_name: string;
  first_day: string;
  last_day: string;
  days: number;
  days_with_data: number;
  provisional: boolean;
  min_sample: number;
  min_days: number;
  generated_at: string;
  lines: Line[];
  rows: AccuracyRow[];
}

export const ALL_LINES = '*';
export const PERIODS = [1, 7, 30] as const;
export type Period = (typeof PERIODS)[number];

/** Below this many arrivals a row says "too few" instead of showing a share. */
export const MIN_ROW = 20;

export function getAccuracy(days: Period, fetchImpl: typeof fetch = fetch): Promise<AccuracyReport> {
  return getJson<AccuracyReport>('/accuracy', { days }, 15000, fetchImpl);
}

/** The live rows for one line (or all), latest horizon last: 30, 20, 10, 5, 2 min. */
export function liveRows(r: AccuracyReport, line: string, estimated: boolean): AccuracyRow[] {
  return r.rows
    .filter((x) => x.line === line && x.kind === 'prediction' && x.estimated === estimated)
    .sort((a, b) => (b.horizon_min ?? 0) - (a.horizon_min ?? 0));
}

/** Times shown while the train had not left its first station, latest horizon last. */
export function notDepartedRows(r: AccuracyReport, line: string): AccuracyRow[] {
  return r.rows
    .filter((x) => x.line === line && x.kind === 'not_departed')
    .sort((a, b) => (b.horizon_min ?? 0) - (a.horizon_min ?? 0));
}

export function timetableRow(r: AccuracyReport, line: string): AccuracyRow | null {
  return r.rows.find((x) => x.line === line && x.kind === 'schedule') ?? null;
}

/** 104 -> "1 min 44 s", 40 -> "40 s", 120 -> "2 min" (rounded to 5 s: the arrival is ±10 s). */
export function formatSeconds(s: number): string {
  const total = Math.round(Math.abs(s) / 5) * 5;
  const m = Math.floor(total / 60);
  const sec = total % 60;
  if (m === 0) return `${sec} s`;
  return sec === 0 ? `${m} min` : `${m} min ${sec} s`;
}

/** 0.6012 -> "60%". */
export function formatPct(share: number): string {
  return `${Math.round(share * 100)}%`;
}

/** On average later, earlier or on time (within 15 s). */
export function biasDirection(bias_s: number): 'later' | 'earlier' | 'onTime' {
  if (Math.abs(bias_s) < 15) return 'onTime';
  return bias_s > 0 ? 'later' : 'earlier';
}
