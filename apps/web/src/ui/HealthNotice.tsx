import { Link } from 'react-router';
import { useGetHealthQuery } from '../api/api';
import { useT } from '../i18n/useT';
import styles from './HealthNotice.module.css';
import { healthProblems } from './health-problems';

/** Tells the user up front when processing cannot work, instead of on the first failed job. */
export function HealthNotice() {
  const t = useT();
  const { data } = useGetHealthQuery(undefined, { pollingInterval: 60_000 });
  const problems = healthProblems(data?.checks);
  if (problems.length === 0) return null;

  return (
    <aside className={styles.notice} role="status" aria-label={t('health.title')}>
      <ul className={styles.list}>
        {problems.map((key) => (
          <li key={key}>{t(key)}</li>
        ))}
      </ul>
      <Link to="/settings" className={styles.link}>
        {t('health.openSettings')}
      </Link>
    </aside>
  );
}
