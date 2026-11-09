import { delayMin, previewJourneys } from '../api/journeys';
import { countdown, formatDuration, formatTime, minutesUntil } from './time';

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

  it('marks every preview journey as preview and keeps legs in order', () => {
    const list = previewJourneys('A', 'B', new Date('2026-11-09T16:00:00Z'));
    expect(list.length).toBeGreaterThan(0);
    for (const j of list) {
      expect(j.is_preview).toBe(true);
      const times = j.legs.map((l) => Date.parse(l.departure.scheduled));
      expect([...times].sort((a, b) => a - b)).toEqual(times);
      // Only Cercanías has a real-time source, so only rail legs may be 'live'.
      for (const leg of j.legs) {
        if (leg.departure.status === 'live') expect(leg.mode).toBe('rail');
      }
    }
  });
});
