// Where to draw your EMT bus on the live trip map, and what to say about it.
//
// EMT gives no vehicle feed, only arrivals per stop (services/api/app/buses.py):
// - Before you board, the bus's last GPS fix. EMT updates it mostly at stops (live check of
//   2026-11-12), so the point stands near the last stop the bus served until the next fix.
//   The card gives what EMT measures well: metres along the route and minutes to your stop.
// - On the bus, the metres still to go to your alighting stop. The point is placed that far
//   before the stop on the leg's own path, and between updates moves on at the bus's own
//   pace (metres / seconds EMT predicts) for at most MAX_AHEAD_S, never past the stop.
// - Nothing older than MAX_AGE_S is drawn, as for trains.

import type { BusPosition, BusQuery } from '../api/buses';
import type { Leg, LegTime } from '../api/journeys';
import { locale, t } from '../i18n';
import type { TrainPoint } from './liveMap';
import { decodePolyline } from './polyline';
import type { TripDetails } from '../api/trips';
import { MAX_AGE_S, MAX_AHEAD_S, type Placement } from './trainPosition';

// EMT lists the next buses up to about 45 min ahead.
const TRACK_BEFORE_MS = 45 * 60_000;
const TRACK_AFTER_MS = 2 * 60_000;

function liveOrScheduled(time: LegTime): number {
  return Date.parse(time.status === 'live' && time.estimated ? time.estimated : time.scheduled);
}

const isEmt = (id: string | null | undefined) => !!id && id.startsWith('emt:');

/** Worth asking where this leg's bus is: an EMT leg, from 45 min before it leaves. */
export function canTrackBus(leg: Leg, nowMs: number): boolean {
  if (!isEmt(leg.trip_id) || !isEmt(leg.from_stop_id) || !isEmt(leg.to_stop_id)) return false;
  if (!leg.line?.short_name || leg.departure.status === 'cancelled') return false;
  return (
    nowMs >= liveOrScheduled(leg.departure) - TRACK_BEFORE_MS &&
    nowMs <= liveOrScheduled(leg.arrival) + TRACK_AFTER_MS
  );
}

/** The question for the server; `vehicle` is the bus found by the last answer, if any. */
export function busQuery(leg: Leg, vehicle?: string | null): BusQuery {
  return {
    line: leg.line?.short_name ?? '',
    fromStop: leg.from_stop_id ?? '',
    toStop: leg.to_stop_id ?? '',
    fromName: leg.from,
    vehicle: vehicle ?? leg.departure.realtime?.vehicle_id ?? null,
    routeM: leg.distance_m ?? null,
  };
}

export function busAgeS(pos: BusPosition, nowMs: number): number | null {
  if (!pos.observed_at) return null;
  return Math.max(0, Math.round((nowMs - Date.parse(pos.observed_at)) / 1000));
}

export function isBusShown(pos: BusPosition | null, nowMs: number): boolean {
  if (!pos || pos.status === 'unavailable' || pos.distance_m == null) return false;
  const age = busAgeS(pos, nowMs);
  return age != null && age <= MAX_AGE_S;
}

/** Metres still to go to the stop now: EMT's figure, moved on at the bus's own pace. */
export function metresToGo(pos: BusPosition, nowMs: number): number | null {
  if (pos.distance_m == null) return null;
  const age = busAgeS(pos, nowMs) ?? 0;
  if (!pos.seconds || pos.seconds <= 0) return pos.distance_m;
  const speed = pos.distance_m / pos.seconds;
  return Math.max(0, pos.distance_m - speed * Math.min(age, MAX_AHEAD_S));
}

function metres(a: [number, number], b: [number, number]): number {
  const k = Math.cos(((a[1] + b[1]) / 2) * (Math.PI / 180));
  return Math.hypot((b[0] - a[0]) * 111_320 * k, (b[1] - a[1]) * 111_320);
}

/** The point at `fraction` (0..1) of the way along a line of [lon, lat] points. */
export function pointAlong(coords: [number, number][], fraction: number): [number, number] | null {
  if (coords.length === 0) return null;
  if (coords.length === 1) return coords[0];
  const parts = coords.slice(1).map((c, i) => metres(coords[i], c));
  const total = parts.reduce((s, d) => s + d, 0);
  if (!(total > 0)) return coords[0];
  let left = Math.max(0, Math.min(1, fraction)) * total;
  for (let i = 0; i < parts.length; i++) {
    if (left <= parts[i] || i === parts.length - 1) {
      const f = parts[i] > 0 ? Math.min(1, left / parts[i]) : 0;
      const [a, b] = [coords[i], coords[i + 1]];
      return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
    }
    left -= parts[i];
  }
  return coords[coords.length - 1];
}

