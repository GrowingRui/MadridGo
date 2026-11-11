import type { Journey, Leg } from '../api/journeys';
import type { TripPosition } from '../api/trips';
import { followedLeg, trainPoint } from './liveMap';

const T0 = Date.parse('2026-11-10T08:00:00Z');
const iso = (ms: number) => new Date(ms).toISOString();
const min = 60_000;

function leg(p: Partial<Leg> & { dep: number; arr: number }): Leg {
  const { dep, arr, ...rest } = p;
  return {
    mode: 'rail',
    trip_id: 'cercanias:1',
    from: 'A',
    to: 'B',
    departure: { scheduled: iso(dep), status: 'scheduled' },
    arrival: { scheduled: iso(arr), status: 'scheduled' },
    duration_min: (arr - dep) / min,
    intermediate: [],
    ...rest,
  } as Leg;
}

const journey = (legs: Leg[]) => ({ legs }) as unknown as Journey;

describe('which train to follow', () => {
  const walk = leg({ mode: 'walk', trip_id: null, dep: T0, arr: T0 + 5 * min });
  const c4 = leg({ trip_id: 'cercanias:C4', dep: T0 + 5 * min, arr: T0 + 25 * min });
  const c10 = leg({ trip_id: 'cercanias:C10', dep: T0 + 30 * min, arr: T0 + 50 * min });
  const metro = leg({ mode: 'metro', trip_id: 'metro:1', dep: T0 + 30 * min, arr: T0 + 50 * min });

  it('follows the first Cercanías ride that is on or comes next', () => {
    const j = journey([walk, c4, c10]);
    expect(followedLeg(j, T0)).toBe(1);
    expect(followedLeg(j, T0 + 20 * min)).toBe(1);
    expect(followedLeg(j, T0 + 28 * min)).toBe(2); // C4 arrived: now the change to C10
  });

  it('follows nothing without Cercanías, or on another day', () => {
    expect(followedLeg(journey([walk, metro]), T0)).toBeNull();
    expect(followedLeg(journey([walk, c4, c10]), T0 + 24 * 60 * min)).toBeNull();
  });
});

describe('where the train is drawn', () => {
  const getafe = { index: 3, stop_id: 'renfe:35603', name: 'Getafe Centro', lat: 40.3, lon: -3.7 };
  const marg = { index: 4, stop_id: 'renfe:35602', name: 'Las Margaritas', lat: 40.4, lon: -3.6 };
  const pos = (p: Partial<TripPosition>): TripPosition => ({
    trip_id: 'cercanias:C4',
    status: 'between',
    kind: 'live',
    message: '',
    last_stop: getafe,
    next_stop: marg,
    observed_at: iso(T0),
    poll_after_s: 30,
    ...p,
  });

  it('at its station', () => {
    expect(trainPoint(pos({ status: 'at_stop', progress: 0 }), T0)).toEqual({
      lon: -3.7,
      lat: 40.3,
      estimated: false,
    });
  });

  it('on the line between the two stations', () => {
    const p = trainPoint(pos({ progress: 0.5 }), T0)!;
    expect(p.lat).toBeCloseTo(40.35);
    expect(p.lon).toBeCloseTo(-3.65);
  });

  it('marks estimated positions', () => {
    expect(trainPoint(pos({ kind: 'estimated', progress: 0.5 }), T0)?.estimated).toBe(true);
  });

  it('not when the position is too old, unavailable or has no coordinates', () => {
    expect(trainPoint(pos({ progress: 0.5 }), T0 + 4 * min)).toBeNull();
    expect(trainPoint(pos({ status: 'unavailable' }), T0)).toBeNull();
    expect(trainPoint(pos({ last_stop: { ...getafe, lat: null, lon: null } }), T0)).toBeNull();
    expect(trainPoint(null, T0)).toBeNull();
  });

  it('stays at the station when the next one has no coordinates', () => {
    const p = trainPoint(pos({ progress: 0.5, next_stop: { ...marg, lat: null } }), T0);
    expect(p).toEqual({ lon: -3.7, lat: 40.3, estimated: false });
  });
});
