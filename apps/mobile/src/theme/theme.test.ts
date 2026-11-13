import AsyncStorage from '@react-native-async-storage/async-storage';
import { StyleSheet } from 'react-native';

import { resetSettingsForTests, setAppearance, setStepFree } from '../state/settings';
import { applyScheme, colors, currentScheme, type Palette, palettes, themed } from './index';

afterEach(() => resetSettingsForTests());

describe('colors and themed()', () => {
  it('follow the current scheme', () => {
    const styles = themed(() => StyleSheet.create({ text: { color: colors.text } }));
    expect(colors.bg).toBe(palettes.light.bg);
    expect(styles.text.color).toBe(palettes.light.text);

    applyScheme('dark');
    expect(currentScheme()).toBe('dark');
    expect(colors.bg).toBe(palettes.dark.bg);
    expect(styles.text.color).toBe(palettes.dark.text);
    expect(Object.keys(styles)).toEqual(['text']);
  });

  it('build a style sheet once per scheme', () => {
    const make = jest.fn(() => ({ a: { color: colors.brand } }));
    const styles = themed(make);
    void styles.a;
    void styles.a;
    expect(make).toHaveBeenCalledTimes(1);
    applyScheme('dark');
    void styles.a;
    expect(make).toHaveBeenCalledTimes(2);
  });
});

describe('settings', () => {
  it('start light, switch the scheme and remember the choice on this device', async () => {
    expect(currentScheme()).toBe('light');
    setAppearance('dark');
    expect(currentScheme()).toBe('dark');
    const stored = JSON.parse((await AsyncStorage.getItem('madridgo.settings.v1')) ?? '{}');
    expect(stored).toEqual({ appearance: 'dark', stepFree: false });
    setAppearance('light');
    expect(currentScheme()).toBe('light');
  });

  it('remembers "Show step-free travel" with the appearance', async () => {
    setStepFree(true);
    const stored = JSON.parse((await AsyncStorage.getItem('madridgo.settings.v1')) ?? '{}');
    expect(stored).toEqual({ appearance: 'light', stepFree: true });
    setStepFree(false);
  });
});

// WCAG contrast ratio of two #RRGGBB colours.
function contrast(a: string, b: string): number {
  const lum = (hex: string) => {
    const n = parseInt(hex.slice(1, 7), 16);
    const ch = (v: number) => {
      const c = v / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * ch((n >> 16) & 255) + 0.7152 * ch((n >> 8) & 255) + 0.0722 * ch(n & 255);
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

describe.each(['light', 'dark'] as const)('%s palette contrast', (scheme) => {
  const p: Palette = palettes[scheme];
  it.each([
    ['text', 'surface'],
    ['text', 'bg'],
    ['textMuted', 'surface'],
    ['textMuted', 'bg'],
    ['brand', 'surface'],
    ['onPrimary', 'primary'],
    ['onBrand', 'header'],
    ['live', 'liveBg'],
    ['scheduled', 'scheduledBg'],
    ['delay', 'delayBg'],
    ['warning', 'warningBg'],
    ['brandDark', 'accent'],
  ] as [keyof Palette, keyof Palette][])('%s on %s is at least 4.5:1', (fg, bg) => {
    expect(contrast(p[fg], p[bg])).toBeGreaterThanOrEqual(4.5);
  });
});
