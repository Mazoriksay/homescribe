import { useCallback, useRef, useState } from 'react';
import { api } from '../../api/api';
import { UploadError, uploadRecording } from '../../api/upload';
import { useAppDispatch } from '../../app/hooks';

export interface UploadItem {
  key: string;
  name: string;
  progress: number;
  error: string | null;
}

/** Uploads files one after another and tracks their progress for the UI. */
export function useUploads() {
  const dispatch = useAppDispatch();
  const [items, setItems] = useState<UploadItem[]>([]);
  const queue = useRef(Promise.resolve());

  const patch = (key: string, change: Partial<UploadItem>) =>
    setItems((current) =>
      current.map((item) => (item.key === key ? { ...item, ...change } : item)),
    );

  const add = useCallback(
    (files: Iterable<File>) => {
      for (const file of files) {
        const key = crypto.randomUUID();
        setItems((current) => [...current, { key, name: file.name, progress: 0, error: null }]);
        queue.current = queue.current.then(async () => {
          try {
            await uploadRecording(file, (progress) => patch(key, { progress }));
            setItems((current) => current.filter((item) => item.key !== key));
            dispatch(api.util.invalidateTags(['RecordingList']));
          } catch (error) {
            patch(key, { error: error instanceof UploadError ? error.code : 'unknown' });
          }
        });
      }
    },
    [dispatch],
  );

  const dismiss = useCallback(
    (key: string) => setItems((current) => current.filter((item) => item.key !== key)),
    [],
  );

  return { items, add, dismiss };
}