/** Where to draw the bus now, or null (not found, too old, no fix). Never "estimated". */
export function busPoint(pos: BusPosition | null, leg: Leg, nowMs: number): TrainPoint | null {
  if (!pos || !isBusShown(pos, nowMs)) return null;
  if (pos.status === 'approaching') {
    return pos.lat != null && pos.lon != null
      ? { lon: pos.lon, lat: pos.lat, estimated: false }
      : null;
  }
  const coords = leg.geometry ? decodePolyline(leg.geometry) : [];
  const toGo = metresToGo(pos, nowMs);
  const route = leg.distance_m;
  if (coords.length < 2 || toGo == null || !route) return null;
  const at = pointAlong(coords, 1 - toGo / route);
  return at ? { lon: at[0], lat: at[1], estimated: false } : null;
}

// ---------------------------------------------------------------------------
// The bus on the journey timeline and the trip screen (added 2026-11-12). Same picture as for
// trains (utils/trainPosition.ts): above your stop while it comes, between the stops on your
// leg once you are on it. Always solid (live): without an EMT answer there is no point.

/** Seconds still to go to the stop now: EMT's figure, counted down for at most MAX_AHEAD_S. */
export function secondsToGo(pos: BusPosition, nowMs: number): number | null {
  if (pos.seconds == null) return null;
  const age = busAgeS(pos, nowMs) ?? 0;
  return Math.max(0, pos.seconds - Math.min(age, MAX_AHEAD_S));
}

/**
 * Row and share of the way (0..1) to the next row for `value` on increasing `marks` (one per
 * row: metres or times). Before the first mark: at row 0; after the last: at the last row.
 */
export function rowAt(marks: number[], value: number): { row: number; progress: number } | null {
  const n = marks.length;
  if (n < 2 || marks.some((m) => !Number.isFinite(m))) return null;
  if (value <= marks[0]) return { row: 0, progress: 0 };
  if (value >= marks[n - 1]) return { row: n - 1, progress: 0 };
  for (let i = 0; i < n - 1; i++) {
    if (value < marks[i + 1]) {
      const span = marks[i + 1] - marks[i];
      return { row: i, progress: span > 0 ? (value - marks[i]) / span : 0 };
    }
  }
  return { row: n - 1, progress: 0 };
}

/** The stop's share of the way along the line (0..1), searching on from segment `from`. */
function projectOnto(
  coords: [number, number][],
  cum: number[],
  stop: [number, number],
  from: number,
): { share: number; seg: number } {
  let best = { d: Infinity, share: 0, seg: from };
  for (let i = from; i < coords.length - 1; i++) {
    const [a, b] = [coords[i], coords[i + 1]];
    const k = Math.cos(stop[1] * (Math.PI / 180));
    const [ax, ay, bx, by, px, py] = [a[0] * k, a[1], b[0] * k, b[1], stop[0] * k, stop[1]];
    const len2 = (bx - ax) ** 2 + (by - ay) ** 2;
    const f = len2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * (bx - ax) + (py - ay) * (by - ay)) / len2)) : 0;
    const d = Math.hypot(ax + (bx - ax) * f - px, ay + (by - ay) * f - py);
    if (d < best.d) best = { d, share: cum[i] + (cum[i + 1] - cum[i]) * f, seg: i };
  }
  const total = cum[cum.length - 1];
  return { share: total > 0 ? best.share / total : 0, seg: best.seg };
}

/**
 * Each row's share of the way along the leg (boarding stop 0 .. alighting stop 1), from the
 * stops' coordinates on the leg's own path (straight between the stops without one); null
 * when a stop has no coordinates.
 */
export function stopShares(leg: Leg): number[] | null {
  const stops = [
    [leg.from_lon, leg.from_lat],
    ...leg.intermediate.map((s) => [s.lon, s.lat]),
    [leg.to_lon, leg.to_lat],
  ];
  if (stops.some(([lon, lat]) => lon == null || lat == null)) return null;
  const pts = stops as [number, number][];
  let coords = leg.geometry ? decodePolyline(leg.geometry) : [];
  if (coords.length < 2) coords = pts;
  const cum = [0];
  for (let i = 1; i < coords.length; i++) cum.push(cum[i - 1] + metres(coords[i - 1], coords[i]));
  if (!(cum[cum.length - 1] > 0)) return null;
  let seg = 0;
  const shares = pts.map((p, i) => {
    if (i === 0) return 0;
    if (i === pts.length - 1) return 1;
    const r = projectOnto(coords, cum, p, seg);
    seg = r.seg;
    return r.share;
  });
  // Never backwards (a stop projected slightly behind the previous one).
  for (let i = 1; i < shares.length; i++) shares[i] = Math.max(shares[i], shares[i - 1]);
  return shares;
}

/**
 * Where to draw the bus on the journey timeline (the same placements as a train's).
 * Approaching: at the top of the line above your stop (EMT gives minutes and metres, not
 * the stops in between). Riding: between the leg's stops by the metres still to go on the
 * leg's path, as on the live map; without stop coordinates, by EMT's seconds to go on the
 * timetable's times.
 */
