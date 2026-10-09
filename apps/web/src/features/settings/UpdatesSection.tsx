import { Button } from 'antd';
import { useLazyCheckUpdatesQuery } from '../../api/api';
import { useT } from '../../i18n/useT';
import styles from './Settings.module.css';

/** "Check for updates": compares this build with GitHub (SPEC.md §7.9). */
export function UpdatesSection() {
  const t = useT();
  const [check, { data, isFetching, isError }] = useLazyCheckUpdatesQuery();

  const current = data
    ? [data.current.version, data.current.commit?.slice(0, 7)].filter(Boolean).join(' · ')
    : null;

  return (
    <section className={styles.section} aria-labelledby="settings-updates">
      <h2 id="settings-updates" className={styles.heading}>
        {t('settings.updates.title')}
      </h2>
      <div>
        <Button loading={isFetching} onClick={() => void check()}>
          {t('settings.updates.check')}
        </Button>
      </div>
      {!isFetching && data && (
        <div role="status" className={styles.form}>
          {current && <p className={styles.source}>{t('settings.updates.current', { current })}</p>}
          {data.updateAvailable === true && (
            <>
              <p>
                {data.behind !== null
                  ? t('settings.updates.behind', { count: data.behind })
                  : t('settings.updates.release', { version: data.latest?.ref ?? '' })}
              </p>
              <p className={styles.muted}>{t('settings.updates.how')}</p>
            </>
          )}
          {data.updateAvailable === false && <p>{t('settings.updates.upToDate')}</p>}
          {data.error && (
            <p className={styles.muted}>{t(`settings.updates.error.${data.error}`)}</p>
          )}
        </div>
      )}
      {!isFetching && isError && (
        <p className={styles.muted}>{t('settings.updates.error.unreachable')}</p>
      )}
    </section>
  );
}
