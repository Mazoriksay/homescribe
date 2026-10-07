import { NavLink, Outlet, Link } from 'react-router';
import { useServerEvents } from '../api/server-events';
import { useEmbedSignals } from '../app/embedding';
import { useT } from '../i18n/useT';
import { HealthNotice } from './HealthNotice';
import styles from './Layout.module.css';

export function Layout() {
  useServerEvents();
  useEmbedSignals();
  const t = useT();

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
        <nav className={styles.nav}>
          <NavLink to="/settings" className={styles.navLink}>
            <svg viewBox="0 0 24 24" aria-hidden="true" className={styles.navIcon}>
              <path d="M4 7h10M18 7h2M4 17h2M10 17h10" />
              <circle cx="16" cy="7" r="2" />
              <circle cx="8" cy="17" r="2" />
            </svg>
            {t('nav.settings')}
          </NavLink>
        </nav>
      </header>
      <main className={styles.main}>
        <HealthNotice />
        <Outlet />
      </main>
    </div>
  );
}
