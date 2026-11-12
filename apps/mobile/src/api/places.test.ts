import { HERE_ID, planPlace } from '../state/planner';
import { type PlaceResult, placeFromResult, placeIcon } from './places';

const mayor: PlaceResult = {
  id: 'cc:portal:13.PV.MUN_280790145203',
  name: 'Calle Mayor 5',
  detail: '28012 Madrid',
  kind: 'address',
  lat: 40.416362,
  lon: -3.705497,
  business: false,
};

describe('address and place search', () => {
  it('turns a result into a planner place: a point with its name', () => {
    const place = placeFromResult(mayor);
    expect(place).toEqual({
      id: 'place:cc:portal:13.PV.MUN_280790145203',
      name: 'Calle Mayor 5',
      lat: 40.416362,
      lon: -3.705497,
    });
    expect(place.id).not.toBe(HERE_ID);
    expect(planPlace(place)).toEqual({ lat: 40.416362, lon: -3.705497, name: 'Calle Mayor 5' });
  });

  it('plans "Current location" and stops as before', () => {
    expect(planPlace({ id: HERE_ID, name: 'Ubicación actual', lat: 40.4, lon: -3.7 })).toEqual({
      lat: 40.4,
      lon: -3.7,
    });
    expect(planPlace({ id: 'renfe:18000', name: 'Atocha' })).toBe('renfe:18000');
  });

  it('has an icon for each kind', () => {
    expect(placeIcon('address')).toBe('home-outline');
    expect(placeIcon('street')).toBe('road-variant');
    expect(placeIcon('place')).toBe('map-marker-outline');
    expect(placeIcon('area')).toBe('city-variant-outline');
  });
});
