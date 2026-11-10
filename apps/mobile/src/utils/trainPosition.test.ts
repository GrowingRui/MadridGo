import type { Leg } from '../api/journeys';
import type { TripPosition } from '../api/trips';
import {
  MAX_AHEAD_S,
  ageText,
  approachText,
  canTrack,
  isShown,
  keepForward,
  place,
  ridingText,
  shownProgress,
  sourceText,
  trackY,
} from './trainPosition';

const T0 = Date.parse('2026-11-10T08:00:00Z');
const iso = (ms: number) => new Date(ms).toISOString();

// Parla -> Getafe Centro -> Las Margaritas -> Villaverde Alto (C4a; stop ids as in Renfe GTFS)
const leg: Leg = {
  mode: 'rail',
  trip_id: 'cercanias:1012L27301C4a',
  from: 'Parla',
  to: 'Villaverde Alto',
  from_stop_id: 'renfe:35609',
  to_stop_id: 'renfe:18002',
  departure: { scheduled: iso(T0 + 10 * 60_000), status: 'scheduled' },
  arrival: { scheduled: iso(T0 + 30 * 60_000), status: 'scheduled' },
  duration_min: 20,
  intermediate: [
    { name: 'Getafe Centro', stop_id: 'renfe:35603', time: iso(T0 + 18 * 60_000) },
    { name: 'Las Margaritas', stop_id: 'renfe:35602', time: iso(T0 + 22 * 60_000) },
  ],
};

function position(p: Partial<TripPosition>): TripPosition {
  return {
    trip_id: leg.trip_id!,
    status: 'between',
    message: '',
    observed_at: iso(T0),
    poll_after_s: 30,
    ...p,
  };
}

const stop = (index: number, stop_id: string, name: string) => ({ index, stop_id, name });

describe('when to ask for a position', () => {
  it('only for Cercanías legs around their travel time', () => {
    expect(canTrack(leg, T0)).toBe(true);
    expect(canTrack(leg, T0 + 31 * 60_000)).toBe(true); // just after arrival
    expect(canTrack(leg, T0 + 40 * 60_000)).toBe(false);
    expect(canTrack(leg, T0 - 2 * 3600_000)).toBe(false); // e.g. tomorrow's journey
    expect(canTrack({ ...leg, trip_id: 'metro:4_I1' }, T0)).toBe(false);
    expect(canTrack({ ...leg, trip_id: null }, T0)).toBe(false);
  });
});

describe('freshness', () => {
  it('hides positions older than 3 minutes and unavailable ones', () => {
    const p = position({ last_stop: stop(3, 'renfe:35603', 'Getafe Centro'), progress: 0.5 });
    expect(isShown(p, T0 + 179_000)).toBe(true);
    expect(isShown(p, T0 + 181_000)).toBe(false);
    expect(isShown({ ...p, status: 'unavailable' }, T0)).toBe(false);
    expect(isShown({ ...p, observed_at: null }, T0)).toBe(false);
  });

  it('says how old the position is', () => {
    expect(ageText(20)).toBe('position 20 s ago');
    expect(ageText(150)).toBe('position 2 min ago');
  });
});

describe('movement between updates', () => {
  const p = position({
    last_stop: stop(3, 'renfe:35603', 'Getafe Centro'),
    next_stop: stop(4, 'renfe:35602', 'Las Margaritas'),
    progress: 0.2,
    segment_run_s: 200,
  });

  it('moves on at the timetable pace after the fix', () => {
    expect(shownProgress(p, T0)).toBeCloseTo(0.2);
    expect(shownProgress(p, T0 + 20_000)).toBeCloseTo(0.3);
  });

  it('stops after MAX_AHEAD_S without new data (a train held at a signal)', () => {
    const cap = 0.2 + MAX_AHEAD_S / 200;
    expect(shownProgress(p, T0 + MAX_AHEAD_S * 1000)).toBeCloseTo(cap);
    expect(shownProgress(p, T0 + 120_000)).toBeCloseTo(cap);
  });

  it('never reaches the next station on its own', () => {
    expect(shownProgress({ ...p, progress: 0.9 }, T0 + 40_000)).toBeCloseTo(0.95);
  });

  it('a train at a station stays on it', () => {
    expect(shownProgress({ ...p, status: 'at_stop', progress: 0 }, T0 + 40_000)).toBe(0);
  });

  it('without a known progress there is no movement', () => {
    expect(shownProgress({ ...p, progress: null }, T0 + 10_000)).toBeNull();
  });
});

describe('placement on the leg', () => {
  it('before boarding: N stops away, above the boarding stop', () => {
    const p = position({
      status: 'at_stop',
      last_stop: stop(0, 'renfe:99999', 'Fuenlabrada'),
      stops_away: 2,
    });
    const placed = place(p, leg, T0);
    expect(placed).toEqual({ kind: 'approaching', stopsAway: 2, at: true, near: 'Fuenlabrada' });
    if (placed.kind === 'approaching') {
      expect(approachText(placed)).toBe('Train is 2 stops away · at Fuenlabrada');
      expect(approachText({ ...placed, stopsAway: 1, at: false })).toBe(
        'Train is 1 stop away · after Fuenlabrada',
      );
    }
  });

  it('riding: between two of the leg rows', () => {
    const p = position({
      last_stop: stop(3, 'renfe:35603', 'Getafe Centro'),
      next_stop: stop(4, 'renfe:35602', 'Las Margaritas'),
      progress: 0.4,
      stops_away: -1,
    });
    expect(place(p, leg, T0)).toEqual({ kind: 'riding', row: 1, progress: 0.4, at: false });
    expect(ridingText(p, false)).toBe('Now between Getafe Centro and Las Margaritas');
  });

  it('at the boarding stop', () => {
    const p = position({ status: 'at_stop', last_stop: stop(2, 'renfe:35609', 'Parla') });
    expect(place(p, leg, T0)).toEqual({ kind: 'riding', row: 0, progress: 0, at: true });
    expect(ridingText(p, true)).toBe('Now at Parla');
  });

  it('gone once it has left the alighting stop or passed elsewhere', () => {
    const left = position({ last_stop: stop(6, 'renfe:18002', 'Villaverde Alto'), progress: 0.3 });
    expect(place(left, leg, T0).kind).toBe('none');
    const beyond = position({ last_stop: stop(9, 'renfe:18000', 'Atocha'), stops_away: -7 });
    expect(place(beyond, leg, T0).kind).toBe('none');
  });

  it('stale data is never placed', () => {
    const p = position({ status: 'at_stop', last_stop: stop(2, 'renfe:35609', 'Parla') });
    expect(place(p, leg, T0 + 200_000).kind).toBe('none');
  });
});

