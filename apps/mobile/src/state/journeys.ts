// Last journey results, so the detail screen shows exactly the journey that was tapped.

import type { Journey } from '../api/journeys';

export const journeyCache = new Map<string, Journey>();
