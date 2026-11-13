import type { Journey, Leg, LegTime, Transfer } from '../api/journeys';
import type { Place } from '../state/planner';
import { replanFrom, replanReason } from './replan';

const T = (hm: string) => `2030-01-02T${hm}:00+01:00`;
const ms = (hm: string) => Date.parse(T(hm));
const time = (hm: string, extra: Partial<LegTime> = {}): LegTime => ({
  scheduled: T(hm),
  status: 'scheduled',
  ...extra,
});

function leg(p: Partial<Leg>): Leg {
  return {
    mode: 'walk',
    from: 'A',
    to: 'B',
    departure: time('10:00'),
    arrival: time('10:05'),
    duration_min: 5,
    intermediate: [],
    ...p,
  };
}

// Home -walk-> Parla -C-4-> Atocha -walk-> Paseo del Prado -bus 27-> Sol -walk-> Office
const walkIn = leg({ from: 'Home', to: 'Parla', departure: time('10:00'), arrival: time('10:05') });
const c4 = leg({
  mode: 'rail',
  trip_id: 'cercanias:c4-1010',
  from: 'Parla',
  to: 'Atocha',
  from_stop_id: 'renfe:parla',
  to_stop_id: 'renfe:atocha',
  departure: time('10:10'),
  arrival: time('10:43'),
  intermediate: [
    { name: 'Getafe', stop_id: 'renfe:getafe', time: T('10:20') },
    { name: 'Villaverde', stop_id: null, lat: 40.345678, lon: -3.7, time: T('10:30') },
  ],
});
const walkChange = leg({
  from: 'Atocha',
  to: 'Paseo del Prado',
  departure: time('10:43'),
  arrival: time('10:46'),
});
const bus = leg({
  mode: 'bus',
  trip_id: 'emt:27-template',
  headway_min: 8,
  from: 'Paseo del Prado',
  to: 'Sol',
  from_stop_id: 'emt:prado',
  to_stop_id: 'emt:sol',
  departure: time('10:51', { status: 'frequency' }),
  arrival: time('11:05', { status: 'frequency' }),
});
const walkOut = leg({
  from: 'Sol',
  to: 'Office',
  departure: time('11:05'),
  arrival: time('11:10'),
});

const change: Transfer = {
  at: 'Atocha',
  stop_id: 'renfe:atocha',
  from_leg: 1,
  to_leg: 3,
  walk_min: 3,
  label: 'comfortable',
  margin_min: 5,
  wait_up_to_min: null,
  basis: 'scheduled',
  message: '',
};

function journey(legs: Leg[], p: Partial<Journey> = {}): Journey {
  return {
    id: 'j',
    departure: legs[0].departure,
    arrival: legs[legs.length - 1].arrival,
    duration_min: 70,
    transfers: 1,
    walk_min: 13,
    legs,
    changes: [change],
    reliability: 'comfortable',
    feasible: true,
    issues: [],
    data_quality: 'scheduled',
    alerts: [],
    is_preview: false,
    ...p,
  };
}

const home: Place = { id: '40.10000,-3.70000', name: 'Home', lat: 40.1, lon: -3.7 };
const office: Place = { id: 'emt:office', name: 'Office' };
const ok = journey([walkIn, c4, walkChange, bus, walkOut]);
const cancelledC4 = { ...c4, departure: time('10:10', { status: 'cancelled' as const }) };
const withCancelled = journey([walkIn, cancelledC4, walkChange, bus, walkOut], {
  feasible: false,
  issues: ['C-4 10:10 from Parla is cancelled.'],
});

