// MadridGo design tokens.
// Layout ideas follow the clarity of Swiss public-transport apps (header with From/To card,
// white cards on light grey, large tabular times), but colours and identity are MadridGo's own.

export type Scheme = 'light' | 'dark';

const light = {
  brand: '#0B3A82', // MadridGo navy: links, icons and selected states on white
  brandTint: '#E8EEF8', // selected or pressed rows
  brandDark: '#072A5E', // text on amber (badges, the amber button); the same in both schemes
  accent: '#FFB31A', // logo sun; highlights only, never for text on white

  // Navy bars: screen headers, the Plan view switch, touch-timetable tiles.
  header: '#0B3A82',
  headerDark: '#072A5E',
  // Filled buttons and chosen chips.
  primary: '#0B3A82',
  onPrimary: '#FFFFFF',

  bg: '#F3F4F6',
  surface: '#FFFFFF',
  pressed: '#F7F8FA', // pressed or hovered row
  text: '#16181D',
  textMuted: '#5B6270',
  textFaint: '#8A909C',
  border: '#E1E4EA',
  divider: '#ECEEF2',
  backdrop: 'rgba(8, 24, 54, 0.45)',
  toast: 'rgba(22,24,29,0.88)', // dark message box over the map

  // Reliability labels (see docs/RELIABILITY_STRATEGY.md). Never colour alone: always with text.
  live: '#0E7C3A',
  liveBg: '#E4F4EA',
  scheduled: '#5B6270',
  scheduledBg: '#EEF0F3',
  delay: '#C4161C',
  delayBg: '#FDECEC',
  warning: '#8A5300',
  warningBg: '#FFF4DB',

  onBrand: '#FFFFFF',
  onBrandMuted: '#C9D6EE',
};

export type Palette = typeof light;

// Dark mode: dark grey surfaces (not pure black), a lighter blue for links and icons so they
// stay readable, and lighter label colours with dark backgrounds. Line colours from GTFS are
// never changed. Contrast of text on surface and bg is at least 4.5:1.
const dark: Palette = {
  brand: '#8CB2F2',
  brandTint: '#1D2A42',
  brandDark: '#072A5E',
  accent: '#FFB31A',

  header: '#0D2C5E',
  headerDark: '#081D40',
  primary: '#8CB2F2',
  onPrimary: '#0A1A36',

  bg: '#0F1217',
  surface: '#191D24',
  pressed: '#232831',
  text: '#E9ECF1',
  textMuted: '#A9B0BC',
  textFaint: '#7F8694',
  border: '#2C323C',
  divider: '#252A33',
  backdrop: 'rgba(0, 0, 0, 0.6)',
  toast: 'rgba(40,45,54,0.94)',

  live: '#5DD08A',
  liveBg: '#14301F',
  scheduled: '#A9B0BC',
  scheduledBg: '#262B34',
  delay: '#FF7A7A',
  delayBg: '#3A1A1C',
  warning: '#F5BB4D',
  warningBg: '#33270F',

  onBrand: '#FFFFFF',
  onBrandMuted: '#C9D6EE',
};

export const palettes: Record<Scheme, Palette> = { light, dark };

let scheme: Scheme = 'light';
let generation = 0;

/** The scheme the app is drawn in now. */
export function currentScheme(): Scheme {
  return scheme;
}

/**
 * Switches the palette. Called by state/settings.ts only; it also re-mounts the screens so
 * every style is read again (see app/_layout.tsx).
 */
export function applyScheme(next: Scheme) {
  if (next === scheme) return;
  scheme = next;
  generation += 1;
}

/**
 * The colours of the current scheme. Each field is read when a component renders, so inline
 * uses (`color={colors.brand}`) follow the scheme; style sheets use themed() below.
 */
export const colors = {} as Readonly<Palette>;
for (const key of Object.keys(light) as (keyof Palette)[]) {
  Object.defineProperty(colors, key, { enumerable: true, get: () => palettes[scheme][key] });
}

/**
 * A value built from colours (usually a StyleSheet) that is rebuilt for the current scheme:
 * `const styles = themed(() => StyleSheet.create({ ... }))`. Built lazily, once per scheme.
 */
export function themed<T extends object>(make: () => T): T {
  const cache = new Map<number, T>();
  const current = (): T => {
    let v = cache.get(generation);
    if (!v) {
      cache.clear();
      v = make();
      cache.set(generation, v);
    }
    return v;
  };
  return new Proxy({} as T, {
    get: (_t, key) => Reflect.get(current(), key),
    has: (_t, key) => Reflect.has(current(), key),
    ownKeys: () => Reflect.ownKeys(current()),
    getOwnPropertyDescriptor: (_t, key) => {
      const d = Reflect.getOwnPropertyDescriptor(current(), key);
      return d ? { ...d, configurable: true } : undefined;
    },
  });
}

// Fallback line colours by mode when a feed has none.
export const modeColors: Record<string, { bg: string; fg: string }> = {
  rail: { bg: '#D52B1E', fg: '#FFFFFF' },
  metro: { bg: '#1E4DA1', fg: '#FFFFFF' },
  light_rail: { bg: '#3A7DDA', fg: '#FFFFFF' },
  bus: { bg: '#2D7D46', fg: '#FFFFFF' },
  walk: { bg: '#8A909C', fg: '#FFFFFF' },
};

export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 } as const;
export const radius = { sm: 6, md: 10, lg: 14, pill: 999 } as const;

export const type = {
  // Times use tabular figures so columns line up.
  timeXL: { fontSize: 22, fontWeight: '700' as const, fontVariant: ['tabular-nums' as const] },
  timeL: { fontSize: 18, fontWeight: '700' as const, fontVariant: ['tabular-nums' as const] },
  time: { fontSize: 16, fontWeight: '600' as const, fontVariant: ['tabular-nums' as const] },
  title: { fontSize: 24, fontWeight: '700' as const },
  heading: { fontSize: 17, fontWeight: '700' as const },
  body: { fontSize: 16, fontWeight: '400' as const },
  bodyStrong: { fontSize: 16, fontWeight: '600' as const },
  small: { fontSize: 13, fontWeight: '400' as const },
  smallStrong: { fontSize: 13, fontWeight: '600' as const },
  label: {
    fontSize: 12,
    fontWeight: '700' as const,
    letterSpacing: 0.6,
    textTransform: 'uppercase' as const,
  },
};

// Content width cap so the website reads well on desktop.
export const MAX_CONTENT_WIDTH = 760;
// Website (desktop layout) width: top navigation, planner band and split list/detail views.
export const WIDE_MAX_WIDTH = 1200;
