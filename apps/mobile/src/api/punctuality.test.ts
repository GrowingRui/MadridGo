import { type LinePunctuality, type PunctualityEntry, onTime, worstBand } from './punctuality';

const e = (minutes: number): PunctualityEntry => ({
  minutes,
  often_minutes: minutes + 4,
  sample: 100,
  days: 8,
});
const lp = (bands: LinePunctuality['bands']): LinePunctuality => ({
  line: {} as LinePunctuality['line'],
  overall: e(3),
  bands,
});

describe('onTime', () => {
  it('counts 0 and 1 minute as on time', () => {
    expect(onTime(e(0))).toBe(true);
    expect(onTime(e(1))).toBe(true);
    expect(onTime(e(2))).toBe(false);
  });
});

describe('worstBand', () => {
  it('names a time of the week that is clearly worse', () => {
    expect(worstBand(lp({ weekday_morning: e(7), weekday_midday: e(3), weekend: e(1) }))).toBe(
      'weekday_morning',
    );
  });
  it('names none when the difference is small or there is only one time', () => {
    expect(worstBand(lp({ weekday_morning: e(4), weekday_midday: e(3) }))).toBeNull();
    expect(worstBand(lp({ weekend: e(5) }))).toBeNull();
    expect(worstBand(lp({}))).toBeNull();
  });
});
