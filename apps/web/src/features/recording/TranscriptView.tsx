import { formatTimestamp, type Recording } from '@homescribe/shared';
import { Button } from 'antd';
import { useState } from 'react';
import { useGetTranscriptQuery } from '../../api/api';
import { useT } from '../../i18n/useT';
import styles from './TranscriptView.module.css';

export function TranscriptView({ recording }: { recording: Recording }) {
  const t = useT();
  // Always ask: a retry keeps the previous transcript readable. Until one exists the
  // server answers 409 TRANSCRIPT_NOT_READY; the SSE 'done' event triggers a refetch.
  const { data: transcript } = useGetTranscriptQuery(recording.id);
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    if (!transcript) return;
    try {
      await navigator.clipboard.writeText(transcript.text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard is unavailable on plain-HTTP origins; the text stays selectable.
    }
  };

  return (
    <section className={styles.section} aria-labelledby="transcript-heading">
      <div className={styles.head}>
        <h2 id="transcript-heading" className={styles.heading}>
          {t('recording.transcript')}
        </h2>
        {transcript && transcript.text && typeof navigator.clipboard !== 'undefined' && (
          <Button onClick={() => void copy()}>
            {copied ? t('recording.copied') : t('recording.copy')}
          </Button>
        )}
      </div>

      {!transcript && <p className={styles.placeholder}>{t('recording.transcriptPending')}</p>}

      {transcript && transcript.segments.length === 0 && (
        <p className={styles.placeholder}>
          {transcript.text ? transcript.text : t('recording.noSpeech')}
        </p>
      )}

      {transcript && transcript.segments.length > 0 && (
        <>
          {transcript.language && (
            <p className={styles.language}>
              {t('recording.language', { language: transcript.language })}
            </p>
          )}
          <ol className={styles.segments} lang={transcript.language ?? undefined}>
            {transcript.segments.map((segment) => (
              <li key={segment.index} className={styles.segment}>
                <time className={styles.time} dateTime={`PT${segment.start.toFixed(1)}S`}>
                  {formatTimestamp(segment.start)}
                </time>
                <p className={styles.text}>{segment.text}</p>
              </li>
            ))}
          </ol>
        </>
      )}
    </section>
  );
}
