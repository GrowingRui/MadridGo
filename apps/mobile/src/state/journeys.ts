// Last journey results, so the detail screen shows exactly the journey that was tapped.

import type { Journey } from '../api/journeys';
import type { LiveTrain } from '../api/trains';

export const journeyCache = new Map<string, Journey>();

/** Trains opened from Plan > Map > Live trains: their line and direction for the trip screen. */
export const trainCache = new Map<string, LiveTrain>();
