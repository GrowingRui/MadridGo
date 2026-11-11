import type { Journey, Leg } from '../api/journeys';
import {
  connectionIcs,
  connectionText,
  icsDate,
  icsEscape,
  icsFileName,
  icsFold,
} from './shareConnection';

const time = (iso: string, extra: object = {}) => ({
  scheduled: iso,
  status: 'scheduled' as const,
  ...extra,
});

const C4 = {
  source: 'cercanias',
  route_id: 'C4',
  short_name: 'C4',
  long_name: null,
  mode: 'rail' as const,
  color: null,
  text_color: null,
};

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

function journey(legs: Leg[], transfers = 0): Journey {
  return {
    id: 'j-1',
    departure: legs[0].departure,
    arrival: legs[legs.length - 1].arrival,
    duration_min: 48,
    transfers,
    walk_min: 5,
    legs,
    changes: [],
    reliability: null,
    feasible: true,
  } as unknown as Journey;
}

const train = leg({
  mode: 'rail',
  line: C4,
  headsign: 'Alcobendas',
  from: 'Parla',
  to: 'Atocha',
  departure: time('2030-01-02T10:00:00+01:00', { platform: '2' }),
  arrival: time('2030-01-02T10:43:00+01:00'),
  duration_min: 43,
});
const walk = leg({
  from: 'Atocha',
  to: 'Museo del Prado',
  departure: time('2030-01-02T10:43:00+01:00'),
  arrival: time('2030-01-02T10:48:00+01:00'),
});

describe('connectionText', () => {
  it('lists each ride and walk with Madrid times and labels the times as scheduled', () => {
    const text = connectionText(journey([train, walk]));
    expect(text.split('\n')).toEqual([
      'Parla → Museo del Prado',
      'Wed 02.01. · 10:00 – 10:48 (48 min, Direct)',
      '',
      '10:00 Parla, Platform 2',
      '   Cercanías C4 · Direction Alcobendas',
      '10:43 Atocha',
      '10:43 Walk 5 min to Museo del Prado',
      '',
      'Times from the timetable; they may change.',
      'Sent from MadridGo',
    ]);
  });

  it('says when live times are included, and marks cancelled rides', () => {
    const live = leg({
      ...train,
      departure: { ...train.departure, status: 'cancelled' },
      arrival: time('2030-01-02T10:43:00+01:00', { status: 'live' }),
    });
    const text = connectionText(journey([live]), Date.parse('2030-01-02T09:30:00+01:00'));
    expect(text).toContain('Cercanías C4 · Direction Alcobendas (Cancelled)');
    expect(text).toContain('Includes live times from 09:30; they may change.');
  });
});

describe('iCalendar', () => {
  it('escapes text values', () => {
    expect(icsEscape('a,b;c\\d\ne')).toBe('a\\,b\\;c\\\\d\\ne');
  });

  it('writes UTC times', () => {
    expect(icsDate(Date.parse('2030-01-02T10:00:00+01:00'))).toBe('20300102T090000Z');
  });

  it('folds long lines at 75 bytes without splitting characters', () => {
    const line = `DESCRIPTION:${'é'.repeat(80)}`;
    const parts = icsFold(line).split('\r\n');
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(new TextEncoder().encode(p).length).toBeLessThanOrEqual(75);
    expect(parts.map((p, i) => (i ? p.slice(1) : p)).join('')).toBe(line);
  });

  it('makes one event from departure to arrival', () => {
    const now = Date.parse('2030-01-01T12:00:00Z');
    const ics = connectionIcs(journey([train, walk]), now);
    expect(ics.endsWith('\r\n')).toBe(true);
    const unfolded = ics.replace(/\r\n /g, '');
    expect(unfolded).toContain('DTSTART:20300102T090000Z\r\n');
    expect(unfolded).toContain('DTEND:20300102T094800Z\r\n');
    expect(unfolded).toContain('DTSTAMP:20300101T120000Z\r\n');
    expect(unfolded).toContain('SUMMARY:Parla → Museo del Prado\r\n');
    expect(unfolded).toContain('LOCATION:Parla\r\n');
    expect(unfolded).toContain('DESCRIPTION:Parla → Museo del Prado\\nWed 02.01.');
    expect(unfolded.match(/BEGIN:VEVENT/g)).toHaveLength(1);
  });

  it('names the file after the connection', () => {
    expect(icsFileName(journey([train, walk]))).toBe('madridgo-parla-museo-del-prado.ics');
  });
});
