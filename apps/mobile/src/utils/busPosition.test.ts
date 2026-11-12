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
  placeBus,
  placeBusOnTrip,
  pointAlong,
  rowAt,
  stopShares,
} from './busPosition';
import type { TripDetails } from '../api/trips';
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

describe('the bus on the journey timeline and the trip screen', () => {
  // The same leg with its stops: two in between, at a quarter and three quarters of the way.
  const withStops: Leg = {
    ...leg,
    from_lat: 40.42,
    from_lon: -3.69,
    to_lat: 40.428,
    to_lon: -3.69,
    intermediate: [
      { name: 'A', stop_id: 'emt:1', time: iso(T0 + 15 * min), lat: 40.422, lon: -3.69 },
      { name: 'B', stop_id: 'emt:2', time: iso(T0 + 25 * min), lat: 40.426, lon: -3.69 },
    ],
  };

  it('rowAt finds the row and the share of the way to the next', () => {
    expect(rowAt([0, 10, 30], 20)).toEqual({ row: 1, progress: 0.5 });
    expect(rowAt([0, 10, 30], -5)).toEqual({ row: 0, progress: 0 });
    expect(rowAt([0, 10, 30], 99)).toEqual({ row: 2, progress: 0 });
    expect(rowAt([0], 0)).toBeNull();
  });

  it('stops along the leg path', () => {
    const s = stopShares(withStops)!;
    expect(s[0]).toBe(0);
    expect(s[1]).toBeCloseTo(0.25, 2);
    expect(s[2]).toBeCloseTo(0.75, 2);
    expect(s[3]).toBe(1);
    expect(stopShares({ ...withStops, to_lat: null })).toBeNull();
  });

  it('on the bus: between the stops by the metres to go', () => {
    // 445 of 890 m to go: halfway, so between A (0.25) and B (0.75), in the middle.
    const p = placeBus(pos({}), withStops, T0);
    expect(p.kind).toBe('riding');
    if (p.kind !== 'riding') return;
    expect(p.row).toBe(1);
    expect(p.progress).toBeCloseTo(0.5, 2);
    expect(p.at).toBe(false);
  });

  it('without stop coordinates: by the seconds to go on the timetable', () => {
    const noCoords = { ...withStops, from_lat: null };
    // 2.5 min to go: 27.5 min after T0, between B (25) and the stop (30).
    const p = placeBus(pos({ seconds: 150 }), noCoords, T0);
    expect(p).toEqual({ kind: 'riding', row: 2, progress: 0.5, at: false });
  });

  it('coming: above your stop; nothing when too old', () => {
    expect(placeBus(pos({ status: 'approaching' }), withStops, T0).kind).toBe('approaching');
    expect(placeBus(pos({}), withStops, T0 + 181_000).kind).toBe('none');
    expect(placeBus(null, withStops, T0).kind).toBe('none');
  });

  it('trip screen: the stops before yours by the seconds to your stop', () => {
    const trip: TripDetails = {
      trip_id: 'emt:LA0270126',
      board_index: 2,
      alight_index: 5,
      stops: [0, 2, 4, 6, 8, 10].map((m, i) => ({
        index: i,
        stop_id: `emt:${i}`,
        name: `S${i}`,
        departure: iso(T0 + m * min),
      })),
    };
    // Your stop (row 2) at T0+4 min; 3 min to go: T0+1 min, halfway from row 0 to row 1.
    expect(placeBusOnTrip(pos({ status: 'approaching', seconds: 180 }), withStops, trip, T0)).toEqual(
      { row: 0, progress: 0.5, at: false },
    );
    // On the bus, the leg's stops are the trip's rows 2..5: the leg's row 1 is the trip's 3.
    const riding = placeBusOnTrip(pos({}), withStops, trip, T0)!;
    expect(riding.row).toBe(3);
    expect(riding.progress).toBeCloseTo(0.5, 2);
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
    // The timelines draw no GPS fix, so they leave the map note out.
    expect(busSourceText(pos({ status: 'approaching', lat: 40, lon: -3.7 }), T0, false)).toBe(
      'Live · EMT, updated 0 s ago',
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
