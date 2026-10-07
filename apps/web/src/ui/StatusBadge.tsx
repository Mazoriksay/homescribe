import type { Job } from '@homescribe/shared';
import { useT } from '../i18n/useT';
import styles from './StatusBadge.module.css';

/** Job status as text plus a shape, so it never relies on colour alone. */
export function StatusBadge({ job }: { job: Job }) {
  const t = useT();
  const running = job.status !== 'done' && job.status !== 'failed' && job.status !== 'queued';
  const percent =
    job.status === 'converting' && job.progress !== null ? Math.round(job.progress * 100) : null;
  return (
    <span className={styles.badge} data-status={job.status}>
      <span className={styles.dot} data-running={running || undefined} aria-hidden="true" />
      {t(`status.${job.status}`)}
      {percent !== null && <span className={styles.percent}>{percent}%</span>}
    </span>
  );
}
