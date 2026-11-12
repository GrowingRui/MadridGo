import type { Journey, Leg } from '../api/journeys';
import { parseLegs, walkFeatures } from './route';

const time = (iso: string) => ({ scheduled: iso, status: 'scheduled' as const });

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

const home = leg({
  from: 'Calle Mayor 4',
  to: 'Sol',
  to_stop_id: 'sol',
  from_lat: 40.415,
  from_lon: -3.709,
  to_lat: 40.4168,
  to_lon: -3.7038,
  distance_m: 171,
});
const ride = leg({
  mode: 'rail',
  from: 'Sol',
  to: 'Atocha',
  from_stop_id: 'sol',
  from_lat: 40.4168,
  from_lon: -3.7038,
  to_lat: 40.4065,
  to_lon: -3.6895,
  line: { id: 'c4', short_name: 'C4', mode: 'rail' } as unknown as Leg['line'],
});
const journey = { id: 'j', legs: [home, ride], changes: [] } as unknown as Journey;

describe('walkFeatures', () => {
  it('draws only the walk, from your address to the stop', () => {
    const f = walkFeatures(journey, [0]);
    expect(f.lines).toHaveLength(1);
    expect(f.lines[0].walk).toBe(true);
    expect(f.lines[0].coords).toEqual([
      [-3.709, 40.415],
      [-3.7038, 40.4168],
    ]);
    expect(f.stops.map((s) => [s.name, s.id, s.major])).toEqual([
      ['Calle Mayor 4', null, true],
      ['Sol', 'sol', true],
    ]);
  });

  it('ignores indexes that are not in the connection', () => {
    expect(walkFeatures(journey, [7]).lines).toEqual([]);
  });
});

describe('parseLegs', () => {
  it('reads one or more leg indexes', () => {
    expect(parseLegs('2')).toEqual([2]);
    expect(parseLegs('3,4')).toEqual([3, 4]);
    expect(parseLegs(['1'])).toEqual([1]);
  });
  it('gives nothing for missing or bad values', () => {
    expect(parseLegs(undefined)).toEqual([]);
    expect(parseLegs('')).toEqual([]);
    expect(parseLegs('a')).toEqual([]);
    expect(parseLegs('-1')).toEqual([]);
  });
});
