// Where to draw the live train point on a journey leg, and how it moves between updates.
//
// How the point moves (decided 2026-11-10, after looking at how SBB does it): SBB places
// vehicles from real-time departure and arrival times, so its point keeps moving between
// updates. Renfe sends a position every 20-30 s, but mostly the coordinates of the last
// station (live check 2026-11-10), so MadridGo mixes both:
// - Each update puts the point where the server places the train (GPS when it is off the
//   station, otherwise Renfe's predicted times), gliding there in ~1 s.
// - Between updates it moves on at the timetable's pace from that station to the next,
//   but for at most MAX_AHEAD_S after the fix and never onto the next station. A train held
//   at a signal therefore makes the point stop after a few seconds, not run on.
// - A train standing at a station stays on it until an update says it has left.
// - No position older than MAX_AGE_S (STALE, as the backend): the point disappears.
// - Estimated (added 2026-11-10 at the user's request, as SBB shows a point for every
//   train): when Renfe gives no usable position, the server places the train from the
//   timetable (plus Renfe's live delay when known), and the point moves with the clock.
//   It is drawn hollow and always labelled "Estimated".
// - Never backwards (keepForward): Renfe positions sometimes step back a station.

import { type Leg, type LegTime } from '../api/journeys';
import type { TripPosition } from '../api/trips';

export const MAX_AGE_S = 180;
export const MAX_AHEAD_S = 45;
const MIN_BETWEEN = 0.05;
const MAX_BETWEEN = 0.95;
const TRACK_BEFORE_MS = 90 * 60_000;
const TRACK_AFTER_MS = 2 * 60_000;

function liveOrScheduled(t: LegTime): number {
  return Date.parse(t.status === 'live' && t.estimated ? t.estimated : t.scheduled);
}

/**
 * Worth asking for this leg's train position: a Renfe Cercanías leg (the only operator
 * with positions) from 90 min before departure until just after arrival. Trip ids repeat
 * every day, so a journey for another day must never show today's train.
 */
export function canTrack(leg: Leg, nowMs: number): boolean {
  if (!leg.trip_id?.startsWith('cercanias:') || leg.departure.status === 'cancelled') return false;
  return (
    nowMs >= liveOrScheduled(leg.departure) - TRACK_BEFORE_MS &&
    nowMs <= liveOrScheduled(leg.arrival) + TRACK_AFTER_MS
  );
}

export function positionAgeS(pos: TripPosition, nowMs: number): number | null {
  if (!pos.observed_at) return null;
  return Math.max(0, Math.round((nowMs - Date.parse(pos.observed_at)) / 1000));
}

/** "position 20 s ago", "position 2 min ago". */
export function ageText(ageS: number): string {
  return ageS < 120 ? `position ${ageS} s ago` : `position ${Math.floor(ageS / 60)} min ago`;
}

/** Only recent positions are drawn. The age is checked here too: polling may have stopped. */
export function isShown(pos: TripPosition, nowMs: number): boolean {
  const age = positionAgeS(pos, nowMs);
  return pos.status !== 'unavailable' && !!pos.last_stop && age != null && age <= MAX_AGE_S;
}

/** Share of the way from `from` to `to` at `nowMs`, kept off both stations. */
function timeShare(from: string, to: string, nowMs: number): number | null {
  const a = Date.parse(from);
  const b = Date.parse(to);
  if (!(b > a)) return null;
  return Math.max(MIN_BETWEEN, Math.min(MAX_BETWEEN, (nowMs - a) / (b - a)));
}

/** 0..1 between last_stop and next_stop to draw now (see the rules at the top). */
export function shownProgress(pos: TripPosition, nowMs: number): number | null {
  if (pos.kind === 'estimated') {
    // Pure timetable (plus live delay): moves with the clock, like SBB's point.
    if (pos.status === 'at_stop') {
      const leaving = pos.departs_at && nowMs >= Date.parse(pos.departs_at);
      return leaving && pos.expected_at_next
        ? (timeShare(pos.departs_at!, pos.expected_at_next, nowMs) ?? 0)
        : 0;
    }
    if (pos.left_at && pos.expected_at_next) {
      return timeShare(pos.left_at, pos.expected_at_next, nowMs) ?? pos.progress ?? null;
    }
    return pos.progress ?? null;
  }
  if (pos.status === 'at_stop') return 0;
  if (pos.progress == null) return null;
  // Live, placed from Renfe's predicted times (no GPS fix off the station): moves with the
  // clock towards the predicted arrival, never behind the server's own placement.
  if (pos.progress_basis === 'timetable' && pos.left_at && pos.expected_at_next) {
    const p = timeShare(pos.left_at, pos.expected_at_next, nowMs);
    if (p != null) return Math.max(pos.progress, p);
  }
  const age = positionAgeS(pos, nowMs);
  if (!pos.segment_run_s || age == null) return pos.progress;
  const ahead = Math.min(age, MAX_AHEAD_S) / pos.segment_run_s;
  return Math.max(pos.progress, Math.min(MAX_BETWEEN, pos.progress + ahead));
}

