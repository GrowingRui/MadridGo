// Live trains on Plan > Map: where to draw every Cercanías train now. Each train moves by the
// rules of the trip screen and the live trip map (trainPosition.ts, liveMap.ts): placed by
// each update, then on at the timetable's pace along the track, never backwards, hidden when
// too old, and drawn hollow when estimated.

import type { LiveTrain } from '../api/trains';
import { trainPoint } from './liveMap';
import { isShown, keepForward, shownProgress } from './trainPosition';

export interface TrainDot {
  id: string;
  lon: number;
  lat: number;
  /** #RRGGBB of the line. */
  color: string;
  estimated: boolean;
  /** The line's short name, e.g. "C5". */
  label: string;
}

export const DEFAULT_TRAIN_COLOR = '#E2001A';

export function trainColor(train: LiveTrain): string {
  return train.line?.color ? `#${train.line.color}` : DEFAULT_TRAIN_COLOR;
}

/** The trains to draw now; with `line`, only that line's. */
export function trainDots(trains: LiveTrain[], nowMs: number, line: string | null): TrainDot[] {
  const out: TrainDot[] = [];
  for (const train of trains) {
    if (line && train.line?.short_name !== line) continue;
    const p = trainPoint(train, nowMs, train.path ?? undefined);
    if (!p) continue;
    out.push({
      id: train.trip_id,
      lon: p.lon,
      lat: p.lat,
      color: trainColor(train),
      estimated: p.estimated,
      label: train.line?.short_name ?? '',
    });
  }
  return out;
}

/**
 * A new answer, train by train: a train never jumps back a station while its previous
 * position is still recent (keepForward). Trains no longer in the answer are dropped.
 */
export function mergeTrains(prev: LiveTrain[], next: LiveTrain[], nowMs: number): LiveTrain[] {
  const before = new Map(prev.map((t) => [t.trip_id, t]));
  return next.map((t) => {
    const kept = keepForward(before.get(t.trip_id) ?? null, t, nowMs);
    // keepForward returns a TripPosition; the previous answer is a LiveTrain too.
    return kept === t ? t : (kept as LiveTrain);
  });
}

/** Lines with at least one train shown, in the order of `order` (the lines endpoint's). */
export function linesRunning(trains: LiveTrain[], nowMs: number, order: string[]): string[] {
  const running = new Set(
    trains.filter((t) => isShown(t, nowMs) && t.line).map((t) => t.line!.short_name),
  );
  const known = order.filter((l) => running.has(l));
  const extra = [...running].filter((l) => !order.includes(l)).sort();
  return [...known, ...extra];
}

/** Whether the train is standing at a station now (for the card's text). */
export function standing(train: LiveTrain, nowMs: number): boolean {
  return train.status === 'at_stop' && !shownProgress(train, nowMs);
}
