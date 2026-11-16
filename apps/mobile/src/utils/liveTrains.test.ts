import type { Line } from '../api/stops';
import type { LiveTrain } from '../api/trains';
import { DEFAULT_TRAIN_COLOR, linesRunning, mergeTrains, standing, trainDots } from './liveTrains';

const T0 = Date.parse('2026-11-16T20:00:00Z');
const iso = (ms: number) => new Date(ms).toISOString();

const line = (short_name: string, color: string | null = 'FECB00'): Line => ({
  source: 'cercanias',
  route_id: `cercanias:${short_name}`,
  short_name,
  long_name: null,
  mode: 'rail',
  color,
  text_color: null,
});

const stop = (index: number, lat: number, lon: number) => ({
  index,
  stop_id: `renfe:${index}`,
  name: `S${index}`,
  lat,
  lon,
});

const train = (p: Partial<LiveTrain>): LiveTrain => ({
  trip_id: 'cercanias:1',
  status: 'between',
  kind: 'live',
  message: '',
  last_stop: stop(3, 40.3, -3.7),
  next_stop: stop(4, 40.4, -3.7),
  progress: 0.5,
  observed_at: iso(T0),
  poll_after_s: 15,
  line: line('C5'),
  headsign: 'Humanes',
  ...p,
});

describe('live train dots', () => {
  it('places each train between its stations, in its line colour', () => {
    const [dot] = trainDots([train({})], T0, null);
    expect(dot).toMatchObject({ id: 'cercanias:1', color: '#FECB00', label: 'C5', estimated: false });
    expect(dot.lat).toBeCloseTo(40.35);
    expect(dot.lon).toBeCloseTo(-3.7);
  });

  it('follows the track it is given', () => {
    // An L-shaped track: east first, then north.
    const path: [number, number][] = [
      [-3.7, 40.3],
      [-3.6, 40.3],
      [-3.6, 40.4],
    ];
    const t = train({ next_stop: stop(4, 40.4, -3.6), path, progress: 0.25 });
    const [dot] = trainDots([t], T0, null);
    expect(dot.lat).toBeCloseTo(40.3, 2); // still on the first, east-going part
    expect(dot.lon).toBeGreaterThan(-3.7);
  });

  it('shows only the picked line', () => {
    const trains = [train({}), train({ trip_id: 'cercanias:2', line: line('C3', '952585') })];
    expect(trainDots(trains, T0, 'C3').map((d) => d.id)).toEqual(['cercanias:2']);
    expect(trainDots(trains, T0, null)).toHaveLength(2);
  });

  it('draws estimated trains hollow, and hides old ones', () => {
    expect(trainDots([train({ kind: 'estimated' })], T0, null)[0].estimated).toBe(true);
    expect(trainDots([train({})], T0 + 10 * 60_000, null)).toEqual([]);
  });

  it('uses a default colour for a train without line', () => {
    expect(trainDots([train({ line: null })], T0, null)[0]).toMatchObject({
      color: DEFAULT_TRAIN_COLOR,
      label: '',
    });
  });
});

describe('new answers', () => {
  it('never moves a train back a station while its last position is recent', () => {
    const before = [train({ last_stop: stop(5, 40.5, -3.7), next_stop: stop(6, 40.6, -3.7) })];
    const back = [train({ observed_at: iso(T0 + 15_000) })]; // says station 3 again
    expect(mergeTrains(before, back, T0 + 15_000)[0].last_stop?.index).toBe(5);
    const ahead = [train({ last_stop: stop(6, 40.6, -3.7), next_stop: stop(7, 40.7, -3.7) })];
    expect(mergeTrains(before, ahead, T0 + 15_000)[0].last_stop?.index).toBe(6);
  });

  it('drops trains no longer in the answer and adds new ones', () => {
    const merged = mergeTrains([train({})], [train({ trip_id: 'cercanias:9' })], T0);
    expect(merged.map((t) => t.trip_id)).toEqual(['cercanias:9']);
  });
});

describe('line filter', () => {
  it('lists the lines with trains, in network order, then unknown ones', () => {
    const trains = [
      train({ line: line('C5') }),
      train({ trip_id: 'cercanias:2', line: line('C10') }),
      train({ trip_id: 'cercanias:3', line: line('C2') }),
      train({ trip_id: 'cercanias:4', line: line('C9') }),
    ];
    expect(linesRunning(trains, T0, ['C1', 'C2', 'C5', 'C10'])).toEqual(['C2', 'C5', 'C10', 'C9']);
  });
});

describe('standing at a station', () => {
  it('a live train at_stop stands; one between stations does not', () => {
    expect(standing(train({ status: 'at_stop', progress: 0 }), T0)).toBe(true);
    expect(standing(train({}), T0)).toBe(false);
  });
});
