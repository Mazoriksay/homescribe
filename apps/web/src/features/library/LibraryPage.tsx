import { formatTimestamp } from '@homescribe/shared';
import { Button } from 'antd';
import { Link, useSearchParams } from 'react-router';
import { useListRecordingsQuery } from '../../api/api';
import { formatBytes, formatDate } from '../../i18n/format';
import { useLocale, useT } from '../../i18n/useT';
import { ProgressBar } from '../../ui/ProgressBar';
import { StatusBadge } from '../../ui/StatusBadge';
import styles from './LibraryPage.module.css';
import { UploadZone } from './UploadZone';

const PAGE_SIZE = 20;

export function LibraryPage() {
  const t = useT();
  const locale = useLocale();
  const [params, setParams] = useSearchParams();
  const page = Math.max(1, Number(params.get('page')) || 1);
  const { data, isLoading, isError, refetch } = useListRecordingsQuery({
    page,
    pageSize: PAGE_SIZE,
  });
  const goTo = (next: number) => setParams(next === 1 ? {} : { page: String(next) });

  return (
    <div className={styles.page}>
      <h1 className={styles.title}>{t('library.title')}</h1>
      <UploadZone />

      {isLoading && (
        <ul className={styles.list} aria-busy="true">
          {[0, 1, 2].map((i) => (
            <li key={i} className={styles.skeleton} />
          ))}
        </ul>
      )}

      {isError && (
        <div className={styles.state} role="alert">
          <p>{t('library.error')}</p>
          <Button onClick={() => void refetch()}>{t('library.retry')}</Button>
        </div>
      )}

      {data && data.pagination.totalItems === 0 && (
        <div className={styles.state}>
          <h2 className={styles.stateTitle}>{t('library.empty.title')}</h2>
          <p className={styles.muted}>{t('library.empty.body')}</p>
        </div>
      )}

      {data && data.data.length > 0 && (
        <>
          <p className={styles.count}>
            {t('library.count', { count: data.pagination.totalItems })}
          </p>
          <ul className={styles.list}>
            {data.data.map((recording) => (
              <li key={recording.id}>
                <Link to={`/recordings/${recording.id}`} className={styles.row}>
                  <div className={styles.rowMain}>
                    <span className={styles.rowTitle}>{recording.title}</span>
                    <span className={styles.meta}>
                      {formatDate(recording.createdAt, locale)}
                      {recording.durationSeconds !== null &&
                        ` · ${formatTimestamp(recording.durationSeconds)}`}
                      {` · ${formatBytes(recording.sizeBytes, locale)}`}
                    </span>
                  </div>
                  <StatusBadge job={recording.job} />
                  {recording.job.status === 'converting' && (
                    <div className={styles.rowProgress}>
                      <ProgressBar value={recording.job.progress} label={recording.title} />
                    </div>
                  )}
                </Link>
              </li>
            ))}
          </ul>
        </>
      )}

      {data && data.pagination.totalPages > 1 && (
        <nav className={styles.pager}>
          <Button disabled={page <= 1} onClick={() => goTo(page - 1)}>
            {t('library.newer')}
          </Button>
          <span className={styles.muted}>
            {t('library.page', { page, pages: data.pagination.totalPages })}
          </span>
          <Button disabled={page >= data.pagination.totalPages} onClick={() => goTo(page + 1)}>
            {t('library.older')}
          </Button>
        </nav>
      )}
    </div>
  );
}
