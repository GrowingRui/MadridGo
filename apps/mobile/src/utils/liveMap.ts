// The live trip map (as in SBB Mobile's "Live" map of a single trip): which train or EMT bus
// of a connection to follow, and where a train's point goes on the map. Kept free of React so
// it is easy to test; the train's movement rules are those of the journey timeline
// (trainPosition.ts), the bus's are in busPosition.ts.

import type { Journey } from '../api/journeys';
import type { TripPosition } from '../api/trips';
import { canTrackBus } from './busPosition';
import { canTrack, isShown, shownProgress } from './trainPosition';

/**
 * The leg whose vehicle the map follows: the first Cercanías leg (from 90 min before it
 * leaves) or EMT bus leg (from 45 min before) that is on now or comes next, until just after
 * it arrives. Null when there is none, e.g. a connection for another day, or only Metro.
 */
export function followedLeg(journey: Journey, nowMs: number): number | null {
  const i = journey.legs.findIndex((leg) => canTrack(leg, nowMs) || canTrackBus(leg, nowMs));
  return i >= 0 ? i : null;
}

export interface TrainPoint {
  lon: number;
  lat: number;
  /** Hollow on the map and labelled "Estimated", like the timeline's point. */
  estimated: boolean;
}

/**
 * Where to draw the train now: at its station, or between the station it has left and the next
 * one. With `path` (the leg's track from OTP, [lon, lat]) it follows the track; without one, or
 * when either station is not on it (e.g. before your boarding station), a straight line. Null
 * when the position is not shown (too old, unavailable) or has no coordinates.
 */
export function trainPoint(
  pos: TripPosition | null,
  nowMs: number,
  path?: [number, number][],
): TrainPoint | null {
  if (!pos || !isShown(pos, nowMs)) return null;
  const a = pos.last_stop;
  if (a?.lat == null || a.lon == null) return null;
  const estimated = pos.kind === 'estimated';
  const b = pos.next_stop;
  const p = shownProgress(pos, nowMs);
  if (pos.status === 'at_stop' && !p) return { lon: a.lon, lat: a.lat, estimated };
  if (b?.lat == null || b.lon == null) return { lon: a.lon, lat: a.lat, estimated };
  const f = p ?? 0.5;
  const onTrack = path ? alongTrack(path, [a.lon, a.lat], [b.lon, b.lat], f) : null;
  if (onTrack) return { lon: onTrack[0], lat: onTrack[1], estimated };
  return { lon: a.lon + (b.lon - a.lon) * f, lat: a.lat + (b.lat - a.lat) * f, estimated };
}

// ---------------------------------------------------------------------------
// Along the track (added 2026-11-12): flat metres around the track's first point, fine over
// the few tens of km of a Cercanías leg.

/** How far a station may be from the track to count as on it (OTP's own limit). */
export const ON_TRACK_M = 150;

type LonLat = [number, number];

function metres(path: LonLat[]): { xy: [number, number][]; at: number[] } {
  const kx = 111_320 * Math.cos((path[0][1] * Math.PI) / 180);
  const xy = path.map(([lon, lat]) => [lon * kx, lat * 111_320] as [number, number]);
  const at = [0];
  for (let i = 1; i < xy.length; i++) {
    at.push(at[i - 1] + Math.hypot(xy[i][0] - xy[i - 1][0], xy[i][1] - xy[i - 1][1]));
  }
  return { xy, at };
}

/**
 * The point `f` (0..1) of the way from station a to station b along the track, or null when
 * the track is too short or a station is more than ON_TRACK_M away from it. b is looked for
 * after a, so a track passing a station twice still runs forwards.
 */
export function alongTrack(path: LonLat[], a: LonLat, b: LonLat, f: number): LonLat | null {
  if (path.length < 2) return null;
  const { xy, at } = metres(path);
  const kx = 111_320 * Math.cos((path[0][1] * Math.PI) / 180);
  const find = (p: LonLat, from: number): { m: number; d: number } | null => {
    const [px, py] = [p[0] * kx, p[1] * 111_320];
    let best: { m: number; d: number } | null = null;
    for (let i = 0; i < xy.length - 1; i++) {
      if (at[i + 1] < from) continue;
      const [ax, ay] = xy[i];
      const [dx, dy] = [xy[i + 1][0] - ax, xy[i + 1][1] - ay];
      const len2 = dx * dx + dy * dy;
      let t = len2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / len2;
      t = Math.max(0, Math.min(1, t));
      const len = at[i + 1] - at[i];
      if (at[i] + t * len < from) t = len > 0 ? (from - at[i]) / len : 0;
      const d = Math.hypot(ax + t * dx - px, ay + t * dy - py);
      if (!best || d < best.d) best = { m: at[i] + t * len, d };
    }
    return best && best.d <= ON_TRACK_M ? best : null;
  };
  const pa = find(a, 0);
  const pb = pa ? find(b, pa.m) : null;
  if (!pa || !pb || pb.m <= pa.m) return null;
  const target = pa.m + (pb.m - pa.m) * Math.max(0, Math.min(1, f));
  for (let i = 0; i < xy.length - 1; i++) {
    if (target <= at[i + 1] || i === xy.length - 2) {
      const len = at[i + 1] - at[i];
      const t = len > 0 ? Math.min(1, (target - at[i]) / len) : 0;
      const [p, q] = [path[i], path[i + 1]];
      return [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t];
    }
  }
  return null;
}
