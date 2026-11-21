import AsyncStorage from '@react-native-async-storage/async-storage';

import { ApiError } from '../api/client';
import type { JourneyPlan } from '../api/journeys';
import type { StopBoard } from '../api/stops';
import {
  MAX_COPIES,
  boardAsTimetable,
  copySavedAt,
  planAsTimetable,
  recallCopy,
  rememberCopy,
  withOfflineCopy,
} from './offlineCopies';

const board = {
  stop: { id: 's1' },
  data_quality: 'partly_live',
  departures: [
    {
      status: 'live',
      time: '2026-11-21T10:00:00Z',
      realtime: { predicted_time: '2026-11-21T10:05:00Z' },
      usual_delay: { minutes: 4 },
    },
    { status: 'cancelled', time: '2026-11-21T10:10:00Z', realtime: { classification: 'CANCELLED' } },
  ],
  live_arrivals: [{ time: '2026-11-21T10:02:00Z' }],
  frequencies: [{ headway_min: 5 }],
  notices: [],
  realtime: [{ feed: 'renfe' }],
  alerts: [{ source_alert_id: 'a' }],
} as unknown as StopBoard;

const down = () => Promise.reject(new ApiError('no network', null));

beforeEach(() => AsyncStorage.clear());

describe('withOfflineCopy', () => {
  it('returns a fresh answer unmarked and keeps it as the copy', async () => {
    const data = await withOfflineCopy('k', () => Promise.resolve(board), boardAsTimetable);
    expect(data).toBe(board);
    expect(copySavedAt(data)).toBeNull();
    await new Promise((r) => setTimeout(r, 0));
    expect((await recallCopy<StopBoard>('k'))?.data.stop.id).toBe('s1');
  });

  it('falls back to the saved copy, marked, when the network is unreachable', async () => {
    await rememberCopy('k', board, 1_000);
    const data = await withOfflineCopy('k', down, boardAsTimetable);
    expect(copySavedAt(data)).toBe(1_000);
    expect(data.stop.id).toBe('s1');
  });

  it('falls back when the server is down (5xx) but not on a 404', async () => {
    await rememberCopy('k', board);
    const fivexx = () => Promise.reject(new ApiError('x', 503));
    expect(copySavedAt(await withOfflineCopy('k', fivexx, boardAsTimetable))).not.toBeNull();
    const notFound = () => Promise.reject(new ApiError('x', 404));
    await expect(withOfflineCopy('k', notFound, boardAsTimetable)).rejects.toThrow('x');
  });

  it('throws the original error when there is no copy', async () => {
    await expect(withOfflineCopy('none', down, boardAsTimetable)).rejects.toThrow('no network');
  });

  it('keeps at most MAX_COPIES, dropping the oldest', async () => {
    for (let i = 0; i < MAX_COPIES + 3; i++) await rememberCopy(`k${i}`, { i });
    expect(await recallCopy('k0')).toBeNull();
    expect(await recallCopy('k2')).toBeNull();
    expect(await recallCopy('k3')).not.toBeNull();
    expect(await recallCopy(`k${MAX_COPIES + 2}`)).not.toBeNull();
  });
});

describe('boardAsTimetable', () => {
  it('removes everything live', () => {
    const b = boardAsTimetable(board);
    expect(b.data_quality).toBe('scheduled');
    expect(b.live_arrivals).toEqual([]);
    expect(b.realtime).toEqual([]);
    expect(b.alerts).toEqual([]);
    expect(b.departures.every((d) => d.status === 'scheduled' && d.realtime === null)).toBe(true);
    expect(b.departures[0].usual_delay).toBeNull();
    expect(b.frequencies).toHaveLength(1);
  });
});

describe('planAsTimetable', () => {
  const lt = (iso: string) => ({ scheduled: iso, status: 'live', estimated: iso, realtime: {} });
  const journey = (id: string, iso: string) => ({
    id,
    departure: lt(iso),
    arrival: lt(iso),
    legs: [{ departure: lt(iso), arrival: lt(iso), usual_delay: { minutes: 3 } }],
    changes: [{ basis: 'live' }],
    data_quality: 'partly_live',
    alerts: [{}],
  });
  const plan = {
    journeys: [journey('past', '2026-11-21T09:00:00Z'), journey('next', '2026-11-21T11:00:00Z')],
    realtime: [{}],
  } as unknown as JourneyPlan;

  it('drops connections that have left and strips live data from the rest', () => {
    const p = planAsTimetable(plan, Date.parse('2026-11-21T10:00:00Z'));
    expect(p.journeys.map((j) => j.id)).toEqual(['next']);
    const j = p.journeys[0];
    expect(j.departure).toEqual({
      scheduled: '2026-11-21T11:00:00Z',
      status: 'scheduled',
      estimated: null,
      realtime: null,
    });
    expect(j.legs[0].usual_delay).toBeNull();
    expect(j.changes[0].basis).toBe('scheduled');
    expect(j.alerts).toEqual([]);
    expect(p.realtime).toEqual([]);
  });
});
