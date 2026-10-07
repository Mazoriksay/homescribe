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
    text: '#1d1b18',
    border: '#dfdad0',
    accent: '#a8481f',
  },
  dark: { bg: '#151412', raised: '#1d1c19', text: '#ece8e0', border: '#2e2c27', accent: '#e38c5c' },
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
      fontFamily: bodyFontStack,
      fontSize: 15,
      borderRadius: 8,
      // Phone first: 40–44 px controls (SPEC.md §11).
      controlHeight: 40,
      controlHeightLG: 44,
      boxShadow: 'none',
      boxShadowSecondary: 'none',
    },
    components: {
      Button: { primaryShadow: 'none', defaultShadow: 'none', dangerShadow: 'none' },
    },
  };
}
