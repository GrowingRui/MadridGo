// The live trip map (as in SBB Mobile's "Live" map of a single trip): which train of a
// connection to follow, and where its point goes on the map. Kept free of React so it is
// easy to test; the movement rules are those of the journey timeline (trainPosition.ts).

import type { Journey } from '../api/journeys';
import type { TripPosition } from '../api/trips';
import { canTrack, isShown, shownProgress } from './trainPosition';

/**
 * The leg whose train the map follows: the first Cercanías leg that is on now or comes
 * next (from 90 min before it leaves until just after it arrives). Null when there is none,
 * e.g. a connection for another day or without Cercanías.
 */
export function followedLeg(journey: Journey, nowMs: number): number | null {
  const i = journey.legs.findIndex((leg) => canTrack(leg, nowMs));
  return i >= 0 ? i : null;
}

export interface TrainPoint {
  lon: number;
  lat: number;
  /** Hollow on the map and labelled "Estimated", like the timeline's point. */
  estimated: boolean;
}

/**
 * Where to draw the train now: at its station, or on the straight line between the station
 * it has left and the next one (Renfe's GTFS has no shapes, so the route is drawn straight
 * too). Null when the position is not shown (too old, unavailable) or has no coordinates.
 */
export function trainPoint(pos: TripPosition | null, nowMs: number): TrainPoint | null {
  if (!pos || !isShown(pos, nowMs)) return null;
  const a = pos.last_stop;
  if (a?.lat == null || a.lon == null) return null;
  const estimated = pos.kind === 'estimated';
  const b = pos.next_stop;
  const p = shownProgress(pos, nowMs);
  if (pos.status === 'at_stop' && !p) return { lon: a.lon, lat: a.lat, estimated };
  if (b?.lat == null || b.lon == null) return { lon: a.lon, lat: a.lat, estimated };
  const f = p ?? 0.5;
  return { lon: a.lon + (b.lon - a.lon) * f, lat: a.lat + (b.lat - a.lat) * f, estimated };
}
