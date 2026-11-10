import { byAlertSeverity, isSevereAlert, type ServiceAlert } from './stops';

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
