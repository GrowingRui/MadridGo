// Route map data for one connection: each leg as a line in its colour (OTP's shape, or straight
// through its stops) and its stops as dots. Kept free of React so it is easy to test.

import type { Journey } from '../api/journeys';
import type { Line } from '../api/stops';
import { modeColors } from '../theme';
import { decodePolyline } from './polyline';

/** The line's GTFS colour, or the mode's colour when the feed has none. */
function lineColor(line: Line): string {
  return line.color ? `#${line.color}` : (modeColors[line.mode] ?? modeColors.bus).bg;
}

export interface RouteLine {
  coords: [number, number][]; // [lon, lat]
  color: string;
  walk: boolean;
}

export interface RouteStop {
  id: string | null;
  name: string;
  lat: number;
  lon: number;
  color: string;
  /** Start, change or destination (bigger dot with its name); otherwise a stop passed. */
  major: boolean;
}

/**
 * Lines and stops of a connection for the map. Each leg follows OTP's shape; without one it is
 * drawn straight through its stops.
 */
export function routeFeatures(journey: Journey): { lines: RouteLine[]; stops: RouteStop[] } {
  const lines: RouteLine[] = [];
  const stops: RouteStop[] = [];
  const has = (lat?: number | null, lon?: number | null): boolean => lat != null && lon != null;
  const seen = new Set<string>();
  const add = (stop: RouteStop) => {
    const key = `${stop.lat.toFixed(5)},${stop.lon.toFixed(5)}`;
    if (seen.has(key)) return;
    seen.add(key);
    stops.push(stop);
  };
  journey.legs.forEach((leg, i) => {
    const walk = leg.mode === 'walk' || !leg.line;
    const color = walk ? modeColors.walk.bg : lineColor(leg.line!);
    let coords = leg.geometry ? decodePolyline(leg.geometry) : [];
    if (coords.length < 2) {
      coords = [
        has(leg.from_lat, leg.from_lon) ? [leg.from_lon!, leg.from_lat!] : null,
        ...leg.intermediate.map((s) => (has(s.lat, s.lon) ? [s.lon!, s.lat!] : null)),
        has(leg.to_lat, leg.to_lon) ? [leg.to_lon!, leg.to_lat!] : null,
      ].filter((c): c is [number, number] => c != null);
    }
    if (coords.length >= 2) lines.push({ coords, color, walk });
    // Big dots: where you board and leave each vehicle, the start and the destination.
    const last = i === journey.legs.length - 1;
    if ((i === 0 || !walk) && has(leg.from_lat, leg.from_lon)) {
      add({ id: leg.from_stop_id ?? null, name: leg.from, lat: leg.from_lat!, lon: leg.from_lon!, color, major: true });
    }
    if (!walk) {
      for (const s of leg.intermediate) {
        if (has(s.lat, s.lon)) {
          add({ id: s.stop_id ?? null, name: s.name, lat: s.lat!, lon: s.lon!, color, major: false });
        }
      }
    }
    if ((last || !walk) && has(leg.to_lat, leg.to_lon)) {
      add({ id: leg.to_stop_id ?? null, name: leg.to, lat: leg.to_lat!, lon: leg.to_lon!, color, major: true });
    }
  });
  return { lines, stops };
}

/**
 * Only some walks of a connection (a walk row's map, as in SBB Mobile): their path, and big
 * dots where the walk starts (your address or the stop you get off at) and where it ends.
 */
export function walkFeatures(
  journey: Journey,
  legs: number[],
): { lines: RouteLine[]; stops: RouteStop[] } {
  const picked = legs.map((i) => journey.legs[i]).filter((l) => l != null);
  return routeFeatures({ ...journey, legs: picked });
}

/** "2" or "3,4" (the route map's `legs` parameter) as leg indexes; [] when absent or bad. */
export function parseLegs(value: string | string[] | undefined): number[] {
  const s = Array.isArray(value) ? value[0] : value;
  if (!s) return [];
  const legs = s.split(',').map(Number);
  return legs.every((n) => Number.isInteger(n) && n >= 0) ? legs : [];
}
