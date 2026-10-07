import { formatTimestamp, TITLE_MAX_LENGTH, type Recording } from '@homescribe/shared';
import { Button, Input } from 'antd';
import { useState } from 'react';
import { useRenameRecordingMutation } from '../../api/api';
import { formatBytes, formatDate } from '../../i18n/format';
import { useLocale, useT } from '../../i18n/useT';
import styles from './RecordingPage.module.css';

export function RecordingHeader({ recording }: { recording: Recording }) {
  const t = useT();
  const locale = useLocale();
  const [draft, setDraft] = useState<string | null>(null);
  const [rename, { isLoading }] = useRenameRecordingMutation();

  const save = async () => {
    const title = draft?.trim();
    if (!title || title === recording.title) return setDraft(null);
    const result = await rename({ id: recording.id, title });
    if (!result.error) setDraft(null);
  };

  return (
    <header className={styles.header}>
      {draft === null ? (
        <div className={styles.titleRow}>
          <h1 className={styles.title}>{recording.title}</h1>
          <Button type="text" onClick={() => setDraft(recording.title)}>
            {t('recording.rename')}
          </Button>
        </div>
      ) : (
        <form
          className={styles.renameForm}
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <Input
            aria-label={t('recording.titleLabel')}
            value={draft}
            maxLength={TITLE_MAX_LENGTH}
            autoFocus
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => event.key === 'Escape' && setDraft(null)}
          />
          <div className={styles.actions}>
            <Button type="primary" htmlType="submit" loading={isLoading}>
              {t('recording.save')}
            </Button>
            <Button onClick={() => setDraft(null)}>{t('recording.cancel')}</Button>
          </div>
        </form>
      )}
      <p className={styles.meta}>
        {formatDate(recording.createdAt, locale)}
        {recording.durationSeconds !== null && ` · ${formatTimestamp(recording.durationSeconds)}`}
        {` · ${formatBytes(recording.sizeBytes, locale)}`}
      </p>
      {recording.sourceUrl ? (
        <p className={styles.filename}>
          <a href={recording.sourceUrl} target="_blank" rel="noopener noreferrer">
            {t('recording.source', { host: hostOf(recording.sourceUrl) })}
          </a>
        </p>
      ) : (
        <p className={styles.filename} title={recording.originalFilename}>
          {recording.originalFilename}
        </p>
      )}
    </header>
  );
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}