describe('replanReason', () => {
  it('is null for a connection without problems', () => {
    expect(replanReason(ok, ms('09:00'))).toBeNull();
  });
  it('flags a cancelled ride still ahead, a connection that no longer works, a change at risk', () => {
    expect(replanReason(withCancelled, ms('09:00'))).toBe('cancelled');
    expect(replanReason(journey(ok.legs, { feasible: false }), ms('09:00'))).toBe('notFeasible');
    const risky = journey(ok.legs, { changes: [{ ...change, label: 'at_risk' }] });
    expect(replanReason(risky, ms('10:30'))).toBe('atRisk');
    // Once the next vehicle has left, the risk is history.
    expect(replanReason(risky, ms('10:55'))).toBeNull();
  });
  it('is null once the journey is over', () => {
    expect(replanReason(withCancelled, ms('11:30'))).toBeNull();
  });
});

describe('replanFrom', () => {
  it('before leaving: from the start, 10 min before the planned departure', () => {
    expect(replanFrom(withCancelled, home, office, ms('08:00'))).toEqual({
      from: home,
      at: ms('09:50'),
      avoid: ['cercanias:c4-1010'],
    });
    // Less than 10 min before: now.
    expect(replanFrom(withCancelled, home, office, ms('09:55'))?.at).toBeNull();
  });

  it('walking to the first stop, or waiting there for a cancelled train: from that stop, now', () => {
    const walking = replanFrom(withCancelled, home, office, ms('10:03'));
    expect(walking).toEqual({
      from: { id: 'renfe:parla', name: 'Parla' },
      at: null,
      avoid: ['cercanias:c4-1010'],
    });
    expect(replanFrom(withCancelled, home, office, ms('10:15'))?.from.id).toBe('renfe:parla');
  });

  it('on a train: from its next stop, when it gets there (moved by the live delay)', () => {
    expect(replanFrom(ok, home, office, ms('10:12'))).toEqual({
      from: { id: 'renfe:getafe', name: 'Getafe' },
      at: ms('10:20'),
      avoid: [],
    });
    // A stop without id is planned from its point, with its name.
    expect(replanFrom(ok, home, office, ms('10:25'))?.from).toEqual({
      id: '40.34568,-3.70000',
      name: 'Villaverde',
      lat: 40.345678,
      lon: -3.7,
    });
    // 5 min late: still before Getafe at 10:23.
    const late = journey([
      walkIn,
      {
        ...c4,
        departure: time('10:10', { status: 'live', estimated: T('10:15') }),
        arrival: time('10:43', { status: 'live', estimated: T('10:48') }),
      },
      walkChange,
      bus,
      walkOut,
    ]);
    expect(replanFrom(late, home, office, ms('10:23'))).toMatchObject({
      from: { id: 'renfe:getafe' },
      at: ms('10:25'),
    });
    // After the last intermediate stop: the station where you get off.
    expect(replanFrom(ok, home, office, ms('10:35'))).toMatchObject({
      from: { id: 'renfe:atocha', name: 'Atocha' },
      at: ms('10:43'),
    });
  });

  it('at a change: from the stop you got off at, now', () => {
    expect(replanFrom(ok, home, office, ms('10:45'))).toEqual({
      from: { id: 'renfe:atocha', name: 'Atocha' },
      at: null,
      avoid: [],
    });
  });

  it('never leaves out frequency services (their trip id covers every bus of the line)', () => {
    const busGone = journey([
      walkIn,
      c4,
      walkChange,
      { ...bus, departure: time('10:51', { status: 'cancelled' }) },
      walkOut,
    ]);
    expect(replanFrom(busGone, home, office, ms('10:45'))?.avoid).toEqual([]);
  });

  it('nothing to re-plan on the last vehicle past its last stop, or walking to the destination', () => {
    expect(replanFrom(ok, home, office, ms('10:58'))).toBeNull();
    expect(replanFrom(ok, home, office, ms('11:07'))).toBeNull();
  });

  it('nothing to re-plan from the destination itself, or without vehicles', () => {
    const toAtocha: Place = { id: 'renfe:atocha', name: 'Atocha' };
    expect(replanFrom(ok, home, toAtocha, ms('10:35'))).toBeNull();
    expect(replanFrom(journey([walkIn], { changes: [] }), home, office, ms('10:01'))).toBeNull();
  });
});
