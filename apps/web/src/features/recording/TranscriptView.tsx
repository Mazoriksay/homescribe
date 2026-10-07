import { formatTimestamp, type Recording, type Segment } from '@homescribe/shared';
import { useEffect, useRef, useState } from 'react';
import { useGetTranscriptQuery } from '../../api/api';
import { useT } from '../../i18n/useT';
import styles from './TranscriptView.module.css';

/** Index of the segment playing at `time`: the last one that started. */
export function activeSegmentIndex(segments: readonly Segment[], time: number): number {
  let low = 0;
  let high = segments.length - 1;
  let found = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (segments[mid]!.start <= time + 0.05) {
      found = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return found;
}

interface Props {
  recording: Recording;
  currentTime: number;
  /** Scroll to the segment at this time once the transcript is shown (search results). */
  focusTime: number | null;
  onSeek: (seconds: number) => void;
}

export function TranscriptView({ recording, currentTime, focusTime, onSeek }: Props) {
  const t = useT();
  // Always ask: a retry keeps the previous transcript readable. Until one exists the
  // server answers 409 TRANSCRIPT_NOT_READY; the SSE 'done' event triggers a refetch.
  const { data: transcript } = useGetTranscriptQuery(recording.id);
  const [copied, setCopied] = useState(false);
  const list = useRef<HTMLOListElement>(null);
  const segments = transcript?.segments ?? [];
  const active = currentTime > 0 ? activeSegmentIndex(segments, currentTime) : -1;

  const hasSegments = segments.length > 0;
  useEffect(() => {
    if (focusTime === null || !hasSegments || !list.current) return;
    const index = activeSegmentIndex(segments, focusTime);
    list.current.children[index]?.scrollIntoView({ block: 'center' });
    // Only on first render of the transcript, not on every refetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusTime, hasSegments]);

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
          <button type="button" className="link-action" onClick={() => void copy()}>
            {copied ? t('recording.copied') : t('recording.copy')}
          </button>
        )}
      </div>

      {!transcript && <p className={styles.placeholder}>{t('recording.transcriptPending')}</p>}

      {transcript && segments.length === 0 && (
        <p className={styles.placeholder}>
          {transcript.text ? transcript.text : t('recording.noSpeech')}
        </p>
      )}

      {transcript && segments.length > 0 && (
        <>
          {transcript.language && (
            <p className={styles.language}>
              {t('recording.language', { language: transcript.language })}
            </p>
          )}
          <ol ref={list} className={styles.segments} lang={transcript.language ?? undefined}>
            {segments.map((segment, index) => {
              const time = formatTimestamp(segment.start);
              return (
                <li
                  key={segment.index}
                  className={styles.segment}
                  aria-current={index === active ? 'true' : undefined}
                >
                  <button
                    type="button"
                    className={styles.time}
                    aria-label={t('recording.seek', { time })}
                    onClick={() => onSeek(segment.start)}
                  >
                    <time dateTime={`PT${segment.start.toFixed(1)}S`}>{time}</time>
                  </button>
                  <p className={styles.text}>{segment.text}</p>
                </li>
              );
            })}
          </ol>
        </>
      )}
    </section>
  );
}