export function placeBus(pos: BusPosition | null, leg: Leg, nowMs: number): Placement {
  if (!pos || !isBusShown(pos, nowMs)) return { kind: 'none' };
  if (pos.status === 'approaching') {
    return { kind: 'approaching', stopsAway: 0, at: false, near: '', progress: 0 };
  }
  let at: { row: number; progress: number } | null = null;
  const shares = stopShares(leg);
  const toGo = metresToGo(pos, nowMs);
  if (shares && toGo != null && leg.distance_m) {
    at = rowAt(shares, 1 - toGo / leg.distance_m);
  }
  if (!at) {
    const secs = secondsToGo(pos, nowMs);
    const times = [
      leg.departure.scheduled,
      ...leg.intermediate.map((s) => s.time),
      leg.arrival.scheduled,
    ].map(Date.parse);
    if (secs != null) at = rowAt(times, times[times.length - 1] - secs * 1000);
  }
  if (!at) return { kind: 'none' };
  return { kind: 'riding', row: at.row, progress: at.progress, at: at.progress === 0 };
}

/**
 * Where to draw the bus on the trip screen's full list of stops. On your leg: as on the
 * journey timeline, moved to the trip's rows. Before your stop: by EMT's seconds to your
 * stop on the timetable's times between the stops (the trip screen lists them).
 */
export function placeBusOnTrip(
  pos: BusPosition | null,
  leg: Leg,
  trip: TripDetails,
  nowMs: number,
): { row: number; progress: number | null; at: boolean } | null {
  if (!pos || !isBusShown(pos, nowMs)) return null;
  const board = trip.board_index;
  if (board == null) return null;
  const alight = trip.alight_index ?? trip.stops.length - 1;
  if (pos.status === 'riding' && alight - board === leg.intermediate.length + 1) {
    const p = placeBus(pos, leg, nowMs);
    return p.kind === 'riding' ? { row: board + p.row, progress: p.progress, at: p.at } : null;
  }
  const anchor = pos.status === 'riding' ? alight : board;
  const secs = secondsToGo(pos, nowMs);
  const times = trip.stops
    .slice(0, anchor + 1)
    .map((s) => Date.parse((s.departure ?? s.arrival) as string));
  if (secs == null || times.length < 2) return null;
  const at = rowAt(times, times[times.length - 1] - secs * 1000);
  return at ? { row: at.row, progress: at.progress, at: at.progress === 0 } : null;
}

/** "600 m", "1.2 km" (Spanish: "1,2 km"). */
export function distanceText(m: number): string {
  if (m < 950) return `${Math.max(10, Math.round(m / 10) * 10)} m`;
  const km = (m / 1000).toLocaleString(locale(), {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });
  return `${km} km`;
}

/** The card's main line: "Bus arrives in 4 min · 1.2 km away", "2.3 km to Plaza Castilla". */
export function busText(pos: BusPosition, leg: Leg, nowMs: number): string {
  const toGo = metresToGo(pos, nowMs) ?? 0;
  if (pos.status === 'riding') return t('bus.riding', { dist: distanceText(toGo), stop: leg.to });
  const left = pos.expected_at ? (Date.parse(pos.expected_at) - nowMs) / 60_000 : null;
  if (left == null || left < 1) return t('bus.arrivingNow', { dist: distanceText(toGo) });
  return t('bus.approach', { min: Math.round(left), dist: distanceText(toGo) });
}

/**
 * Where it comes from, always shown: "Live · EMT, 15 s ago", and on the map what the map
 * point means (`mapNote`; the timelines draw no GPS fix).
 */
export function busSourceText(pos: BusPosition, nowMs: number, mapNote = true): string {
  const age = busAgeS(pos, nowMs);
  const ago = age == null ? null : age < 120 ? `${age} s` : `${Math.floor(age / 60)} min`;
  const live = ago != null ? t('bus.liveAge', { age: ago }) : t('pos.live');
  if (mapNote && pos.status === 'approaching') {
    return `${live} · ${pos.lat != null ? t('bus.gpsNote') : t('bus.noGps')}`;
  }
  return live;
}

/**
 * EMT's metres to go sometimes go up again between answers (live check of 2026-11-12:
 * 1,478 m, then 1,579 m 22 s later); buses do not go back. While the previous answer is
 * still recent, the new one cannot put the same bus further away than it was shown.
 */
export function busKeepForward(
  prev: BusPosition | null,
  next: BusPosition,
  nowMs: number,
): BusPosition {
  if (
    !prev ||
    !isBusShown(prev, nowMs) ||
    prev.status !== next.status ||
    prev.vehicle_id !== next.vehicle_id ||
    next.distance_m == null
  ) {
    return next;
  }
  const shown = metresToGo(prev, nowMs);
  if (shown == null || next.distance_m <= shown) return next;
  return { ...next, distance_m: Math.round(shown) };
}
