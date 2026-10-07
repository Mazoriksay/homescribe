import { formatTimestamp } from '@homescribe/shared';
import { Button } from 'antd';
import { Link } from 'react-router';
import { useSearchQuery } from '../../api/api';
import { useT } from '../../i18n/useT';
import { StatusBadge } from '../../ui/StatusBadge';
import styles from './LibraryPage.module.css';

export function SearchResults({
  q,
  page,
  onPage,
}: {
  q: string;
  page: number;
  onPage: (page: number) => void;
}) {
  const t = useT();
  const { data, isFetching, isError, refetch } = useSearchQuery({ q, page });

  if (isError) {
    return (
      <div className={styles.state} role="alert">
        <p>{t('search.error')}</p>
        <Button onClick={() => void refetch()}>{t('library.retry')}</Button>
      </div>
    );
  }
  if (!data) return <ul className={styles.list} aria-busy="true" />;

  if (data.data.length === 0) {
    return (
      <div className={styles.state} role="status">
        <p className={styles.muted}>{t('search.none', { q })}</p>
      </div>
    );
  }

  return (
    <>
      <p className={styles.count} role="status" aria-busy={isFetching}>
        {t('search.results', { count: data.pagination.totalItems })}
      </p>
      <ul className={styles.list}>
        {/* `t` rounded up to a tenth, so it still falls inside the matching segment. */}
        {data.data.map(({ recording, snippet, segment }) => (
          <li key={recording.id}>
            <Link
              to={`/recordings/${recording.id}${segment ? `?t=${Math.ceil(segment.start * 10) / 10}` : ''}`}
              className={styles.row}
            >
              <div className={styles.rowMain}>
                <span className={styles.rowTitle}>{recording.title}</span>
                <span className={styles.snippet}>
                  {snippet.map((part, i) =>
                    part.match ? (
                      <mark key={i}>{part.text}</mark>
                    ) : (
                      <span key={i}>{part.text}</span>
                    ),
                  )}
                </span>
                {segment && (
                  <span className={styles.meta}>
                    {t('search.at', { time: formatTimestamp(segment.start) })}
                  </span>
                )}
              </div>
              <StatusBadge job={recording.job} />
            </Link>
          </li>
        ))}
      </ul>
      {data.pagination.totalPages > 1 && (
        <nav className={styles.pager}>
          <Button disabled={page <= 1} onClick={() => onPage(page - 1)}>
            {t('library.newer')}
          </Button>
          <span className={styles.muted}>
            {t('library.page', { page, pages: data.pagination.totalPages })}
          </span>
          <Button disabled={page >= data.pagination.totalPages} onClick={() => onPage(page + 1)}>
            {t('library.older')}
          </Button>
        </nav>
      )}
    </>
  );
}
