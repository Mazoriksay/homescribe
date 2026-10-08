import type { Job } from '@homescribe/shared';
import { useT } from '../i18n/useT';
import styles from './StatusBadge.module.css';

/** Job status as text plus a shape, so it never relies on colour alone. */
export function StatusBadge({ job }: { job: Job }) {
  const t = useT();
  const running = job.status !== 'done' && job.status !== 'failed' && job.status !== 'queued';
  const percent =
    (job.status === 'converting' || job.status === 'downloading') && job.progress !== null
      ? Math.round(job.progress * 100)
      : null;
  // Cancelled on purpose: not an error, so it reads as stopped, not failed.
  const cancelled = job.status === 'failed' && job.error?.code === 'CANCELLED';
  return (
    <span className={styles.badge} data-status={cancelled ? 'cancelled' : job.status}>
      <span className={styles.dot} data-running={running || undefined} aria-hidden="true" />
      {cancelled ? t('status.cancelled') : t(`status.${job.status}`)}
      {percent !== null && <span className={styles.percent}>{percent}%</span>}
    </span>
  );
}
