// Every Cercanías train on the map (Plan > Map > Live trains): services/api/app/trains.py.

import { getJson } from './client';
import type { Freshness, Line } from './stops';
import type { TripPosition } from './trips';

/** One train, placed exactly as on the trip screen, with its line and direction. */
export interface LiveTrain extends TripPosition {
  line?: Line | null;
  headsign?: string | null;
  /** The track from last_stop to next_stop, [lon, lat]; null: draw a straight line. */
  path?: [number, number][] | null;
}

export interface LiveTrains {
  trains: LiveTrain[];
  freshness?: Freshness | null;
  observed_at?: string | null;
  /** Why there are no trains (Renfe's data unavailable or outdated). */
  message?: string | null;
  source: string;
  attribution: string;
  poll_after_s: number;
}

export interface TrainLine {
  line: Line;
  /** Google encoded polylines (utils/polyline.ts). */
  paths: string[];
}

export interface TrainLines {
  lines: TrainLine[];
  /** False: the tracks could not be read; the trains still come. */
  available: boolean;
}

export function getLiveTrains(fetchImpl: typeof fetch = fetch): Promise<LiveTrains> {
  return getJson<LiveTrains>('/trains/live', {}, 10_000, fetchImpl);
}

export function getTrainLines(fetchImpl: typeof fetch = fetch): Promise<TrainLines> {
  return getJson<TrainLines>('/trains/lines', {}, 15_000, fetchImpl);
}
