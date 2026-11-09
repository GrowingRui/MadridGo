// MadridGo design tokens.
// Layout ideas follow the clarity of Swiss public-transport apps (header with From/To card,
// white cards on light grey, large tabular times), but colours and identity are MadridGo's own.

export const colors = {
  brand: '#0B3A82', // MadridGo navy (logo background)
  brandDark: '#072A5E',
  brandTint: '#E8EEF8',
  accent: '#FFB31A', // logo sun; highlights only, never for text on white

  bg: '#F3F4F6',
  surface: '#FFFFFF',
  text: '#16181D',
  textMuted: '#5B6270',
  textFaint: '#8A909C',
  border: '#E1E4EA',
  divider: '#ECEEF2',

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
} as const;

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
