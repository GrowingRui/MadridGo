import AsyncStorage from '@react-native-async-storage/async-storage';

import { HERE_ID, type Place } from './planner';
import {
  MAX_COMMUTES,
  addCommute,
  canSaveRoute,
  commuteId,
  isRouteSaved,
  removeCommute,
  resetCommutesForTests,
  swapCommute,
} from './commutes';

const parla: Place = { id: 'renfe:37012', name: 'Parla' };
const sol: Place = { id: 'renfe:18000', name: 'Madrid-Puerta de Atocha' };
const here: Place = { id: HERE_ID, name: 'Current location', lat: 40.4, lon: -3.7 };
const address: Place = { id: 'place:1', name: 'Calle Mayor 1', lat: 40.4153, lon: -3.7074 };

async function saved(): Promise<{ id: string; from: Place; to: Place }[]> {
  const raw = await AsyncStorage.getItem('madridgo.commutes.v1');
  return raw ? JSON.parse(raw) : [];
}

beforeEach(async () => {
  resetCommutesForTests();
  await AsyncStorage.clear();
});

describe('commutes', () => {
  it('saves a route and refuses the same route twice, in either direction', async () => {
    expect(addCommute(parla, sol)).toBe('added');
    expect(addCommute(parla, sol)).toBe('exists');
    expect(addCommute(sol, parla)).toBe('exists');
    expect(isRouteSaved(sol, parla)).toBe(true);
    expect(await saved()).toHaveLength(1);
  });

  it('does not save "Current location" or a route from a place to itself', () => {
    expect(canSaveRoute(here, sol)).toBe(false);
    expect(canSaveRoute(parla, here)).toBe(false);
    expect(canSaveRoute(parla, parla)).toBe(false);
    expect(canSaveRoute(null, sol)).toBe(false);
    expect(addCommute(here, sol)).toBe('invalid');
    expect(addCommute(parla, parla)).toBe('invalid');
  });

  it('keeps addresses apart by their point', () => {
    const other: Place = { ...address, lat: 40.5, lon: -3.6 };
    expect(commuteId(parla, address)).not.toBe(commuteId(parla, other));
    expect(addCommute(parla, address)).toBe('added');
    expect(addCommute(parla, other)).toBe('added');
  });

  it('keeps at most five routes', () => {
    for (let i = 0; i < MAX_COMMUTES; i++) {
      expect(addCommute({ id: `s${i}`, name: `S${i}` }, sol)).toBe('added');
    }
    expect(addCommute(parla, sol)).toBe('full');
  });

  it('swaps the direction and keeps it, then removes', async () => {
    addCommute(parla, sol);
    swapCommute(commuteId(parla, sol));
    const [c] = await saved();
    expect(c.from.id).toBe(sol.id);
    expect(c.to.id).toBe(parla.id);
    expect(c.id).toBe(commuteId(sol, parla));
    removeCommute(c.id);
    expect(await saved()).toHaveLength(0);
  });
});
