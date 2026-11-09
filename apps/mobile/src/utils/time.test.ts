import { delayMin, shownTime } from '../api/journeys';
import {
  countdown,
  dayLabel,
  formatDateShort,
  formatDuration,
  formatTime,
  fromMadrid,
  madridDayStart,
  madridParts,
  minutesUntil,
} from './time';

describe('time formatting', () => {
  it('formats in Madrid time whatever the device zone', () => {
    // 16:54 UTC is 17:54 in Madrid (CET, UTC+1) in November.
    expect(formatTime('2026-11-09T16:54:00Z')).toBe('17:54');
  });

  it('counts down to departures', () => {
    const now = Date.parse('2026-11-09T17:00:00+01:00');
    expect(minutesUntil('2026-11-09T17:04:30+01:00', now)).toBe(4);
    expect(countdown('2026-11-09T17:00:20+01:00', now)).toBe('now');
    expect(countdown('2026-11-09T17:12:00+01:00', now)).toBe('in 12 min');
    expect(countdown('2026-11-09T18:30:00+01:00', now)).toBeNull();
  });

  it('formats durations', () => {
    expect(formatDuration(46)).toBe('46 min');
    expect(formatDuration(60)).toBe('1 h');
    expect(formatDuration(95)).toBe('1 h 35 min');
  });
});

describe('journeys', () => {
  it('reports delay only for live times', () => {
    const scheduled = '2026-11-09T17:00:00Z';
    const late = '2026-11-09T17:04:00Z';
    expect(delayMin({ scheduled, estimated: late, status: 'live' })).toBe(4);
    expect(delayMin({ scheduled, estimated: late, status: 'scheduled' })).toBe(0);
    expect(delayMin({ scheduled, status: 'live' })).toBe(0);
  });

  it('shows no delay for headway services (no timetable to compare with)', () => {
    const scheduled = '2026-11-09T17:00:00Z';
    const estimated = '2026-11-09T16:56:00Z';
    const emt = {
      classification: 'LIVE' as const,
      source: 'emt_mobilitylabs',
      retrieved_at: '2026-11-09T16:50:00Z',
      source_timestamp: null,
      freshness: {
        state: 'FRESH' as const,
        age_s: 5,
        age_basis: 'retrieved' as const,
        anomaly: null,
      },
      predicted_time: estimated,
      delay_s: null,
      estimated_from_trip_delay: false,
      vehicle_id: '4521',
      platform: null,
    };
    const t = { scheduled, estimated, status: 'live' as const, realtime: emt };
    expect(delayMin(t)).toBe(0);
    expect(shownTime(t)).toBe(estimated); // the live time itself is printed
    const renfe = { ...t, estimated: '2026-11-09T17:07:00Z', realtime: { ...emt, delay_s: 420 } };
    expect(delayMin(renfe)).toBe(7);
    expect(shownTime(renfe)).toBe(scheduled); // printed as "18:00 +7"
    expect(delayMin({ scheduled, status: 'cancelled' })).toBe(0);
  });
});

describe('Madrid date and time picker maths', () => {
  it('turns a Madrid wall-clock time into the right instant', () => {
    expect(new Date(fromMadrid(2026, 11, 9, 21, 29)).toISOString()).toBe(
      '2026-11-09T20:29:00.000Z',
    );
    expect(new Date(fromMadrid(2026, 7, 1, 8, 0)).toISOString()).toBe('2026-07-01T06:00:00.000Z');
  });

  it('is correct on DST change days', () => {
    // 29 March 2026: 02:00 -> 03:00. 25 October 2026: 03:00 -> 02:00.
    expect(new Date(fromMadrid(2026, 3, 29, 1, 30)).toISOString()).toBe('2026-03-29T00:30:00.000Z');
    expect(new Date(fromMadrid(2026, 3, 29, 3, 30)).toISOString()).toBe('2026-03-29T01:30:00.000Z');
    expect(new Date(fromMadrid(2026, 10, 25, 4, 0)).toISOString()).toBe('2026-10-25T03:00:00.000Z');
    const p = madridParts(fromMadrid(2026, 10, 25, 23, 45));
    expect([p.day, p.hour, p.minute]).toEqual([25, 23, 45]);
    // A day after midnight on the long day is still the next calendar day.
    expect(madridParts(madridDayStart(fromMadrid(2026, 10, 25, 10, 0), 1)).day).toBe(26);
  });

  it('labels days like a timetable', () => {
    const now = Date.parse('2026-11-09T20:29:00Z'); // Mon 21:29 in Madrid
    expect(formatDateShort(now)).toBe('Mon 09.11.');
    expect(dayLabel(now, now)).toBe('Today');
    expect(dayLabel(madridDayStart(now, 1), now)).toBe('Tomorrow');
    expect(dayLabel(madridDayStart(now, 2), now)).toBe('Wed 11.11.');
    // 23:30 UTC on the 9th is already the 10th in Madrid.
    expect(dayLabel(Date.parse('2026-11-09T23:30:00Z'), now)).toBe('Tomorrow');
  });
});
