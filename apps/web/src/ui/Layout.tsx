import { Segmented } from 'antd';
import { Link, Outlet } from 'react-router';
import { useServerEvents } from '../api/server-events';
import { useAppDispatch, useAppSelector } from '../app/hooks';
import { setLocale, setTheme } from '../app/prefs';
import { useT } from '../i18n/useT';
import type { Locale } from '../i18n/format';
import type { ThemePreference } from '../theme/theme';
import styles from './Layout.module.css';

export function Layout() {
  useServerEvents();
  const t = useT();
  const dispatch = useAppDispatch();
  const { locale, theme } = useAppSelector((state) => state.prefs);

  return (
    <div className={styles.shell}>
      <header className={styles.header}>
        <Link to="/" className={styles.brand}>
          <svg className={styles.logo} viewBox="0 0 32 32" aria-hidden="true">
            <rect width="32" height="32" rx="8" />
            <g>
              <rect x="7" y="13" width="3" height="6" rx="1.5" />
              <rect x="12" y="9" width="3" height="14" rx="1.5" />
              <rect x="17" y="11" width="3" height="10" rx="1.5" />
              <rect x="22" y="14" width="3" height="4" rx="1.5" />
            </g>
          </svg>
          {t('app.name')}
        </Link>
        <div className={styles.settings}>
          <Segmented<Locale>
            aria-label={t('settings.language')}
            value={locale}
            onChange={(value) => dispatch(setLocale(value))}
            options={[
              { label: 'EN', value: 'en' },
              { label: 'RU', value: 'ru' },
            ]}
          />
          <Segmented<ThemePreference>
            aria-label={t('settings.theme')}
            value={theme}
            onChange={(value) => dispatch(setTheme(value))}
            options={[
              { label: t('theme.auto'), value: 'auto' },
              { label: t('theme.light'), value: 'light' },
              { label: t('theme.dark'), value: 'dark' },
            ]}
          />
        </div>
      </header>
      <main className={styles.main}>
        <Outlet />
      </main>
    </div>
  );
}
