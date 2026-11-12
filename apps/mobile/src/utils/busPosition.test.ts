import type { BusPosition } from '../api/buses';
import { getBusPosition } from '../api/buses';
import type { Journey, Leg } from '../api/journeys';
import { setLanguageForTests } from '../i18n';
import {
  busPoint,
  busQuery,
  busSourceText,
  busKeepForward,
  busText,
  canTrackBus,
  distanceText,
  isBusShown,
  metresToGo,
  pointAlong,
} from './busPosition';
import { followedLeg } from './liveMap';

const T0 = Date.parse('2026-11-12T08:00:00Z');
const iso = (ms: number) => new Date(ms).toISOString();
const min = 60_000;

// Line 27 northbound: a straight path due north, 0.008° of latitude (about 890 m).
const geometry = '_puuFnuoU_q@?'; // (40.42, -3.69) -> (40.428, -3.69)
const leg: Leg = {
  mode: 'bus',
  trip_id: 'emt:LA0270126',
  line: {
    source: 'emt',
    route_id: '027',
    short_name: '27',
    long_name: '',
    mode: 'bus',
    color: '0178BC',
    text_color: 'FFFFFF',
  },
  headsign: 'Plaza Castilla',
  from: 'Cibeles',
  to: 'Plaza Castilla',
  from_stop_id: 'emt:72',
  to_stop_id: 'emt:5602',
  departure: {
    scheduled: iso(T0 + 10 * min),
    status: 'live',
    estimated: iso(T0 + 12 * min),
    realtime: { vehicle_id: '518' } as Leg['departure']['realtime'],
  },
  arrival: { scheduled: iso(T0 + 30 * min), status: 'frequency' },
  duration_min: 20,
  distance_m: 890,
  intermediate: [],
  geometry,
};

function pos(p: Partial<BusPosition>): BusPosition {
  return {
    status: 'riding',
    message: '',
    line: '27',
    vehicle_id: '518',
    distance_m: 445,
    seconds: 100,
    expected_at: iso(T0 + 100_000),
    observed_at: iso(T0),
    source: 'emt_mobilitylabs',
    attribution: 'Powered by EMT de Madrid',
    poll_after_s: 20,
    ...p,
  };
}

beforeAll(() => setLanguageForTests('en'));

describe('which bus to follow', () => {
  it('follows an EMT ride from 45 min before it leaves until just after it arrives', () => {
    expect(canTrackBus(leg, T0 + 12 * min - 46 * min)).toBe(false);
    expect(canTrackBus(leg, T0 + 12 * min - 44 * min)).toBe(true);
    expect(canTrackBus(leg, T0 + 31 * min)).toBe(true);
    expect(canTrackBus(leg, T0 + 33 * min)).toBe(false);
  });

  it('only EMT legs with a line and EMT stops', () => {
    expect(canTrackBus({ ...leg, trip_id: 'interurban:1' }, T0)).toBe(false);
    expect(canTrackBus({ ...leg, to_stop_id: null }, T0)).toBe(false);
    expect(canTrackBus({ ...leg, line: null }, T0)).toBe(false);
  });

  it('the live map follows the bus of a connection', () => {
    const j = { legs: [leg] } as unknown as Journey;
    expect(followedLeg(j, T0)).toBe(0);
  });

  it('asks for the bus found by the search, then for the one found by the last answer', () => {
    expect(busQuery(leg)).toEqual({
      line: '27',
      fromStop: 'emt:72',
      toStop: 'emt:5602',
      fromName: 'Cibeles',
      vehicle: '518',
      routeM: 890,
    });
    expect(busQuery(leg, '525').vehicle).toBe('525');
  });
});

