import { NavLink, Outlet, Link } from 'react-router';
import { useServerEvents } from '../api/server-events';
import { useEmbedSignals } from '../app/embedding';
import type { MessageKey } from '../i18n/en';
import { useT } from '../i18n/useT';
import { HealthNotice } from './HealthNotice';
import styles from './Layout.module.css';

const NAV: { to: string; label: MessageKey; icon: 'recordings' | 'settings'; end?: boolean }[] = [
  { to: '/', label: 'nav.library', icon: 'recordings', end: true },
  { to: '/settings', label: 'nav.settings', icon: 'settings' },
];

function Icon({ name }: { name: 'recordings' | 'settings' }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className={styles.icon}>
      {name === 'recordings' ? (
        <path d="M5 10v4M9 6v12M13 8v8M17 11v2M20 9v6" />
      ) : (
        <>
          <path d="M4 7h10M18 7h2M4 17h2M10 17h10" />
          <circle cx="16" cy="7" r="2" />
          <circle cx="8" cy="17" r="2" />
        </>
      )}
    </svg>
  );
}

/**
 * App chrome (SPEC.md §11): a side rail on desktop, a top bar and a bottom tab
 * bar on phones (switched in CSS), and only a slim row of links when framed by
 * another app, which brings its own chrome.
 */
export function Layout() {
  useServerEvents();
  useEmbedSignals();
  const t = useT();

  const links = (className: string | undefined) =>
    NAV.map((item) => (
      <NavLink key={item.to} to={item.to} end={item.end} className={className}>
        <Icon name={item.icon} />
        <span>{t(item.label)}</span>
      </NavLink>
    ));

  return (
    <div className={styles.shell}>
      <aside className={styles.rail}>
        <Link to="/" className={styles.wordmark}>
          {t('app.name')}
        </Link>
        <nav className={styles.railNav} aria-label={t('app.name')}>
          {links(styles.navItem)}
        </nav>
      </aside>

      <header className={styles.topBar}>
        <Link to="/" className={styles.wordmark}>
          {t('app.name')}
        </Link>
      </header>

      <main className={styles.main}>
        <nav className={styles.framedNav} aria-label={t('app.name')}>
          {links(styles.framedLink)}
        </nav>
        <HealthNotice />
        <Outlet />
      </main>

      <nav className={styles.tabBar} aria-label={t('app.name')}>
        {links(styles.tab)}
      </nav>
    </div>
  );
}
