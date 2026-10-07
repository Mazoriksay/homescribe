import { ConfigProvider } from 'antd';
import enUS from 'antd/locale/en_US';
import ruRU from 'antd/locale/ru_RU';
import { useEffect, useSyncExternalStore, type ReactNode } from 'react';
import { useAppSelector } from '../app/hooks';
import { antdTheme, palette, resolveTheme } from './theme';

const DARK_QUERY = '(prefers-color-scheme: dark)';

function subscribe(onChange: () => void) {
  const query = window.matchMedia(DARK_QUERY);
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
}

function useSystemPrefersDark(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(DARK_QUERY).matches,
    () => false,
  );
}

/** Applies the theme to <html data-theme> and themes Ant Design controls to match. */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const preference = useAppSelector((state) => state.prefs.theme);
  const locale = useAppSelector((state) => state.prefs.locale);
  const resolved = resolveTheme(preference, useSystemPrefersDark());
  const colors = palette[resolved];

  useEffect(() => {
    document.documentElement.dataset.theme = resolved;
    document.documentElement.lang = locale;
    for (const meta of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) {
      meta.content = colors.bg;
    }
  }, [resolved, locale, colors.bg]);

  return (
    <ConfigProvider locale={locale === 'ru' ? ruRU : enUS} theme={antdTheme(resolved)}>
      {children}
    </ConfigProvider>
  );
}
