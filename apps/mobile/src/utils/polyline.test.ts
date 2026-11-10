import { decodePolyline } from './polyline';

describe('decodePolyline', () => {
  it('decodes Google’s example', () => {
    expect(decodePolyline('_p~iF~ps|U_ulLnnqC_mqNvxq`@')).toEqual([
      [-120.2, 38.5],
      [-120.95, 40.7],
      [-126.453, 43.252],
    ]);
  });

  it('copes with empty and cut-short input', () => {
    expect(decodePolyline('')).toEqual([]);
    expect(decodePolyline('_p~iF~ps|U_ulL')).toEqual([[-120.2, 38.5]]);
  });
});
