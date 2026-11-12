import type { Journey, Leg, LegTime, Transfer } from '../api/journeys';
import type { Line } from '../api/stops';
import { focusIndex, stepText, stopsLeft, tripSteps } from './tripSteps';

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

const c4Line = {
  source: 'renfe',
  route_id: 'C4',
  short_name: 'C-4',
  mode: 'rail',
} as unknown as Line;
const bus27 = { source: 'emt', route_id: '27', short_name: '27', mode: 'bus' } as unknown as Line;

const walkIn = leg({ from: 'Home', to: 'Parla', duration_min: 5, distance_m: 412 });
const c4 = leg({
  mode: 'rail',
  line: c4Line,
  headsign: 'Alcobendas',
  from: 'Parla',
  to: 'Atocha',
  departure: time('10:10', { platform: '1' }),
  arrival: time('10:43', { platform: '3' }),
  duration_min: 33,
  intermediate: [
    { name: 'Getafe', time: T('10:20') },
    { name: 'Villaverde', time: T('10:30') },
    { name: 'Doce de Octubre', time: T('10:38') },
  ],
});
const walkChange = leg({
  from: 'Atocha',
  to: 'Atocha - Paseo del Prado',
  departure: time('10:43'),
  arrival: time('10:46'),
  duration_min: 3,
  distance_m: 230,
});
const bus = leg({
  mode: 'bus',
  line: bus27,
  headsign: 'Plaza de Castilla',
  from: 'Atocha - Paseo del Prado',
  to: 'Sol',
  departure: time('10:51'),
  arrival: time('11:05'),
  duration_min: 14,
});

const change: Transfer = {
  at: 'Atocha',
  stop_id: 'atocha',
  from_leg: 1,
  to_leg: 3,
  walk_min: 3,
  label: 'comfortable',
  margin_min: 5,
  wait_up_to_min: null,
  basis: 'scheduled',
  message: '',
};

const journey = (legs: Leg[], changes: Transfer[]) =>
  ({
    legs,
    changes,
    departure: legs[0].departure,
    arrival: legs[legs.length - 1].arrival,
  }) as unknown as Journey;

const trip = journey([walkIn, c4, walkChange, bus], [change]);

describe('tripSteps', () => {
  it('cuts a trip into walk, ride, change (with its walk), ride, arrive', () => {
    expect(tripSteps(trip, ms('09:00')).map((s) => s.kind)).toEqual([
      'walk',
      'ride',
      'change',
      'ride',
      'arrive',
    ]);
  });

  it('before the trip: the first step is next, the rest later', () => {
    const steps = tripSteps(trip, ms('09:00'));
    expect(steps.map((s) => s.state)).toEqual(['next', 'later', 'later', 'later', 'later']);
    expect(focusIndex(steps)).toBe(0);
  });

  it('waiting for the train after the walk: the ride is next', () => {
    const steps = tripSteps(trip, ms('10:07'));
    expect(steps.map((s) => s.state)).toEqual(['done', 'next', 'later', 'later', 'later']);
    expect(focusIndex(steps)).toBe(1);
  });

  it('on the train: the ride is now', () => {
    const steps = tripSteps(trip, ms('10:25'));
    expect(steps.map((s) => s.state)).toEqual(['done', 'now', 'later', 'later', 'later']);
  });

  it('between the trains: the change is now', () => {
    const steps = tripSteps(trip, ms('10:45'));
    expect(steps[2]).toMatchObject({ kind: 'change', state: 'now' });
    expect(focusIndex(steps)).toBe(2);
  });

  it('follows live times: a late train is still under way', () => {
    const late = journey(
      [
        walkIn,
        {
          ...c4,
          arrival: time('10:43', {
            status: 'live',
            estimated: T('10:47'),
            realtime: { delay_s: 240 } as never,
          }),
        },
        walkChange,
        bus,
      ],
      [change],
    );
    expect(tripSteps(late, ms('10:45'))[1].state).toBe('now');
  });

  it('after arriving: everything done, the last step shown', () => {
    const steps = tripSteps(trip, ms('11:10'));
    expect(steps.every((s) => s.state === 'done')).toBe(true);
    expect(focusIndex(steps)).toBe(4);
  });
});

describe('stopsLeft', () => {
  it('counts the stops still ahead, the one you get off at included', () => {
    expect(stopsLeft(c4, ms('10:15'))).toBe(4);
    expect(stopsLeft(c4, ms('10:35'))).toBe(2);
    expect(stopsLeft(c4, ms('10:40'))).toBe(1);
  });

  it('moves the timetable by the live delay at departure', () => {
    const late = {
      ...c4,
      departure: time('10:10', {
        status: 'live' as const,
        estimated: T('10:15'),
        realtime: { delay_s: 300 } as never,
      }),
    };
    expect(stopsLeft(late, ms('10:22'))).toBe(4);
  });
});

describe('stepText', () => {
  const text = (now: string, i: number) => stepText(trip, tripSteps(trip, ms(now))[i], ms(now));

  it('on the train: how many stops until getting off', () => {
    expect(text('10:25', 1)).toMatchObject({
      label: 'Now',
      title: 'Cercanías C-4 to Alcobendas',
      lines: ['Get off at Atocha in 3 stops (10:43)'],
    });
    expect(text('10:40', 1).lines).toEqual(['Get off at the next stop: Atocha (10:43)']);
  });

  it('waiting: when and where to board, the platform, where to get off', () => {
    expect(text('10:07', 1)).toMatchObject({
      label: 'Next',
      lines: ['Board at Parla in 3 min (10:10)', 'Platform 1', 'Get off at Atocha at 10:43'],
    });
  });

  it('the change: time, walk and the next line', () => {
    const c = text('10:25', 2);
    expect(c.title).toBe('Change at Atocha');
    expect(c.lines[0]).toBe('8 min to change · walk 3 min · 230 m to Bus 27');
    expect(c.lines[1]).toBe('It leaves from Atocha - Paseo del Prado');
    expect(c.line).toBe(bus27);
    expect(c.label).toBe('Then');
  });

  it('a tight change says so', () => {
    const tight = journey([walkIn, c4, walkChange, bus], [{ ...change, label: 'tight' }]);
    const s = stepText(tight, tripSteps(tight, ms('10:25'))[2], ms('10:25'));
    expect(s.tone).toBe('warning');
    expect(s.lines).toContain('Go straight to the next departure.');
  });

  it('a cancelled ride says so', () => {
    const cancelled = journey(
      [walkIn, { ...c4, departure: time('10:10', { status: 'cancelled' }) }, walkChange, bus],
      [change],
    );
    const s = stepText(cancelled, tripSteps(cancelled, ms('10:00'))[1], ms('10:00'));
    expect(s.tone).toBe('danger');
  });

  it('the walk and the arrival', () => {
    expect(text('09:00', 0).title).toBe('Walk 5 min · 410 m to Parla');
    expect(text('09:00', 4)).toMatchObject({ title: 'Arrive at Sol', lines: ['11:05'] });
  });
});
