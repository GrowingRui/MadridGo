// Share a connection and add it to the calendar (as in SBB Mobile). Pure functions: the text
// sent to a chat or e-mail, and an iCalendar (.ics) event that calendar apps can import. The
// platform parts (share sheet, file download) are in utils/shareActions(.web).ts.

import { type Journey, type Leg, shownTime } from '../api/journeys';
import { t, tn } from '../i18n';
import { formatDateShort, formatDuration, formatTime } from './time';

const isLive = (leg: Leg) => leg.departure.status === 'live' || leg.arrival.status === 'live';

/** "Parla → Madrid - Atocha". */
export function connectionTitle(journey: Journey): string {
  return `${journey.legs[0].from} → ${journey.legs[journey.legs.length - 1].to}`;
}

function legLines(leg: Leg): string[] {
  const dep = formatTime(shownTime(leg.departure));
  const arr = formatTime(shownTime(leg.arrival));
  if (leg.mode === 'walk') {
    return [`${dep} ${t('journey.walk', { min: leg.duration_min, distance: '', stop: leg.to })}`];
  }
  const ride = [t(`mode.${leg.mode}`), leg.line?.short_name].filter(Boolean).join(' ');
  const direction = leg.headsign ? ` · ${t('conn.direction', { name: leg.headsign })}` : '';
  const platform = leg.departure.platform
    ? `, ${t('journey.platform', { p: leg.departure.platform })}`
    : '';
  const cancelled =
    leg.departure.status === 'cancelled' || leg.arrival.status === 'cancelled'
      ? ` (${t('status.cancelled')})`
      : '';
  return [
    `${dep} ${leg.from}${platform}`,
    `   ${ride}${direction}${cancelled}`,
    `${arr} ${leg.to}`,
  ];
}

/**
 * The connection as plain text:
 *
 *   Parla → Madrid - Atocha
 *   Wed 11.11. · 13:05 – 13:48 (43 min, direct)
 *
 *   13:05 Parla, Platform 2
 *      Cercanías C4 · Direction Alcobendas
 *   13:48 Madrid - Atocha
 *
 *   Times from the timetable; they may change.
 *   Sent from MadridGo
 */
export function connectionText(journey: Journey, now: number = Date.now()): string {
  const dep = shownTime(journey.departure);
  const arr = shownTime(journey.arrival);
  const changes = journey.transfers ? tn('conn.changes', journey.transfers) : t('conn.direct');
  const head = [
    connectionTitle(journey),
    `${formatDateShort(Date.parse(dep))} · ${formatTime(dep)} – ${formatTime(arr)} (${formatDuration(
      journey.duration_min,
    )}, ${changes})`,
  ];
  const body = journey.legs.flatMap(legLines);
  const footer = journey.legs.some(isLive)
    ? t('share.footerLive', { time: formatTime(now) })
    : t('share.footerScheduled');
  return [...head, '', ...body, '', footer, t('share.sentBy')].join('\n');
}

// ---------------------------------------------------------------------------
// iCalendar (RFC 5545)

/** Text values: backslash, semicolon, comma and newlines are escaped. */
export function icsEscape(s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

/** UTC date-time: 20261111T120500Z. */
export function icsDate(ms: number): string {
  return new Date(ms)
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');
}

const utf8Length = (ch: string) => {
  const c = ch.codePointAt(0) ?? 0;
  return c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4;
};

/** Lines longer than 75 bytes go on as continuation lines (CRLF + space), never inside a character. */
export function icsFold(line: string): string {
  const out: string[] = [];
  let cur = '';
  let bytes = 0;
  for (const ch of line) {
    const n = utf8Length(ch);
    const max = out.length ? 74 : 75; // continuation lines start with a space
    if (bytes + n > max) {
      out.push(cur);
      cur = '';
      bytes = 0;
    }
    cur += ch;
    bytes += n;
  }
  out.push(cur);
  return out.join('\r\n ');
}

/** A small stable hash for the event UID (the journey id can be long). */
function hash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** One event from departure to arrival, at the first stop, with the connection as notes. */
export function connectionIcs(journey: Journey, now: number = Date.now()): string {
  const start = Date.parse(shownTime(journey.departure));
  const end = Date.parse(shownTime(journey.arrival));
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//MadridGo//Connection//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${hash(journey.id)}-${icsDate(start)}@madridgo`,
    `DTSTAMP:${icsDate(now)}`,
    `DTSTART:${icsDate(start)}`,
    `DTEND:${icsDate(end)}`,
    `SUMMARY:${icsEscape(connectionTitle(journey))}`,
    `LOCATION:${icsEscape(journey.legs[0].from)}`,
    `DESCRIPTION:${icsEscape(connectionText(journey, now))}`,
    'END:VEVENT',
    'END:VCALENDAR',
  ];
  return lines.map(icsFold).join('\r\n') + '\r\n';
}

/** "madridgo-parla-madrid-atocha.ics". */
export function icsFileName(journey: Journey): string {
  const slug = connectionTitle(journey)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
  return `madridgo-${slug || 'connection'}.ics`;
}
