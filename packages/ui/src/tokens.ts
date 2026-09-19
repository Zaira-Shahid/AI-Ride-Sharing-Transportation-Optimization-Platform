export const palette = {
  midnightNavy: '#0B1220',
  deepSlate: '#172033',
  cleanWhite: '#F8FAFC',
  electricCyan: '#22D3EE',
  emerald: '#10B981',
  amber: '#F59E0B',
  dangerRed: '#EF4444',
} as const;

export interface ThemeColors {
  background: string;
  surface: string;
  border: string;
  textPrimary: string;
  textSecondary: string;
  accent: string;
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
