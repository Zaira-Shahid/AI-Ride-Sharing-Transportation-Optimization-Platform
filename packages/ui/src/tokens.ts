export const palette = {
  midnightNavy: '#0B1220',
  deepSlate: '#172033',
  cleanWhite: '#F8FAFC',
  electricCyan: '#22D3EE',
  emerald: '#10B981',
  amber: '#F59E0B',
  dangerRed: '#EF4444',
} as const;

/**
 * Electric cyan is 1.73:1 on the light background, far below the 4.5:1 text needs, so on light screens
 * cyan stays for graphics (route lines, pins, selection) and text and links use this darker teal
 * (5.36:1 on white). A derived shade for text only; the specification's palette above is unchanged.
 */
export const accentTextOnLight = '#0E7490';

export interface ThemeColors {
  background: string;
  surface: string;
  border: string;
  textPrimary: string;
  textSecondary: string;
  accent: string;
  /** Cyan-coloured text and links: readable on this theme's background (see accentTextOnLight). */
  accentText: string;
  /** The main button's fill and the label on it. */
  primary: string;
  onPrimary: string;
  success: string;
  warning: string;
  danger: string;
}

export const themes: { dark: ThemeColors; light: ThemeColors } = {
  dark: {
    background: palette.midnightNavy,
    surface: palette.deepSlate,
    border: 'rgba(248, 250, 252, 0.12)',
    textPrimary: palette.cleanWhite,
    textSecondary: 'rgba(248, 250, 252, 0.64)',
    accent: palette.electricCyan,
    accentText: palette.electricCyan,
    primary: palette.electricCyan,
    onPrimary: palette.midnightNavy,
    success: palette.emerald,
    warning: palette.amber,
    danger: palette.dangerRed,
  },
  light: {
    background: palette.cleanWhite,
    surface: palette.cleanWhite,
    border: 'rgba(11, 18, 32, 0.12)',
    textPrimary: palette.midnightNavy,
    textSecondary: 'rgba(11, 18, 32, 0.64)',
    accent: palette.electricCyan,
    accentText: accentTextOnLight,
    primary: palette.midnightNavy,
    onPrimary: palette.cleanWhite,
    success: palette.emerald,
    warning: palette.amber,
    danger: palette.dangerRed,
  },
};

export const spacing = {
  0: 0,
  1: 4,
  2: 8,
  3: 12,
  4: 16,
  5: 20,
  6: 24,
  8: 32,
  10: 40,
  12: 48,
} as const;

export const radius = {
  sm: 6,
  md: 10,
  lg: 16,
  xl: 24,
  full: 9999,
} as const;

export const fontSize = {
  xs: 12,
  sm: 14,
  base: 16,
  lg: 18,
  xl: 20,
  '2xl': 24,
  '3xl': 30,
  '4xl': 36,
} as const;

export const fontWeight = {
  regular: '400',
  medium: '500',
  semibold: '600',
  bold: '700',
} as const;

export const motion = {
  fast: 120,
  base: 200,
  slow: 320,
} as const;

/**
 * Inter, one family (SIL Open Font License), loaded by each app with expo-font. A custom font is picked
 * by family name per weight, so these names stand in for fontWeight (the Text wrapper in
 * @ridemesh/mobile-auth does the mapping).
 */
export const fontFamily = {
  regular: 'Inter_400Regular',
  medium: 'Inter_500Medium',
  semibold: 'Inter_600SemiBold',
  bold: 'Inter_700Bold',
} as const;

/** Soft navy-tinted shadow for cards (iOS and web read the shadow* keys, Android reads elevation). */
export const shadow = {
  card: {
    shadowColor: palette.midnightNavy,
    shadowOpacity: 0.08,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 4 },
    elevation: 2,
  },
} as const;

/** The surface every card shares: a hairline border, large corners and the soft shadow. */
export const cardSurface = {
  borderWidth: 1,
  borderRadius: radius.xl,
  ...shadow.card,
} as const;
