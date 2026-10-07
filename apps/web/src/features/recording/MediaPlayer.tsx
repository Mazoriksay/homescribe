import { API_PREFIX, type Recording } from '@homescribe/shared';
import { useState, type RefObject } from 'react';
import { useT } from '../../i18n/useT';
import styles from './RecordingPage.module.css';

interface Props {
  recording: Recording;
  mediaRef: RefObject<HTMLMediaElement | null>;
  /** Initial position in seconds (0 = start). */
  startAt: number;
  onTime: (seconds: number) => void;
}

/** Native player for the original upload; the transcript follows its position. */
export function MediaPlayer({ recording, mediaRef, startAt, onTime }: Props) {
  const t = useT();
  const [unsupported, setUnsupported] = useState(false);
  const isVideo = recording.mediaType.startsWith('video/');
  const shared = {
    src: `${API_PREFIX}/recordings/${recording.id}/media`,
    controls: true,
    preload: 'metadata' as const,
    className: isVideo ? styles.video : styles.audio,
    'aria-label': t('recording.player'),
    onTimeUpdate: (event: { currentTarget: HTMLMediaElement }) =>
      onTime(event.currentTarget.currentTime),
    onLoadedMetadata: (event: { currentTarget: HTMLMediaElement }) => {
      if (startAt > 0) event.currentTarget.currentTime = startAt;
    },
    onError: () => setUnsupported(true),
  };

  if (unsupported) return <p className={styles.hint}>{t('recording.playerUnsupported')}</p>;
  return isVideo ? (
    <video ref={mediaRef as RefObject<HTMLVideoElement | null>} playsInline {...shared} />
  ) : (
    <audio ref={mediaRef as RefObject<HTMLAudioElement | null>} {...shared} />
  );
}
