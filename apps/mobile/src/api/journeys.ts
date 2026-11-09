// Journey types for the Phase 4 /journeys API, plus PREVIEW data so the planner screens can be
// designed and reviewed now. Preview journeys are always shown with a "Preview" banner and are
// never presented as real times.

import type { Line, Mode } from './stops';

export type TimeStatus = 'live' | 'scheduled' | 'frequency';

export interface LegTime {
  scheduled: string; // ISO time
  estimated?: string; // ISO time, only when status is 'live'
  status: TimeStatus;
  platform?: string;
}

export interface LegStop {
  name: string;
  time: string;
}

export interface Leg {
  mode: Mode | 'walk';
  line?: Line;
  headsign?: string;
  from: string;
  to: string;
  departure: LegTime;
  arrival: LegTime;
  duration_min: number;
  distance_m?: number;
  headway_min?: number;
  intermediate: LegStop[];
}

export interface Journey {
  id: string;
  departure: LegTime;
  arrival: LegTime;
  duration_min: number;
  transfers: number;
  walk_min: number;
  legs: Leg[];
  is_preview: boolean;
}

/** Minutes of delay on a live time (0 when on time or not live). */
export function delayMin(t: LegTime): number {
  if (t.status !== 'live' || !t.estimated) return 0;
  return Math.round((Date.parse(t.estimated) - Date.parse(t.scheduled)) / 60_000);
}

// ---------------------------------------------------------------------------
// Preview data (design review only)

const line = (short_name: string, mode: Mode, color: string, source: string): Line => ({
  source,
  route_id: short_name,
  short_name,
  long_name: null,
  mode,
  color,
  text_color: 'FFFFFF',
});

const C4 = line('C4', 'rail', '2C2A86', 'cercanias');
const BUS3 = line('3', 'bus', '8EBF42', 'urban');
const BUS469 = line('469', 'bus', '8EBF42', 'interurban');
const ML1 = line('ML1', 'light_rail', '3A7DDA', 'ml');

type LegDraft = Omit<Leg, 'departure' | 'arrival' | 'intermediate'> & { stops?: string[] };

const at = (base: Date, plusMin: number) =>
  new Date(base.getTime() + plusMin * 60_000).toISOString();

function makeJourney(
  id: string,
  base: Date,
  offset: number,
  drafts: LegDraft[],
  delay = 0,
): Journey {
  let t = offset;
  const legs: Leg[] = drafts.map((d, i) => {
    const dep = t;
    t += d.duration_min + (i < drafts.length - 1 ? 3 : 0); // 3 min to change
    const live = d.mode === 'rail'; // Renfe has real-time data; other modes are scheduled
    const status: TimeStatus = live ? 'live' : d.headway_min ? 'frequency' : 'scheduled';
    const { stops = [], ...rest } = d;
    return {
      ...rest,
      intermediate: stops.map((name, k) => ({
        name,
        time: at(base, dep + ((k + 1) * d.duration_min) / (stops.length + 1)),
      })),
      departure: {
        scheduled: at(base, dep),
        estimated: live ? at(base, dep + delay) : undefined,
        status,
        platform: d.mode === 'rail' ? '1' : undefined,
      },
      arrival: {
        scheduled: at(base, dep + d.duration_min),
        estimated: live ? at(base, dep + d.duration_min + delay) : undefined,
        status: live ? 'live' : 'scheduled',
        platform: d.mode === 'rail' ? '4' : undefined,
      },
    };
  });
  const transit = legs.filter((l) => l.mode !== 'walk');
  return {
    id,
    departure: legs[0].departure,
    arrival: legs[legs.length - 1].arrival,
    duration_min: t - offset,
    transfers: Math.max(0, transit.length - 1),
    walk_min: legs.filter((l) => l.mode === 'walk').reduce((s, l) => s + l.duration_min, 0),
    legs,
    is_preview: true,
  };
}

/** Example journeys starting near `now`, for design review only. */
export function previewJourneys(from: string, to: string, now = new Date()): Journey[] {
  const base = new Date(Math.ceil(now.getTime() / 300_000) * 300_000); // next 5-minute mark
  const walk = (a: string, b: string, min: number): LegDraft => ({
    mode: 'walk',
    from: a,
    to: b,
    duration_min: min,
    distance_m: min * 75,
  });
  const c4: LegDraft = {
    mode: 'rail',
    line: C4,
    headsign: 'Alcobendas - San Sebastián de los Reyes',
    from: 'Parla',
    to: 'Madrid - Atocha Cercanías',
    duration_min: 29,
    stops: ['Getafe Sector 3', 'Getafe Centro', 'Villaverde Alto', 'Doce de Octubre'],
  };
  return [
    makeJourney('p1', base, 4, [walk(from, 'Parla', 8), c4, walk('Atocha Cercanías', to, 3)]),
    makeJourney(
      'p2',
      base,
      9,
      [
        {
          mode: 'bus',
          line: BUS3,
          headsign: '9 de Junio - Hospital Infanta Cristina',
          from,
          to: 'Parla - Estación',
          duration_min: 7,
          stops: ['Av. Leguario - Pablo Gargallo'],
        },
        c4,
        walk('Atocha Cercanías', to, 3),
      ],
      4,
    ),
    makeJourney('p3', base, 18, [
      {
        mode: 'bus',
        line: BUS469,
        headsign: 'Madrid (Legazpi)',
        from,
        to: 'Legazpi',
        duration_min: 41,
        stops: ['Parla - Centro', 'Pinto', 'Getafe'],
      },
      walk('Legazpi', to, 14),
    ]),
    makeJourney('p4', base, 30, [
      walk(from, 'Parla', 8),
      c4,
      {
        mode: 'light_rail',
        line: ML1,
        headsign: 'Las Tablas',
        from: 'Atocha',
        to,
        duration_min: 6,
        headway_min: 7,
      },
    ]),
  ];
}
