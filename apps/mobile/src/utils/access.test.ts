import type { Journey, Leg } from '../api/journeys';
import { alightAccess, boardAccess, journeyAccess, legAccess } from './access';

const time = { scheduled: '2026-11-13T10:00:00+01:00', status: 'scheduled' as const };
function leg(mode: Leg['mode'], accessibility?: Leg['accessibility']): Leg {
  return {
    mode,
    from: 'A',
    to: 'B',
    departure: time,
    arrival: time,
    duration_min: 10,
    intermediate: [],
    accessibility,
  };
}
const journey = (legs: Leg[]) => ({ legs }) as unknown as Journey;
const ok = { vehicle: true, board: true, alight: true };

test('boarding needs both the train and the station', () => {
  expect(boardAccess(ok)).toBe(true);
  expect(boardAccess({ ...ok, vehicle: false })).toBe(false);
  expect(boardAccess({ ...ok, board: false })).toBe(false);
  expect(alightAccess({ ...ok, alight: null })).toBe(null);
  expect(boardAccess(null)).toBe(null);
});

test('a ride is not step-free when either end is not', () => {
  expect(legAccess(leg('rail', ok))).toBe(true);
  expect(legAccess(leg('rail', { ...ok, alight: false }))).toBe(false);
  expect(legAccess(leg('metro'))).toBe(null);
});

test('a connection is step-free only when every ride is known to be', () => {
  expect(journeyAccess(journey([leg('walk'), leg('rail', ok), leg('walk')]))).toBe(true);
  expect(journeyAccess(journey([leg('rail', ok), leg('metro')]))).toBe(null);
  expect(journeyAccess(journey([leg('rail', { ...ok, vehicle: false }), leg('metro')]))).toBe(
    false,
  );
  expect(journeyAccess(journey([leg('walk')]))).toBe(null);
});
