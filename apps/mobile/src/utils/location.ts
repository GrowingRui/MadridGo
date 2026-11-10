// The traveller's position, asked for only when they tap "Current location" (never in the
// background, never stored or sent anywhere except with that one request).

import * as Location from 'expo-location';

export interface Point {
  lat: number;
  lon: number;
}

export type LocationProblem = 'denied' | 'outside' | 'failed';

export class LocationError extends Error {
  constructor(readonly problem: LocationProblem) {
    super(problem);
    this.name = 'LocationError';
  }
}

/** The area the API plans in (Community of Madrid and around); same bounds as the server. */
export function inMadridArea({ lat, lon }: Point): boolean {
  return lat >= 39.8 && lat <= 41.2 && lon >= -4.6 && lon <= -3.0;
}

/** A recent fix is good enough for finding stops; a fresh one is asked for otherwise. */
const MAX_AGE_MS = 60_000;

export async function getCurrentPoint(): Promise<Point> {
  let granted = false;
  try {
    granted = (await Location.requestForegroundPermissionsAsync()).granted;
  } catch {
    throw new LocationError('failed');
  }
  if (!granted) throw new LocationError('denied');

  let pos: Location.LocationObject | null = null;
  try {
    pos =
      (await Location.getLastKnownPositionAsync({ maxAge: MAX_AGE_MS, requiredAccuracy: 200 })) ??
      (await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }));
  } catch {
    throw new LocationError('failed');
  }
  if (!pos) throw new LocationError('failed');
  const point = { lat: pos.coords.latitude, lon: pos.coords.longitude };
  if (!inMadridArea(point)) throw new LocationError('outside');
  return point;
}
