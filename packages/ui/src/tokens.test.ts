import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { palette, radius, themes } from './tokens';

const css = readFileSync(join(__dirname, 'tokens.css'), 'utf8').toLowerCase();

const kebab = (name: string) => name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

describe('design tokens (spec section 41)', () => {
  it('uses the exact palette from the specification', () => {
    expect(palette).toEqual({
      midnightNavy: '#0B1220',
      deepSlate: '#172033',
      cleanWhite: '#F8FAFC',
      electricCyan: '#22D3EE',
      emerald: '#10B981',
      amber: '#F59E0B',
      dangerRed: '#EF4444',
    });
  });

  it('maps colours semantically in both themes', () => {
    for (const theme of Object.values(themes)) {
      expect(theme.success).toBe(palette.emerald);
      expect(theme.warning).toBe(palette.amber);
      expect(theme.danger).toBe(palette.dangerRed);
      expect(theme.accent).toBe(palette.electricCyan);
    }
    expect(themes.dark.background).toBe(palette.midnightNavy);
    expect(themes.light.background).toBe(palette.cleanWhite);
  });

  it('keeps tokens.css in sync with the TypeScript palette', () => {
    for (const [name, hex] of Object.entries(palette)) {
      expect(css).toContain(`--color-${kebab(name)}: ${hex.toLowerCase()};`);
    }
  });

  it('keeps tokens.css radii in sync with the TypeScript radii', () => {
    for (const key of ['sm', 'md', 'lg', 'xl'] as const) {
      expect(css).toContain(`--radius-${key}: ${radius[key]}px;`);
    }
  });
});
