// Disruptions page data (services/api/app/disruptions.py): every current and upcoming operator
// alert with its lines and stations, and which operators publish alerts at all.

import { getJson } from './client';
import type { Line } from './stops';

export interface DisruptionStation {
  /** The station's board id; null when the stop is not in the timetable. */
  id: string | null;
  name: string;
}

export interface Disruption {
  id: string;
  source: string;
  operator: string;
  operator_name: string;
  kind: 'line' | 'station';
  lines: Line[];
  stations: DisruptionStation[];
  header: string | null;
  description: string | null;
  url: string | null;
  cause: string | null;
  effect: string | null;
  active_from: string | null;
  active_to: string | null;
  upcoming: boolean;
}

export interface DisruptionSource {
  operator: string;
  name: string;
  state: 'ok' | 'stale' | 'no_data' | 'not_available';
  retrieved_at: string | null;
  message: string;
}

export interface Disruptions {
  generated_at: string;
  disruptions: Disruption[];
  sources: DisruptionSource[];
}

export function getDisruptions(fetchImpl: typeof fetch = fetch): Promise<Disruptions> {
  return getJson<Disruptions>('/disruptions', {}, 8000, fetchImpl);
}

/** The page's filter tabs, as in SBB: everything, one operator, or station access. */
export type DisruptionFilter = 'all' | 'rail' | 'bus' | 'stations';

export const RENFE = 'RENFE_CERCANIAS';
export const EMT = 'EMT_MADRID';

/** Line names are compared without case, spaces or dashes: "c-4" finds C4, "n 5" finds N5. */
export function normalizeLine(s: string): string {
  return s.toUpperCase().replace(/[\s\-.]/g, '');
}

export function matchesFilter(d: Disruption, filter: DisruptionFilter, line: string): boolean {
  if (filter === 'rail' && !(d.operator === RENFE && d.kind === 'line')) return false;
  if (filter === 'bus' && d.operator !== EMT) return false;
  if (filter === 'stations' && d.kind !== 'station') return false;
  const want = normalizeLine(line);
  if (!want) return true;
  if (d.kind === 'station') {
    return d.stations.some((s) => normalizeLine(s.name).includes(want));
  }
  return d.lines.some((l) => normalizeLine(l.short_name) === want);
}

/** Sections in page order, each keeping the server's order (by line, then newest). */
export type SectionKey = 'rail' | 'stations' | 'bus';

export function sectionOf(d: Disruption): SectionKey {
  if (d.operator === EMT) return 'bus';
  return d.kind === 'station' ? 'stations' : 'rail';
}

export function groupDisruptions(list: Disruption[]): { key: SectionKey; items: Disruption[] }[] {
  const order: SectionKey[] = ['rail', 'stations', 'bus'];
  return order
    .map((key) => ({ key, items: list.filter((d) => sectionOf(d) === key) }))
    .filter((s) => s.items.length > 0);
}

const stripTag = (s: string) => s.replace(/^#\w+\s+/, ''); // Renfe's "#MadC5 " tag

/**
 * The title: the operator's header, else the description's first sentence (Renfe publishes
 * no headers). Never cut here: the card clips a long one to 3 lines, so no text appears twice.
 */
export function disruptionTitle(d: Disruption): string {
  if (d.header) return d.header;
  const text = stripTag((d.description ?? '').trim());
  return text.match(/^[\s\S]{20,}?[.!?](?=\s|$)/)?.[0] ?? text;
}

/** The text under the title, without repeating it. */
export function disruptionBody(d: Disruption): string | null {
  const text = d.description?.trim();
  if (!text) return null;
  if (d.header) return text;
  return stripTag(text).slice(disruptionTitle(d).length).trim() || null;
}

/** Disruptions in force now on whole lines: what the ⚠ badge on Plan and Departures counts. */
export function currentLineDisruptions(data: Disruptions | null): number {
  return data?.disruptions.filter((d) => d.kind === 'line' && !d.upcoming).length ?? 0;
}
