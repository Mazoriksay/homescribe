import { theme, type ThemeConfig } from 'antd';

export type ThemePreference = 'auto' | 'light' | 'dark';
export type ResolvedTheme = 'light' | 'dark';

export function resolveTheme(
  preference: ThemePreference,
  systemPrefersDark: boolean,
): ResolvedTheme {
  if (preference === 'auto') return systemPrefersDark ? 'dark' : 'light';
  return preference;
}

/** Mirrors the custom properties in global.css (Home Hub design system); keep both in sync. */
export const palette = {
  light: {
    bg: '#f4f2ed',
    raised: '#fbfaf7',
    hover: '#ebe8e0',
    text: '#1d1b18',
    faint: '#7c756a',
    border: '#dfdad0',
    accent: '#a8481f',
    accentSoft: '#f1e0d5',
  },
  dark: {
    bg: '#151412',
    raised: '#1d1c19',
    hover: '#262420',
    text: '#ece8e0',
    faint: '#8a8378',
    border: '#2e2c27',
    accent: '#e38c5c',
    accentSoft: '#3a251a',
  },
} as const;

export const bodyFontStack =
  "'Segoe UI Variable Text', 'Segoe UI', system-ui, -apple-system, Roboto, sans-serif";

export function antdTheme(resolved: ResolvedTheme): ThemeConfig {
  const colors = palette[resolved];
  return {
    algorithm: resolved === 'dark' ? theme.darkAlgorithm : theme.defaultAlgorithm,
    token: {
      colorPrimary: colors.accent,
      colorLink: colors.accent,
      colorBgBase: colors.bg,
      colorBgContainer: colors.raised,
      colorBgElevated: colors.raised,
      colorTextBase: colors.text,
      colorBorder: colors.border,
      colorBorderSecondary: colors.border,
      // Ant Design's default placeholder is far below readable contrast on these grounds.
      colorTextPlaceholder: colors.faint,
      fontFamily: bodyFontStack,
      fontSize: 15,
      borderRadius: 8,
      // Phone first: tap targets of at least 44 px (SPEC.md §11).
      controlHeight: 44,
      controlHeightLG: 48,
      boxShadow: 'none',
      boxShadowSecondary: 'none',
    },
    components: {
      Button: { primaryShadow: 'none', defaultShadow: 'none', dangerShadow: 'none' },
      // Segment items are the control height minus the track padding.
      // The chosen segment: its own fill plus the accent text, readable in both themes.
      Segmented: {
        controlHeight: 48,
        trackBg: colors.hover,
        itemSelectedBg: resolved === 'dark' ? colors.accentSoft : colors.raised,
        itemSelectedColor: colors.accent,
      },
    },
  };
}
