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
