import AsyncStorage from '@react-native-async-storage/async-storage';

import type { Journey, Leg } from '../api/journeys';
import { routeFeatures } from '../utils/route';
import {
  isConnectionSaved,
  resetConnectionsForTests,
  savedConnection,
  toggleConnection,
} from './connections';

const time = (iso: string) => ({ scheduled: iso, status: 'scheduled' as const });

function leg(p: Partial<Leg>): Leg {
  return {
    mode: 'walk',
    from: 'A',
    to: 'B',
    departure: time('2030-01-01T10:00:00+01:00'),
    arrival: time('2030-01-01T10:05:00+01:00'),
    duration_min: 5,
    intermediate: [],
    ...p,
  };
}

const C4 = {
  source: 'cercanias',
  route_id: 'C4',
  short_name: 'C4',
  long_name: null,
  mode: 'rail' as const,
  color: '2C2A86',
  text_color: 'FFFFFF',
};

const journey: Journey = {
  id: 'j1',
  departure: time('2030-01-01T10:00:00+01:00'),
  arrival: time('2030-01-01T10:30:00+01:00'),
  duration_min: 30,
  transfers: 0,
  walk_min: 5,
  legs: [
    leg({ from: 'Home', to: 'Parla', from_lat: 40.2, from_lon: -3.77, to_lat: 40.23, to_lon: -3.77 }),
    leg({
      mode: 'rail',
      line: C4,
      from: 'Parla',
      to: 'Atocha',
      from_stop_id: 'renfe:1',
      to_stop_id: 'renfe:2',
      from_lat: 40.23,
      from_lon: -3.77,
      to_lat: 40.4,
      to_lon: -3.69,
      intermediate: [{ name: 'Getafe', stop_id: 'renfe:3', time: '', lat: 40.3, lon: -3.73 }],
      departure: time('2030-01-01T10:05:00+01:00'),
      arrival: time('2030-01-01T10:30:00+01:00'),
      duration_min: 25,
    }),
  ],
  changes: [],
  reliability: null,
  feasible: true,
  issues: [],
  data_quality: 'scheduled',
  alerts: [],
  is_preview: false,
};

const from = { id: 'here', name: 'Home', lat: 40.2, lon: -3.77 };
const to = { id: 'renfe:2', name: 'Atocha' };

afterEach(() => resetConnectionsForTests());

describe('saved connections', () => {
  it('toggle on and off and are kept on the device', async () => {
    toggleConnection(journey, from, to);
    expect(isConnectionSaved('j1')).toBe(true);
    expect(savedConnection('j1')?.to).toEqual(to);
    const stored = JSON.parse((await AsyncStorage.getItem('madridgo.connections.v1')) ?? '[]');
    expect(stored.map((c: { journey: Journey }) => c.journey.id)).toEqual(['j1']);
    toggleConnection(journey, from, to);
    expect(isConnectionSaved('j1')).toBe(false);
  });
});

describe('routeFeatures', () => {
  it('draws legs without a shape straight through their stops', () => {
    const { lines, stops } = routeFeatures(journey);
    expect(lines).toHaveLength(2);
    expect(lines[0].walk).toBe(true);
    expect(lines[1]).toMatchObject({ walk: false, color: '#2C2A86' });
    expect(lines[1].coords).toEqual([
      [-3.77, 40.23],
      [-3.73, 40.3],
      [-3.69, 40.4],
    ]);
    // Start, boarding (the walk's end is the same place), a stop passed, destination.
    expect(stops.map((s) => [s.name, s.major])).toEqual([
      ['Home', true],
      ['Parla', true],
      ['Getafe', false],
      ['Atocha', true],
    ]);
  });

  it('follows the leg shape when there is one', () => {
    const shaped = {
      ...journey,
      legs: [journey.legs[0], { ...journey.legs[1], geometry: '_p~iF~ps|U_ulLnnqC' }],
    };
    expect(routeFeatures(shaped).lines[1].coords).toEqual([
      [-120.2, 38.5],
      [-120.95, 40.7],
    ]);
  });
});