describe('where to draw the bus', () => {
  it('on the bus: that many metres before the stop, along the leg', () => {
    const p = busPoint(pos({}), leg, T0)!;
    expect(p.estimated).toBe(false);
    expect(p.lon).toBeCloseTo(-3.69, 5);
    expect(p.lat).toBeCloseTo(40.424, 3); // halfway: 445 of 890 m to go
  });

  it('moves on at its own pace for at most 45 s, never past the stop', () => {
    expect(metresToGo(pos({}), T0 + 20_000)).toBeCloseTo(445 - 89, 0);
    expect(metresToGo(pos({}), T0 + 120_000)).toBeCloseTo(445 - 200.25, 0);
    expect(metresToGo(pos({ distance_m: 50, seconds: 10 }), T0 + 40_000)).toBe(0);
  });

  it('before boarding: at its last GPS fix', () => {
    const p = busPoint(pos({ status: 'approaching', lat: 40.41, lon: -3.69 }), leg, T0);
    expect(p).toEqual({ lat: 40.41, lon: -3.69, estimated: false });
    expect(busPoint(pos({ status: 'approaching' }), leg, T0)).toBeNull();
  });

  it('nothing when too old, unavailable or without a path', () => {
    expect(isBusShown(pos({}), T0 + 181_000)).toBe(false);
    expect(busPoint(pos({ status: 'unavailable', distance_m: null }), leg, T0)).toBeNull();
    expect(busPoint(pos({}), { ...leg, geometry: null }, T0)).toBeNull();
  });

  it('pointAlong walks the line by distance', () => {
    const line: [number, number][] = [
      [0, 0],
      [0, 0.001],
      [0, 0.003],
    ];
    expect(pointAlong(line, 0.5)![1]).toBeCloseTo(0.0015, 6);
    expect(pointAlong(line, 2)).toEqual([0, 0.003]);
  });
});

describe('what the card says', () => {
  it('distances', () => {
    expect(distanceText(72)).toBe('70 m');
    expect(distanceText(1234)).toBe('1.2 km');
  });

  it('coming and riding', () => {
    const coming = pos({ status: 'approaching', distance_m: 1200, seconds: 240 });
    coming.expected_at = iso(T0 + 240_000);
    expect(busText(coming, leg, T0)).toBe('Bus arrives in 4 min · 1.2 km away');
    expect(busText({ ...coming, expected_at: iso(T0 + 30_000) }, leg, T0)).toBe(
      'Bus arriving now · 1.2 km away',
    );
    expect(busText(pos({ distance_m: 2300 }), leg, T0)).toBe('2.3 km to Plaza Castilla');
  });

  it('always says where it comes from and what the map point is', () => {
    expect(busSourceText(pos({}), T0 + 15_000)).toBe('Live · EMT, updated 15 s ago');
    expect(busSourceText(pos({ status: 'approaching', lat: 40, lon: -3.7 }), T0)).toBe(
      'Live · EMT, updated 0 s ago · map point: where the bus last reported its position',
    );
  });
});

describe('the request', () => {
  it('sends the leg and the bus id', async () => {
    const fetchImpl = jest.fn(
      async () => new Response(JSON.stringify(pos({}))),
    ) as unknown as typeof fetch;
    await getBusPosition(
      { line: '27', fromStop: 'emt:72', toStop: 'emt:5602', vehicle: '518', routeM: 890.4 },
      fetchImpl,
    );
    const url = (fetchImpl as unknown as jest.Mock).mock.calls[0][0] as string;
    expect(url).toMatch(
      /\/buses\/position\?line=27&from_stop=emt%3A72&to_stop=emt%3A5602&vehicle=518&route_m=890$/,
    );
  });
});

describe('never backwards', () => {
  it('a later answer cannot put the same bus further away while the last one is recent', () => {
    const prev = pos({ distance_m: 1478, seconds: 373 });
    const next = pos({ distance_m: 1579, seconds: 401, observed_at: iso(T0 + 22_000) });
    expect(busKeepForward(prev, next, T0 + 22_000).distance_m).toBe(
      Math.round(metresToGo(prev, T0 + 22_000)!),
    );
    expect(busKeepForward(prev, pos({ distance_m: 1300 }), T0).distance_m).toBe(1300);
  });

  it('another bus, or an old answer, does not hold it back', () => {
    const prev = pos({ distance_m: 500 });
    expect(busKeepForward(prev, pos({ distance_m: 900, vehicle_id: '531' }), T0).distance_m).toBe(
      900,
    );
    expect(busKeepForward(prev, pos({ distance_m: 900 }), T0 + 200_000).distance_m).toBe(900);
  });
});