export type Placement =
  /**
   * Before the boarding stop: shown above it. One stop away and on its way, it moves down
   * towards the boarding stop (`progress` 0..1); otherwise it waits at the top (0).
   */
  | { kind: 'approaching'; stopsAway: number; at: boolean; near: string; progress: number }
  /** On the leg: between rows `row` and `row + 1` of [boarding, ...intermediate, alighting]. */
  | { kind: 'riding'; row: number; progress: number | null; at: boolean }
  | { kind: 'none' };

export function legRows(leg: Leg): (string | null | undefined)[] {
  return [leg.from_stop_id, ...leg.intermediate.map((s) => s.stop_id), leg.to_stop_id];
}

export function place(pos: TripPosition, leg: Leg, nowMs: number): Placement {
  if (!isShown(pos, nowMs) || !pos.last_stop) return { kind: 'none' };
  const progress = shownProgress(pos, nowMs);
  // An estimated train standing at a station starts moving at its departure time.
  const at = pos.status === 'at_stop' && progress === 0;
  const rows = legRows(leg);
  const row = rows.indexOf(pos.last_stop.stop_id);
  if (row >= 0) {
    // Left the alighting stop: this leg is over.
    if (row === rows.length - 1 && !at) return { kind: 'none' };
    return { kind: 'riding', row, progress, at };
  }
  if (pos.stops_away != null && pos.stops_away > 0) {
    const moving = pos.stops_away === 1 && !at && pos.status !== 'unavailable';
    return {
      kind: 'approaching',
      stopsAway: pos.stops_away,
      at,
      near: pos.last_stop.name,
      progress: moving ? (progress ?? 0.5) : 0,
    };
  }
  return { kind: 'none' }; // passed, or a stop the leg does not list
}

/**
 * Where to draw the point on a trip's full list of stops (the trip screen): between stop
 * `row` and `row + 1` of the whole trip, from its origin.
 */
export function placeOnTrip(
  pos: TripPosition,
  nowMs: number,
): { row: number; progress: number | null; at: boolean } | null {
  if (!isShown(pos, nowMs) || !pos.last_stop) return null;
  const progress = shownProgress(pos, nowMs);
  return { row: pos.last_stop.index, progress, at: pos.status === 'at_stop' && progress === 0 };
}

/** "Train is 2 stops away · at Getafe Centro". */
export function approachText(p: { stopsAway: number; at: boolean; near: string }): string {
  const n = p.stopsAway;
  return `Train is ${n} stop${n === 1 ? '' : 's'} away · ${p.at ? 'at' : 'after'} ${p.near}`;
}

/** "Now between Getafe Centro and Las Margaritas", "Now at Getafe Centro". */
export function ridingText(pos: TripPosition, at: boolean): string {
  const last = pos.last_stop?.name ?? '';
  if (at || !pos.next_stop) return `Now at ${last}`;
  return `Now between ${last} and ${pos.next_stop.name}`;
}

/**
 * Where the position comes from, always shown next to it: "Live · position 20 s ago",
 * "Estimated from the timetable" or "Estimated · timetable + 4 min live delay".
 */
export function sourceText(pos: TripPosition, ageS: number | null): string {
  if (pos.kind === 'estimated') {
    const late = pos.delay_s ? Math.round(pos.delay_s / 60) : 0;
    if (pos.delay_s != null && late > 0) return `Estimated · timetable + ${late} min live delay`;
    if (pos.delay_s != null) return 'Estimated · timetable, on time (live)';
    return 'Estimated from the timetable';
  }
  return ageS != null ? `Live · ${ageText(ageS)}` : 'Live';
}

/**
 * Vertical position of the point, from the measured centre of each row's stop marker
 * (undefined for rows not on screen, e.g. hidden intermediate stops). With the rows of the
 * segment hidden, the point is spread evenly between the boarding and alighting stops.
 */
export function trackY(
  ys: (number | undefined)[],
  row: number,
  progress: number | null,
): number | null {
  const p = progress ?? 0.5;
  const a = ys[row];
  const b = ys[row + 1];
  if (a != null && p === 0) return a;
  if (a != null && b != null) return a + (b - a) * p;
  const first = ys[0];
  const last = ys[ys.length - 1];
  if (first == null || last == null || ys.length < 2) return null;
  return first + ((last - first) * (row + p)) / (ys.length - 1);
}

function along(p: TripPosition): number | null {
  if (!p.last_stop || p.status === 'unavailable') return null;
  return p.last_stop.index + (p.status === 'between' ? (p.progress ?? 0.5) : 0);
}

/**
 * Renfe positions sometimes step back a station; trains do not. A new position behind the
 * previous one is ignored while the previous one is still recent (it keeps its own age, so
 * the "position N s ago" text stays true, and it disappears when too old).
 */
export function keepForward(
  prev: TripPosition | null,
  next: TripPosition,
  nowMs: number,
): TripPosition {
  if (!prev || prev.trip_id !== next.trip_id) return next;
  const a = along(prev);
  const b = along(next);
  return a != null && b != null && b < a && isShown(prev, nowMs) ? prev : next;
}
