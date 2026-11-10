import {
  type Disruption,
  currentLineDisruptions,
  disruptionBody,
  disruptionTitle,
  groupDisruptions,
  matchesFilter,
} from './disruptions';
import type { Line } from './stops';

const line = (short_name: string, source = 'cercanias'): Line => ({
  source,
  route_id: short_name,
  short_name,
  long_name: null,
  mode: source === 'emt' ? 'bus' : 'rail',
  color: null,
  text_color: null,
});

const base: Disruption = {
  id: 'x',
  source: 'renfe_alerts',
  operator: 'RENFE_CERCANIAS',
  operator_name: 'Renfe Cercanías',
  kind: 'line',
  lines: [],
  stations: [],
  header: null,
  description: null,
  url: null,
  cause: null,
  effect: null,
  active_from: null,
  active_to: null,
  upcoming: false,
};

const strike: Disruption = {
  ...base,
  id: 'strike',
  lines: [line('C3'), line('C4'), line('C4a')],
  description:
    'Con motivo de la huelga convocada por SEMAF, se prevén alteraciones. Consulte los servicios mínimos.',
};
const lift: Disruption = {
  ...base,
  id: 'lift',
  kind: 'station',
  stations: [{ id: 'renfe:18000', name: 'Madrid - Atocha Cercanías' }],
  description: 'Ascensor de la estación de Atocha fuera de servicio.',
};
const bus: Disruption = {
  ...base,
  id: 'bus',
  source: 'emt_rss',
  operator: 'EMT_MADRID',
  operator_name: 'EMT Madrid',
  lines: [line('27', 'emt'), line('N5', 'emt')],
  header: 'Manifestación en Cibeles.',
  description: 'Desvío de 20:00 a 22:30.',
  upcoming: true,
};

test('filter tabs and line filter', () => {
  expect(matchesFilter(strike, 'rail', '')).toBe(true);
  expect(matchesFilter(lift, 'rail', '')).toBe(false);
  expect(matchesFilter(lift, 'stations', '')).toBe(true);
  expect(matchesFilter(bus, 'bus', '')).toBe(true);
  expect(matchesFilter(strike, 'all', 'c-4')).toBe(true);
  expect(matchesFilter(strike, 'all', 'C4A')).toBe(true);
  expect(matchesFilter(strike, 'all', 'C')).toBe(false); // whole line names only
  expect(matchesFilter(bus, 'all', 'n 5')).toBe(true);
  expect(matchesFilter(lift, 'all', 'atocha')).toBe(true); // station alerts match by name
});

test('sections in page order', () => {
  expect(groupDisruptions([bus, lift, strike]).map((s) => s.key)).toEqual([
    'rail',
    'stations',
    'bus',
  ]);
});

test('title is the header, or the first sentence without Renfe tags', () => {
  expect(disruptionTitle(bus)).toBe('Manifestación en Cibeles.');
  expect(disruptionBody(bus)).toBe('Desvío de 20:00 a 22:30.');
  expect(disruptionTitle(strike)).toBe(
    'Con motivo de la huelga convocada por SEMAF, se prevén alteraciones.',
  );
  expect(disruptionBody(strike)).toBe('Consulte los servicios mínimos.');
  const tagged = { ...base, description: '#MadC5 Por obras, los días 14 y 15 no hay trenes.' };
  expect(disruptionTitle(tagged)).toBe('Por obras, los días 14 y 15 no hay trenes.');
  expect(disruptionBody(tagged)).toBeNull();
});

test('badge counts line disruptions in force now', () => {
  const data = { generated_at: '', sources: [], disruptions: [strike, lift, bus] };
  expect(currentLineDisruptions(data)).toBe(1);
  expect(currentLineDisruptions(null)).toBe(0);
});
