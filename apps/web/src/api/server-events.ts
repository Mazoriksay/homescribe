import { API_PREFIX, type Job } from '@homescribe/shared';
import { useEffect } from 'react';
import { useStore } from 'react-redux';
import type { AppStore } from '../app/store';
import { api } from './api';
import { withJob } from './job-events';

/**
 * Keeps RTK Query caches in sync with `GET /api/v1/events` (SSE). Progress
 * updates patch the cache in place; status changes that bring new data
 * (a finished transcript, a new recording) invalidate the affected tags.
 */
export function useServerEvents(): void {
  const store = useStore() as AppStore;

  useEffect(() => {
    const source = new EventSource(`${API_PREFIX}/events`);
    let hadError = false;

    const onJob = (message: MessageEvent<string>) => {
      const job = JSON.parse(message.data) as Job;
      const { dispatch, getState } = store;

      dispatch(
        api.util.updateQueryData('getRecording', job.recordingId, (draft) => withJob(draft, job)),
      );
      let listed = false;
      for (const args of api.util.selectCachedArgsForQuery(getState(), 'listRecordings')) {
        dispatch(
          api.util.updateQueryData('listRecordings', args, (draft) => {
            draft.data = draft.data.map((recording) => {
              if (recording.id !== job.recordingId) return recording;
              listed = true;
              return withJob(recording, job);
            });
          }),
        );
      }
      if (job.status === 'queued' && !listed) dispatch(api.util.invalidateTags(['RecordingList']));
      // A failed summary still leaves a fresh transcript behind.
      if (job.status === 'done' || job.status === 'failed') {
        dispatch(
          api.util.invalidateTags([
            { type: 'Transcript', id: job.recordingId },
            { type: 'Summary', id: job.recordingId },
            { type: 'Recording', id: job.recordingId },
            'Search',
          ]),
        );
      }
    };

    const onDeleted = (message: MessageEvent<string>) => {
      const { id } = JSON.parse(message.data) as { id: string };
      store.dispatch(
        api.util.invalidateTags(['RecordingList', 'Search', { type: 'Recording', id }]),
      );
    };

    // Events are not replayed, so refetch everything after a reconnect.
    const onOpen = () => {
      if (hadError)
        store.dispatch(
          api.util.invalidateTags([
            'RecordingList',
            'Recording',
            'Transcript',
            'Summary',
            'Search',
          ]),
        );
      hadError = false;
    };
    const onError = () => {
      hadError = true;
    };

    source.addEventListener('job', onJob);
    source.addEventListener('recording.deleted', onDeleted);
    source.addEventListener('open', onOpen);
    source.addEventListener('error', onError);
    return () => source.close();
  }, [store]);
}
