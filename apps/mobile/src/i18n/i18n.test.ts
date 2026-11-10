import { countdown, dayLabel, formatDateShort, formatIsoDate } from '../utils/time';
import { approachText, sourceText } from '../utils/trainPosition';
import { en } from './en';
import { es } from './es';
import { setLanguageForTests, splitSlots, t, tn } from './index';

const slots = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

afterEach(() => setLanguageForTests('en'));

describe('dictionaries', () => {
  it('have the same keys and the same placeholders in both languages', () => {
    expect(Object.keys(es).sort()).toEqual(Object.keys(en).sort());
    for (const key of Object.keys(en) as (keyof typeof en)[]) {
      expect([key, slots(es[key])]).toEqual([key, slots(en[key])]);
    }
  });

  it('have every plural in both forms', () => {
    for (const key of Object.keys(en)) {
      if (key.endsWith('.one')) expect(Object.keys(en)).toContain(key.replace(/one$/, 'other'));
    }
  });
});

describe('t and tn', () => {
  it('fill placeholders in the current language', () => {
    expect(t('conn.direction', { name: 'Parla' })).toBe('Direction Parla');
    setLanguageForTests('es');
    expect(t('conn.direction', { name: 'Parla' })).toBe('Dirección Parla');
  });

  it('pick the plural form', () => {
    expect(tn('conn.changes', 1)).toBe('1 change');
    expect(tn('conn.changes', 2)).toBe('2 changes');
    setLanguageForTests('es');
    expect(tn('conn.changes', 1)).toBe('1 transbordo');
    expect(tn('journey.stops', 3)).toBe('3 paradas');
  });

  it('split a text with styled slots', () => {
    expect(splitSlots('{live} times, a red {delay}.')).toEqual([
      { slot: 'live' },
      { text: ' times, a red ' },
      { slot: 'delay' },
      { text: '.' },
    ]);
  });
});

describe('Spanish formatting', () => {
  it('writes days, countdowns and train positions in Spanish', () => {
    setLanguageForTests('es');
    const now = Date.parse('2026-11-10T17:00:00+01:00');
    expect(countdown('2026-11-10T17:12:00+01:00', now)).toBe('en 12 min');
    expect(countdown('2026-11-10T17:00:10+01:00', now)).toBe('ahora');
    expect(dayLabel(now, now)).toBe('Hoy');
    expect(dayLabel(now + 86_400_000, now)).toBe('Mañana');
    expect(formatDateShort(Date.parse('2026-11-11T12:00:00+01:00'))).toBe('Mié 11.11.');
    expect(formatIsoDate('2025-05-30')).toBe('30/05/2025');
    expect(approachText({ stopsAway: 2, at: true, near: 'Fuenlabrada' })).toBe(
      'El tren está a 2 paradas · en Fuenlabrada',
    );
    expect(
      sourceText({ kind: 'estimated', delay_s: 240 } as Parameters<typeof sourceText>[0], null),
    ).toBe('Estimada · horario + 4 min de retraso en tiempo real');
  });

  it('keeps English dates readable', () => {
    expect(formatDateShort(Date.parse('2026-11-11T12:00:00+01:00'))).toBe('Wed 11.11.');
    expect(formatIsoDate('2025-05-30')).toBe('30 May 2025');
  });
});
