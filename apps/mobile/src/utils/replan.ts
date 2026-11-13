// Re-planning from the next stop (R12, SBB's "alternative connections"): when a connection has
// a problem (a cancelled train, a change that no longer works or is at risk), search again from
// where the traveller will be next, leaving the cancelled trains out.
// Uses the times already on the journey (live where known); no extra requests.

import type { Journey, Leg } from '../api/journeys';
import { expectedMs, tripPhase } from '../state/connections';
import type { Place } from '../state/planner';

export type ReplanReason = 'cancelled' | 'notFeasible' | 'atRisk';

export interface Replan {
  /** Where the new search starts: the journey's start, or a stop on the way. */
  from: Place;
  /** Earliest departure (ms); null: now. */
  at: number | null;
  /** Cancelled timetabled trains to leave out. */
  avoid: string[];
}

/** An upcoming journey is re-planned from a little before it was due to leave. */
const LEAD_MS = 10 * 60_000;

const isRide = (l: Leg) => l.mode !== 'walk';

/** Why the connection should offer alternatives now; null when it is fine or over. */
export function replanReason(journey: Journey, now: number = Date.now()): ReplanReason | null {
  if (tripPhase(journey, now) === 'over') return null;
  const ahead = (l: Leg) => expectedMs(l.arrival) > now;
  if (journey.legs.some((l) => isRide(l) && l.departure.status === 'cancelled' && ahead(l))) {
    return 'cancelled';
  }
  if (!journey.feasible) return 'notFeasible';
  const atRisk = journey.changes.some(
    (c) => c.label === 'at_risk' && expectedMs(journey.legs[c.to_leg].departure) > now,
  );
  return atRisk ? 'atRisk' : null;
}

/** A stop as a planner place: its id, else its point with its name. */
function stopPlace(
  name: string,
  id: string | null | undefined,
  lat: number | null | undefined,
  lon: number | null | undefined,
): Place | null {
  if (id) return { id, name };
  if (lat == null || lon == null) return null;
  return { id: `${lat.toFixed(5)},${lon.toFixed(5)}`, name, lat, lon };
}

const boardingStop = (l: Leg) => stopPlace(l.from, l.from_stop_id, l.from_lat, l.from_lon);
const alightingStop = (l: Leg) => stopPlace(l.to, l.to_stop_id, l.to_lat, l.to_lon);

/**
 * Where and when to search again from, at `now`:
 * - not left yet: from the start, from 10 min before the planned departure (or now);
 * - walking to the first vehicle, or waiting for a cancelled one there: from that stop, now;
 * - on a vehicle: from its next stop, at the time it gets there (staying on it stays an option);
 * - at a change (or the next vehicle is cancelled): from the stop you got off at, now;
 * - past the last vehicle: nothing to re-plan (null).
 * `start` is the place the journey was planned from; `to` its destination.
 */
export function replanFrom(
  journey: Journey,
  start: Place,
  to: Place,
  now: number = Date.now(),
): Replan | null {
  const legs = journey.legs;
  const rides = legs.map((l, i) => (isRide(l) ? i : -1)).filter((i) => i >= 0);
  if (!rides.length) return null;
  const avoid = [
    ...new Set(
      legs
        .filter((l) => isRide(l) && l.departure.status === 'cancelled' && l.headway_min == null)
        .map((l) => l.trip_id)
        .filter((id): id is string => !!id),
    ),
  ];
  const result = (from: Place | null, at: number | null): Replan | null => {
    if (!from || from.id === to.id) return null;
    return { from, at: at != null && at > now ? at : null, avoid };
  };

  const leaves = expectedMs(journey.departure);
  if (now < leaves) return result(start, leaves - LEAD_MS);

  // Where you are before ride k: walking to the first stop, or got off the ride before it.
  const here = (k: number) =>
    k === 0 ? boardingStop(legs[rides[0]]) : alightingStop(legs[rides[k - 1]]);
  for (let k = 0; k < rides.length; k++) {
    const leg = legs[rides[k]];
    const dep = expectedMs(leg.departure);
    const arr = expectedMs(leg.arrival);
    // Not on this vehicle yet, or it is cancelled: search from where you are, now.
    if (now < dep || leg.departure.status === 'cancelled') return result(here(k), null);
    if (now < arr) {
      // On it: the next stop, with the timetable moved by the live delay at departure.
      const shift = dep - Date.parse(leg.departure.scheduled);
      const next = leg.intermediate.find((s) => Date.parse(s.time) + shift > now);
      if (next) {
        return result(
          stopPlace(next.name, next.stop_id, next.lat, next.lon),
          Date.parse(next.time) + shift,
        );
      }
      return k === rides.length - 1 ? null : result(alightingStop(leg), arr);
    }
  }
  return null; // past the last vehicle: only the walk to the destination is left
}