describe('vertical position', () => {
  it('interpolates between the measured stop markers', () => {
    expect(trackY([10, 50, 90, 130], 1, 0.5)).toBe(70);
    expect(trackY([10, 50, 90, 130], 2, 0)).toBe(90);
  });

  it('spreads evenly from boarding to alighting when the stops are hidden', () => {
    expect(trackY([10, undefined, undefined, 130], 1, 0.5)).toBe(70);
  });

  it('draws an unknown progress mid-way', () => {
    expect(trackY([10, 50], 0, null)).toBe(30);
  });

  it('waits for the layout', () => {
    expect(trackY([undefined, undefined], 0, 0.5)).toBeNull();
  });
});

describe('never backwards', () => {
  const at = (index: number, observed: number): TripPosition =>
    position({
      status: 'at_stop',
      last_stop: stop(index, `renfe:${index}`, `S${index}`),
      observed_at: iso(observed),
    });

  it('ignores a step back while the previous position is recent', () => {
    const prev = at(5, T0);
    expect(keepForward(prev, at(4, T0 + 20_000), T0 + 25_000)).toBe(prev);
  });

  it('accepts forward moves, other trips and replaces an old previous position', () => {
    const prev = at(5, T0);
    const fwd = at(6, T0 + 20_000);
    expect(keepForward(prev, fwd, T0 + 25_000)).toBe(fwd);
    const other = { ...at(1, T0 + 20_000), trip_id: 'cercanias:other' };
    expect(keepForward(prev, other, T0 + 25_000)).toBe(other);
    const back = at(4, T0 + 200_000);
    expect(keepForward(prev, back, T0 + 200_000)).toBe(back);
  });
});

describe('estimated positions (no live position from Renfe)', () => {
  const between = position({
    kind: 'estimated',
    observed_at: iso(T0),
    last_stop: stop(3, 'renfe:35603', 'Getafe Centro'),
    next_stop: stop(4, 'renfe:35602', 'Las Margaritas'),
    progress: 0.25,
    progress_basis: 'timetable',
    left_at: iso(T0 - 60_000),
    expected_at_next: iso(T0 + 180_000),
    poll_after_s: 15,
  });

  it('move with the clock, without the live 45 s limit', () => {
    expect(shownProgress(between, T0)).toBeCloseTo(0.25);
    expect(shownProgress(between, T0 + 60_000)).toBeCloseTo(0.5);
    expect(shownProgress(between, T0 + 170_000)).toBeCloseTo(0.95); // never onto the station
  });

  it('leave a station at the estimated departure time', () => {
    const atStop = position({
      kind: 'estimated',
      status: 'at_stop',
      observed_at: iso(T0),
      last_stop: stop(3, 'renfe:35603', 'Getafe Centro'),
      next_stop: stop(4, 'renfe:35602', 'Las Margaritas'),
      progress: 0,
      departs_at: iso(T0 + 20_000),
      expected_at_next: iso(T0 + 220_000),
    });
    expect(shownProgress(atStop, T0 + 10_000)).toBe(0);
    expect(place(atStop, leg, T0 + 10_000)).toMatchObject({ kind: 'riding', row: 1, at: true });
    expect(shownProgress(atStop, T0 + 120_000)).toBeCloseTo(0.5);
    expect(place(atStop, leg, T0 + 120_000)).toMatchObject({ kind: 'riding', row: 1, at: false });
  });

  it('are always labelled as estimates', () => {
    expect(sourceText(between, 3)).toBe('Estimated from the timetable');
    expect(sourceText({ ...between, delay_s: 240 }, 3)).toBe(
      'Estimated · timetable + 4 min live delay',
    );
    expect(sourceText({ ...between, delay_s: 0 }, 3)).toBe('Estimated · timetable, on time (live)');
    expect(sourceText({ ...between, kind: 'live' }, 20)).toBe('Live · position 20 s ago');
  });
});

describe('live positions placed by predicted times', () => {
  it('move with the clock towards the predicted arrival', () => {
    const p = position({
      kind: 'live',
      last_stop: stop(3, 'renfe:35603', 'Getafe Centro'),
      next_stop: stop(4, 'renfe:35602', 'Las Margaritas'),
      progress: 0.3,
      progress_basis: 'timetable',
      segment_run_s: 200,
      left_at: iso(T0 - 60_000),
      expected_at_next: iso(T0 + 140_000),
    });
    expect(shownProgress(p, T0 + 100_000)).toBeCloseTo(0.8); // past the 45 s GPS limit
  });
});
