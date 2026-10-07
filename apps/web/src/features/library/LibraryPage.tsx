import { formatTimestamp } from '@homescribe/shared';
import { Button, Input } from 'antd';
import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useListRecordingsQuery } from '../../api/api';
import { formatBytes, formatDate } from '../../i18n/format';
import { useLocale, useT } from '../../i18n/useT';
import { ProgressBar } from '../../ui/ProgressBar';
import { StatusBadge } from '../../ui/StatusBadge';
import styles from './LibraryPage.module.css';
import { SearchResults } from './SearchResults';
import { UploadZone } from './UploadZone';

const PAGE_SIZE = 20;

export function LibraryPage() {
  const t = useT();
  const locale = useLocale();
  const [params, setParams] = useSearchParams();
  const page = Math.max(1, Number(params.get('page')) || 1);
  const q = params.get('q')?.trim() ?? '';
  const [input, setInput] = useState(q);
  const { data, isLoading, isError, refetch } = useListRecordingsQuery(
    { page, pageSize: PAGE_SIZE },
    { skip: q !== '' },
  );
  const goTo = (next: number) =>
    setParams({ ...(q && { q }), ...(next > 1 && { page: String(next) }) });

  // The URL holds the query, so results survive reloads and the back button.
  useEffect(() => {
    const next = input.trim();
    if (next === q) return;
    const timer = setTimeout(() => setParams(next ? { q: next } : {}, { replace: true }), 300);
    return () => clearTimeout(timer);
  }, [input, q, setParams]);

  return (
    <div className={styles.page}>
      <h1 className="page-title">{t('library.title')}</h1>
      <Input
        type="search"
        size="large"
        allowClear
        enterKeyHint="search"
        aria-label={t('search.label')}
        placeholder={t('search.placeholder')}
        value={input}
        onChange={(event) => setInput(event.target.value.slice(0, 200))}
      />

      {q ? <SearchResults q={q} page={page} onPage={goTo} /> : <UploadZone />}

      {!q && isLoading && (
        <ul className={styles.list} aria-busy="true">
          {[0, 1, 2].map((i) => (
            <li key={i} className={styles.skeleton} />
          ))}
        </ul>
      )}

      {!q && isError && (
        <div className={styles.state} role="alert">
          <p>{t('library.error')}</p>
          <Button onClick={() => void refetch()}>{t('library.retry')}</Button>
        </div>
      )}

      {!q && data && data.pagination.totalItems === 0 && (
        <div className={styles.state}>
          <h2 className={styles.stateTitle}>{t('library.empty.title')}</h2>
        </div>
      )}

      {!q && data && data.data.length > 0 && (
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
                  {(recording.job.status === 'converting' ||
                    recording.job.status === 'downloading') && (
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

      {!q && data && data.pagination.totalPages > 1 && (
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
