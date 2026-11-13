import {
  boardRows,
  byAlertSeverity,
  expiredNotice,
  hasArrivals,
  isSevereAlert,
  type Departure,
  type ServiceAlert,
  type StopBoard,
  type StopSummary,
} from './stops';

const alert = (id: string, effect: string | null, stopIds: string[] = []): ServiceAlert => ({
  source: 'renfe_alerts',
  source_alert_id: id,
  operator: 'RENFE',
  header: id,
  description: null,
  url: null,
  cause: null,
  effect,
  active_from: null,
  active_to: null,
  route_ids: [],
  stop_ids: stopIds,
});

describe('alert severity', () => {
  it('treats no service, reduced service and significant delays as severe', () => {
    expect(isSevereAlert(alert('a', 'NO_SERVICE'))).toBe(true);
    expect(isSevereAlert(alert('b', 'REDUCED_SERVICE'))).toBe(true);
    expect(isSevereAlert(alert('c', 'SIGNIFICANT_DELAYS'))).toBe(true);
    expect(isSevereAlert(alert('d', 'OTHER_EFFECT'))).toBe(false);
    expect(isSevereAlert(alert('e', null))).toBe(false);
  });

  it('puts severe alerts first and keeps the server order otherwise', () => {
    const sorted = byAlertSeverity([
      alert('info1', null),
      alert('strike', 'NO_SERVICE'),
      alert('info2', 'OTHER_EFFECT'),
      alert('delays', 'SIGNIFICANT_DELAYS'),
    ]);
    expect(sorted.map((a) => a.source_alert_id)).toEqual(['strike', 'delays', 'info1', 'info2']);
  });

  it('puts a line-wide alert before a station-only one', () => {
    // Live 2026-11-10: a lift at Atocha came before the C-4 strike in the server's order.
    const sorted = byAlertSeverity([alert('lift', null, ['18000']), alert('strike', null)]);
    expect(sorted.map((a) => a.source_alert_id)).toEqual(['strike', 'lift']);
  });
});

describe('arrival boards', () => {
  const stop = (modes: StopSummary['modes']): StopSummary => ({
    id: 's',
    name: 'S',
    code: null,
    lat: null,
    lon: null,
    is_station: true,
    modes,
    lines: [],
    distance_m: null,
  });

  it('are offered at stations, not at bus stops', () => {
    expect(hasArrivals(stop(['rail']))).toBe(true);
    expect(hasArrivals(stop(['metro', 'bus']))).toBe(true);
    expect(hasArrivals(stop(['bus']))).toBe(false);
  });

  it('find an expired timetable, which explains an empty board', () => {
    const notice = (expiry: 'ok' | 'expiring' | 'expired') => ({
      source: 'metro',
      operator: 'Metro de Madrid',
      expiry,
      service_end: '2026-05-27',
      message: '',
    });
    const board = (notices: StopBoard['notices']) => ({ notices }) as StopBoard;
    expect(expiredNotice(board([notice('expiring'), notice('expired')]))?.expiry).toBe('expired');
    expect(expiredNotice(board([notice('expiring')]))).toBeNull();
    expect(expiredNotice(board([]))).toBeNull();
  });

  it('list the arrivals on an arrival board and the departures otherwise', () => {
    const row = (trip_id: string) => ({ trip_id }) as Departure;
    const board = { departures: [row('d')], arrivals: [row('a')] } as StopBoard;
    expect(boardRows({ ...board, kind: 'arrivals' }).map((d) => d.trip_id)).toEqual(['a']);
    expect(boardRows({ ...board, kind: 'departures' }).map((d) => d.trip_id)).toEqual(['d']);
    // An older server sends no kind: a departure board.
    expect(boardRows({ ...board, kind: undefined }).map((d) => d.trip_id)).toEqual(['d']);
  });
});
