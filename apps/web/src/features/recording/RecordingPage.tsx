import type { Recording } from '@homescribe/shared';
import { useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { errorCode, useGetRecordingQuery } from '../../api/api';
import { useT } from '../../i18n/useT';
import { MediaPlayer } from './MediaPlayer';
import { RecordingHeader } from './RecordingHeader';
import styles from './RecordingPage.module.css';
import { StatusPanel } from './StatusPanel';
import { SummaryView } from './SummaryView';
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
  const media = useRef<HTMLMediaElement | null>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [params] = useSearchParams();
  // `?t=<seconds>` (from search results) starts playback position there.
  const startAt = Math.max(0, Number(params.get('t')) || 0);

  const seek = (seconds: number) => {
    if (!media.current) return;
    media.current.currentTime = seconds;
    Promise.resolve(media.current.play()).catch(() => undefined);
  };

  return (
    <>
      <RecordingHeader recording={recording} />
      <StatusPanel recording={recording} />
      <MediaPlayer
        recording={recording}
        mediaRef={media}
        startAt={startAt}
        onTime={setCurrentTime}
      />
      <SummaryView recording={recording} />
      <TranscriptView
        recording={recording}
        currentTime={currentTime}
        focusTime={startAt || null}
        onSeek={seek}
      />
    </>
  );
}
