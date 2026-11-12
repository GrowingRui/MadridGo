// Where the bus of an EMT journey leg is now (services/api/app/buses.py).

import { getJson } from './client';
import type { Freshness } from './stops';

export interface BusPosition {
  /** approaching: on its way to your boarding stop. riding: on your leg. */
  status: 'approaching' | 'riding' | 'unavailable';
  reason?: 'not_configured' | 'not_found' | 'outdated' | null;
  message: string;
  line: string;
  vehicle_id?: string | null;
  /** Metres along the route to your boarding stop (approaching) or alighting stop (riding). */
  distance_m?: number | null;
  /** Seconds until the bus reaches that stop, when EMT answered. */
  seconds?: number | null;
  expected_at?: string | null;
  /** approaching: the bus's last GPS fix (roughly the last stop it served). */
  lat?: number | null;
  lon?: number | null;
  /** When EMT answered: EMT gives no observation time of its own. */
  observed_at?: string | null;
  freshness?: Freshness | null;
  source: string;
  attribution: string;
  poll_after_s: number;
}

export interface BusQuery {
  line: string;
  fromStop: string;
  toStop: string;
  fromName?: string | null;
  vehicle?: string | null;
  routeM?: number | null;
}

export function getBusPosition(q: BusQuery, fetchImpl: typeof fetch = fetch): Promise<BusPosition> {
  return getJson<BusPosition>(
    '/buses/position',
    {
      line: q.line,
      from_stop: q.fromStop,
      to_stop: q.toStop,
      from_name: q.fromName ?? undefined,
      vehicle: q.vehicle ?? undefined,
      route_m: q.routeM != null ? Math.round(q.routeM) : undefined,
    },
    8000,
    fetchImpl,
  );
}
