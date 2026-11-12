import type { Journey, Leg, Transfer } from '../api/journeys';
import { changeDetails, changeTone, walkLegsInChanges } from './changeDetails';

const time = (iso: string, extra: object = {}) => ({
  scheduled: iso,
  status: 'scheduled' as const,
  ...extra,
});

function leg(p: Partial<Leg>): Leg {
  return {
    mode: 'walk',
    from: 'A',
    to: 'B',
    departure: time('2030-01-02T10:00:00+01:00'),
    arrival: time('2030-01-02T10:05:00+01:00'),
    duration_min: 5,
    intermediate: [],
    ...p,
  };
}

function change(p: Partial<Transfer>): Transfer {
  return {
    at: 'Atocha',
    stop_id: 'atocha',
    from_leg: 0,
    to_leg: 1,
    walk_min: 0,
    label: 'comfortable',
    margin_min: 6,
    wait_up_to_min: null,
    basis: 'scheduled',
    message: '6 min to spare after walking, based on the timetable.',
    ...p,
  };
}

const journey = (legs: Leg[], changes: Transfer[]) => ({ legs, changes }) as unknown as Journey;

const c4 = leg({
  mode: 'rail',
  from: 'Parla',
  to: 'Atocha',
  departure: time('2030-01-02T10:00:00+01:00'),
  arrival: time('2030-01-02T10:43:00+01:00', { platform: '3' }),
});
const c3 = leg({
  mode: 'rail',
  from: 'Atocha',
  to: 'Sol',
  departure: time('2030-01-02T10:51:00+01:00', { platform: '6' }),
  arrival: time('2030-01-02T10:56:00+01:00'),
});

describe('changeDetails', () => {
  it('gives the time to change and the platforms at the same station', () => {
    const d = changeDetails(journey([c4, c3], []), change({}));
    expect(d).toMatchObject({
      changeMin: 8,
      walkMin: 0,
      walkM: null,
      walkTo: null,
      fromPlatform: '3',
      toPlatform: '6',
      walkLegs: [],
      tone: 'ok',
    });
  });

  it('uses live times when there are some', () => {
    const late = leg({
      ...c4,
      arrival: time('2030-01-02T10:43:00+01:00', {
        status: 'live',
        estimated: '2030-01-02T10:47:00+01:00',
      }),
    });
    expect(changeDetails(journey([late, c3], []), change({})).changeMin).toBe(4);
  });

  it('takes in the walk between the two rides, with its length and where it ends', () => {
    const walk1 = leg({ from: 'Atocha', to: 'Atocha (exit)', distance_m: 120 });
    const walk2 = leg({ from: 'Atocha (exit)', to: 'Estación del Arte', distance_m: 134 });
    const bus = leg({ mode: 'bus', from: 'Estación del Arte', departure: c3.departure });
    const j = journey([c4, walk1, walk2, bus], []);
    const d = changeDetails(j, change({ to_leg: 3, walk_min: 4 }));
    expect(d).toMatchObject({
      walkMin: 4,
      walkM: 250,
      walkTo: 'Estación del Arte',
      walkLegs: [1, 2],
    });
  });

  it('gives no length when a walk leg has none', () => {
    const walk = leg({ to: 'Estación del Arte', distance_m: null });
    const d = changeDetails(journey([c4, walk, c3], []), change({ to_leg: 2, walk_min: 3 }));
    expect(d.walkM).toBeNull();
  });

  it('has no change time onto a frequent service', () => {
    const d = changeDetails(
      journey([c4, c3], []),
      change({ label: null, margin_min: null, wait_up_to_min: 8 }),
    );
    expect(d.changeMin).toBeNull();
    expect(d.tone).toBe('ok');
  });
});

describe('changeTone', () => {
  it('warns on tight and uncertain changes, and alarms on risky ones', () => {
    expect(changeTone('comfortable')).toBe('ok');
    expect(changeTone('tight')).toBe('warning');
    expect(changeTone('uncertain')).toBe('warning');
    expect(changeTone('at_risk')).toBe('danger');
    expect(changeTone('not_feasible')).toBe('danger');
    expect(changeTone(null)).toBe('ok');
  });
});

describe('walkLegsInChanges', () => {
  it('lists only the walks between rides, not those at the start or end', () => {
    const start = leg({ to: 'Parla' });
    const mid = leg({ from: 'Atocha', to: 'Atocha' });
    const end = leg({ from: 'Sol', to: 'Puerta del Sol' });
    const j = journey([start, c4, mid, c3, end], [change({ from_leg: 1, to_leg: 3 })]);
    expect([...walkLegsInChanges(j)]).toEqual([2]);
  });
});
