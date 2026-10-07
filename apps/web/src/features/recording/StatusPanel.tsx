import type { Recording } from '@homescribe/shared';
import { Button } from 'antd';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { useCreateJobMutation, useDeleteRecordingMutation } from '../../api/api';
import { errorMessageKey, useT } from '../../i18n/useT';
import { ProgressBar } from '../../ui/ProgressBar';
import { StatusBadge } from '../../ui/StatusBadge';
import styles from './RecordingPage.module.css';

export function StatusPanel({ recording }: { recording: Recording }) {
  const t = useT();
  const { job } = recording;
  const isFinal = job.status === 'done' || job.status === 'failed';
  // A failed summary keeps the transcript; retrying only needs the summary step.
  const summaryFailed = job.error?.code.startsWith('LLM_') ?? false;

  return (
    <section className={styles.status} aria-live="polite">
      <div className={styles.statusRow}>
        <StatusBadge job={job} />
        <div className={styles.actions}>
          {job.status === 'failed' && (
            <RetryButton recordingId={recording.id} summaryOnly={summaryFailed} />
          )}
          <DeleteButton recordingId={recording.id} disabled={!isFinal && job.status !== 'queued'} />
        </div>
      </div>
      {(job.status === 'downloading' ||
        job.status === 'converting' ||
        job.status === 'summarizing') && (
        <ProgressBar value={job.progress} label={t(`status.${job.status}`)} />
      )}
      {job.status === 'transcribing' && (
        <>
          <ProgressBar value={null} label={t('status.transcribing')} />
          <p className={styles.hint}>{t('recording.transcribingHint')}</p>
        </>
      )}
      {job.status === 'summarizing' && (
        <p className={styles.hint}>{t('recording.summarizingHint')}</p>
      )}
      {job.status === 'queued' && <p className={styles.hint}>{t('recording.queuedHint')}</p>}
      {job.status === 'downloading' && (
        <p className={styles.hint}>{t('recording.downloadingHint')}</p>
      )}
      {job.status === 'failed' && job.error && (
        <p className={styles.error} role="alert">
          {t(errorMessageKey(job.error.code))}
          <span className={styles.errorDetail}>{job.error.message}</span>
        </p>
      )}
    </section>
  );
}

function RetryButton({ recordingId, summaryOnly }: { recordingId: string; summaryOnly: boolean }) {
  const t = useT();
  const [createJob, { isLoading }] = useCreateJobMutation();
  return (
    <Button
      type="primary"
      loading={isLoading}
      onClick={() => void createJob({ recordingId, kind: summaryOnly ? 'summarize' : 'process' })}
    >
      {summaryOnly ? t('recording.regenerate') : t('recording.retry')}
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
