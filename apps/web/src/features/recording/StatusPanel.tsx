import type { Recording } from '@homescribe/shared';
import { Button } from 'antd';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import {
  useGetAiSettingsQuery,
  useCancelJobMutation,
  useCreateJobMutation,
  useDeleteRecordingMutation,
} from '../../api/api';
import { errorMessageKey, useT } from '../../i18n/useT';
import { ProgressBar } from '../../ui/ProgressBar';
import { StatusBadge } from '../../ui/StatusBadge';
import { cleanToolOutput } from './recording-text';
import styles from './RecordingPage.module.css';

export function StatusPanel({ recording }: { recording: Recording }) {
  const t = useT();
  const { data: settings } = useGetAiSettingsQuery();
  // A failed summary keeps the transcript; retrying only needs the summary step.
  const summaryFailed = recording.job.error?.code.startsWith('LLM_') ?? false;
  // Summaries turned off since: the transcript is all that was asked for.
  const job =
    summaryFailed && settings?.llm.mode === 'off'
      ? { ...recording.job, status: 'done' as const, error: null }
      : recording.job;
  const isFinal = job.status === 'done' || job.status === 'failed';

  return (
    <section className={styles.status} aria-live="polite">
      <div className={styles.statusRow}>
        <StatusBadge job={job} />
        <div className={styles.actions}>
          {job.status === 'failed' && (
            <RetryButton recordingId={recording.id} summaryOnly={summaryFailed} />
          )}
          {!isFinal && <CancelButton recordingId={recording.id} jobId={job.id} />}
          <DeleteButton recordingId={recording.id} disabled={!isFinal && job.status !== 'queued'} />
        </div>
      </div>
      {(job.status === 'downloading' ||
        job.status === 'converting' ||
        job.status === 'transcribing' ||
        job.status === 'summarizing') && (
        <ProgressBar value={job.progress} label={t(`status.${job.status}`)} />
      )}
      {job.status === 'failed' && job.error && (
        <div className={styles.error} role="alert">
          <p>{t(errorMessageKey(job.error.code))}</p>
          <details className={styles.errorDetail}>
            <summary>{t('recording.errorDetails')}</summary>
            <pre>{cleanToolOutput(job.error.message)}</pre>
          </details>
        </div>
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
function useArmed() {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const timer = setTimeout(() => setArmed(false), 4000);
    return () => clearTimeout(timer);
  }, [armed]);
  return [armed, setArmed] as const;
}

function CancelButton({ recordingId, jobId }: { recordingId: string; jobId: string }) {
  const t = useT();
  const [armed, setArmed] = useArmed();
  const [cancelJob, { isLoading }] = useCancelJobMutation();
  return (
    <button
      type="button"
      className="link-action"
      data-armed={armed || undefined}
      disabled={isLoading}
      onClick={() => {
        if (!armed) return setArmed(true);
        setArmed(false);
        void cancelJob({ recordingId, jobId });
      }}
    >
      {armed ? t('recording.cancelJobConfirm') : t('recording.cancelJob')}
    </button>
  );
}

function DeleteButton({ recordingId, disabled }: { recordingId: string; disabled: boolean }) {
  const t = useT();
  const navigate = useNavigate();
  const [armed, setArmed] = useArmed();
  const [deleteRecording, { isLoading }] = useDeleteRecordingMutation();

  return (
    <button
      type="button"
      className="link-action"
      data-armed={armed || undefined}
      disabled={disabled || isLoading}
      title={disabled ? t('recording.deleteBlocked') : undefined}
      onClick={async () => {
        if (!armed) return setArmed(true);
        const result = await deleteRecording(recordingId);
        if (!result.error) void navigate('/');
      }}
    >
      {armed ? t('recording.deleteConfirm') : t('recording.delete')}
    </button>
  );
}
