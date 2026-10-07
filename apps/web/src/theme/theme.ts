export type ThemePreference = 'auto' | 'light' | 'dark';
export type ResolvedTheme = 'light' | 'dark';

export function resolveTheme(
  preference: ThemePreference,
  systemPrefersDark: boolean,
): ResolvedTheme {
  if (preference === 'auto') return systemPrefersDark ? 'dark' : 'light';
  return preference;
}

/**
 * Design tokens shared by CSS (as custom properties in global.css) and the
 * Ant Design theme. One neutral family (cool grey) plus one accent (teal).
 */
export const palette = {
  light: {
    accent: '#0f766e',
    bg: '#f7f8f8',
    surface: '#ffffff',
    text: '#161a1a',
    textMuted: '#5b6464',
    border: '#dfe3e3',
    danger: '#b42318',
  },
  dark: {
    accent: '#2bb3a3',
    bg: '#111313',
    surface: '#1a1d1d',
    text: '#e9eded',
    textMuted: '#9aa5a5',
    border: '#2c3232',
    danger: '#f97066',
  },
} as const;

export const systemFontStack =
  'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, "Noto Sans", sans-serif';
