import {
  type AccuracyReport,
  type AccuracyRow,
  biasDirection,
  formatPct,
  formatSeconds,
  getAccuracy,
  liveRows,
  timetableRow,
} from './accuracy';

function row(over: Partial<AccuracyRow>): AccuracyRow {
  return {
    line: '*',
    kind: 'prediction',
    horizon_min: 10,
    estimated: false,
    n: 100,
    mae_s: 90,
    median_abs_s: 60,
    p90_abs_s: 240,
    bias_s: 45,
    pct_1m: 0.5,
    pct_2m: 0.75,
    pct_5m: 0.95,
    ...over,
  };
}

const report: AccuracyReport = {
  operator: 'RENFE_CERCANIAS',
  operator_name: 'Renfe Cercanías',
  first_day: '2026-11-09',
  last_day: '2026-11-15',
  days: 7,
  days_with_data: 1,
  provisional: true,
  min_sample: 500,
  min_days: 7,
  generated_at: '2026-11-15T19:53:32Z',
  lines: [],
  rows: [
    row({ horizon_min: 2 }),
    row({ horizon_min: 30 }),
    row({ horizon_min: 10, estimated: true }),
    row({ horizon_min: 10 }),
    row({ kind: 'schedule', horizon_min: null }),
    row({ line: 'C4a', horizon_min: 5 }),
    row({ line: 'C4a', kind: 'schedule', horizon_min: null, n: 7 }),
  ],
};

describe('accuracy helpers', () => {
  it('lists live rows of one kind, earliest horizon first', () => {
    expect(liveRows(report, '*', false).map((r) => r.horizon_min)).toEqual([30, 10, 2]);
    expect(liveRows(report, '*', true).map((r) => r.horizon_min)).toEqual([10]);
    expect(liveRows(report, 'C4a', false).map((r) => r.horizon_min)).toEqual([5]);
    expect(liveRows(report, 'C1', false)).toEqual([]);
  });

  it('finds the timetable row', () => {
    expect(timetableRow(report, 'C4a')?.n).toBe(7);
    expect(timetableRow(report, 'C1')).toBeNull();
  });

  it.each([
    [104, '1 min 45 s'],
    [-104, '1 min 45 s'],
    [40, '40 s'],
    [2, '0 s'],
    [119, '2 min'],
    [170.5, '2 min 50 s'],
  ])('formats %s s as %s', (s, text) => {
    expect(formatSeconds(s)).toBe(text);
  });

  it('formats shares and the average direction', () => {
    expect(formatPct(0.6012)).toBe('60%');
    expect(biasDirection(170)).toBe('later');
    expect(biasDirection(-30)).toBe('earlier');
    expect(biasDirection(-14)).toBe('onTime');
  });

  it('asks the server for the chosen period', async () => {
    let url = '';
    const fake = (async (u: string) => {
      url = u;
      return { ok: true, status: 200, json: async () => report } as Response;
    }) as unknown as typeof fetch;
    const out = await getAccuracy(30, fake);
    expect(url).toMatch(/\/accuracy\?days=30$/);
    expect(out.days_with_data).toBe(1);
  });
});
