import { formatTimestamp, type Recording } from '@homescribe/shared';
import { Button } from 'antd';
import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import {
  errorCode,
  useCreateJobMutation,
  useDeleteRecordingMutation,
  useGetRecordingQuery,
} from '../../api/api';
import { formatBytes, formatDate } from '../../i18n/format';
import { errorMessageKey, useLocale, useT } from '../../i18n/useT';
import { ProgressBar } from '../../ui/ProgressBar';
import { StatusBadge } from '../../ui/StatusBadge';
import styles from './RecordingPage.module.css';
import { TranscriptView } from './TranscriptView';

export function RecordingPage() {
  const { id = '' } = useParams();
  const t = useT();
  const { data: recording, error, isLoading } = useGetRecordingQuery(id);

  return (
    <div className={styles.page}>
      <Link to="/" className={styles.back}>
        ← {t('recording.back')}
      </Link>
      {isLoading && <div className={styles.skeleton} aria-busy="true" />}
      {error && (
        <p className={styles.notice} role="alert">
          {errorCode(error) === 'NOT_FOUND' || errorCode(error) === 'VALIDATION_ERROR'
            ? t('recording.notFound')
            : t('recording.loadError')}
        </p>
      )}
      {recording && <RecordingDetails recording={recording} />}
    </div>
  );
}

function RecordingDetails({ recording }: { recording: Recording }) {
  const t = useT();
  const locale = useLocale();
  const { job } = recording;
  const isFinal = job.status === 'done' || job.status === 'failed';

  return (
    <>
      <header className={styles.header}>
        <h1 className={styles.title}>{recording.title}</h1>
        <p className={styles.meta}>
          {formatDate(recording.createdAt, locale)}
          {recording.durationSeconds !== null && ` · ${formatTimestamp(recording.durationSeconds)}`}
          {` · ${formatBytes(recording.sizeBytes, locale)}`}
        </p>
        <p className={styles.filename} title={recording.originalFilename}>
          {recording.originalFilename}
        </p>
      </header>

      <section className={styles.status} aria-live="polite">
        <div className={styles.statusRow}>
          <StatusBadge job={job} />
          <div className={styles.actions}>
            {job.status === 'failed' && <RetryButton recordingId={recording.id} />}
            <DeleteButton
              recordingId={recording.id}
              disabled={!isFinal && job.status !== 'queued'}
            />
          </div>
        </div>
        {job.status === 'converting' && (
          <ProgressBar value={job.progress} label={t('status.converting')} />
        )}
        {job.status === 'transcribing' && (
          <>
            <ProgressBar value={null} label={t('status.transcribing')} />
            <p className={styles.hint}>{t('recording.transcribingHint')}</p>
          </>
        )}
        {job.status === 'queued' && <p className={styles.hint}>{t('recording.queuedHint')}</p>}
        {job.status === 'failed' && job.error && (
          <p className={styles.error} role="alert">
            {t(errorMessageKey(job.error.code))}
            <span className={styles.errorDetail}>{job.error.message}</span>
          </p>
        )}
      </section>

      <TranscriptView recording={recording} />
    </>
  );
}

function RetryButton({ recordingId }: { recordingId: string }) {
  const t = useT();
  const [createJob, { isLoading }] = useCreateJobMutation();
  return (
    <Button
      type="primary"
      loading={isLoading}
      onClick={() => void createJob({ recordingId, kind: 'process' })}
    >
      {t('recording.retry')}
    </Button>
  );
}

/** Two taps instead of a modal: easy on a phone, hard to trigger by accident. */
function DeleteButton({ recordingId, disabled }: { recordingId: string; disabled: boolean }) {
  const t = useT();
  const navigate = useNavigate();
  const [armed, setArmed] = useState(false);
  const [deleteRecording, { isLoading }] = useDeleteRecordingMutation();

  useEffect(() => {
    if (!armed) return;
    const timer = setTimeout(() => setArmed(false), 4000);
    return () => clearTimeout(timer);
  }, [armed]);

  return (
    <Button
      danger
      type={armed ? 'primary' : 'default'}
      disabled={disabled}
      title={disabled ? t('recording.deleteBlocked') : undefined}
      loading={isLoading}
      onClick={async () => {
        if (!armed) return setArmed(true);
        const result = await deleteRecording(recordingId);
        if (!result.error) void navigate('/');
      }}
    >
      {armed ? t('recording.deleteConfirm') : t('recording.delete')}
    </Button>
  );
}
