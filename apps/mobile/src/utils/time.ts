// Time formatting. Transit times are always shown in Madrid time, whatever the device zone.

const TZ = 'Europe/Madrid';

const hm = new Intl.DateTimeFormat('es-ES', { hour: '2-digit', minute: '2-digit', timeZone: TZ });
const dayFmt = new Intl.DateTimeFormat('en-GB', {
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  timeZone: TZ,
});

export function formatTime(iso: string | number | Date): string {
  return hm.format(new Date(iso));
}

export function formatDay(iso: string | number | Date): string {
  return dayFmt.format(new Date(iso));
}

/** Whole minutes from now until `iso` (negative if in the past). */
export function minutesUntil(iso: string, now: number = Date.now()): number {
  return Math.floor((Date.parse(iso) - now) / 60_000);
}

/** "now", "in 4 min", or null when it is more than an hour away. */
export function countdown(iso: string, now: number = Date.now()): string | null {
  const m = minutesUntil(iso, now);
  if (m <= 0) return 'now';
  if (m < 60) return `in ${m} min`;
  return null;
}

export function formatDuration(min: number): string {
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

// ---------------------------------------------------------------------------
// Madrid wall-clock arithmetic (for the date and time picker)

const partsFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: TZ,
  weekday: 'short',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

export interface MadridParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  weekday: string; // "Mon"
}

/** The Madrid wall-clock date and time of an instant. */
export function madridParts(at: number | Date): MadridParts {
  const p: Record<string, string> = {};
  for (const { type, value } of partsFmt.formatToParts(new Date(at))) p[type] = value;
  return {
    year: Number(p.year),
    month: Number(p.month),
    day: Number(p.day),
    hour: Number(p.hour) % 24,
    minute: Number(p.minute),
    weekday: p.weekday,
  };
}

function madridOffsetMin(at: number): number {
  const p = madridParts(at);
  const wall = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
  return Math.round((wall - Math.floor(at / 60_000) * 60_000) / 60_000);
}

/** The instant of a Madrid wall-clock time. Correct across DST changes. */
export function fromMadrid(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
): number {
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  let t = wall - madridOffsetMin(wall) * 60_000;
  const second = wall - madridOffsetMin(t) * 60_000; // the offset may differ at the result
  if (second !== t) t = second;
  return t;
}

/** Midnight (Madrid) of the day `days` after the day of `at`. */
export function madridDayStart(at: number, days = 0): number {
  const p = madridParts(at);
  const noon = fromMadrid(p.year, p.month, p.day, 12, 0) + days * 86_400_000;
  const q = madridParts(noon);
  return fromMadrid(q.year, q.month, q.day, 0, 0);
}

/** "Mon 09.11." as on Swiss and Spanish timetables. */
export function formatDateShort(at: number | Date): string {
  const p = madridParts(at);
  const two = (n: number) => String(n).padStart(2, '0');
  return `${p.weekday} ${two(p.day)}.${two(p.month)}.`;
}

/** "Today", "Tomorrow" or "Wed 11.11.". */
export function dayLabel(at: number, now: number = Date.now()): string {
  const diff = Math.round((madridDayStart(at) - madridDayStart(now)) / 86_400_000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Tomorrow';
  return formatDateShort(at);
}
