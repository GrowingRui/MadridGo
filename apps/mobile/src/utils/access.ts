// Step-free travel, as SBB Mobile shows it: can a wheelchair user board and get off?
// The backend sends Renfe's data for Cercanías rides only (services/api/app/access.py);
// for other modes there is no information, and nothing is shown.

import type { Journey, Leg, LegAccess } from '../api/journeys';

/** Boarding or getting off works when both the train and the station are step-free. */
export function combine(vehicle: boolean | null, station: boolean | null): boolean | null {
  if (vehicle === false || station === false) return false;
  if (vehicle === true && station === true) return true;
  return null;
}

export function boardAccess(a?: LegAccess | null): boolean | null {
  return a ? combine(a.vehicle, a.board) : null;
}

export function alightAccess(a?: LegAccess | null): boolean | null {
  return a ? combine(a.vehicle, a.alight) : null;
}

/** A ride: false when you cannot board or get off step-free, true when you can do both. */
export function legAccess(leg: Leg): boolean | null {
  const board = boardAccess(leg.accessibility);
  const alight = alightAccess(leg.accessibility);
  if (board === false || alight === false) return false;
  return board === true && alight === true ? true : null;
}

/**
 * The whole connection, for its row in the list: false as soon as one ride is not
 * step-free; true only when every ride is known to be (a Metro or bus ride, with no
 * information, leaves it unknown).
 */
export function journeyAccess(j: Journey): boolean | null {
  const rides = j.legs.filter((l) => l.mode !== 'walk').map(legAccess);
  if (rides.includes(false)) return false;
  return rides.length > 0 && rides.every((r) => r === true) ? true : null;
}
