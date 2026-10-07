import { API_PREFIX, type Recording } from '@homescribe/shared';

export class UploadError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

/**
 * Uploads one file with progress. XMLHttpRequest is used because fetch
 * cannot report upload progress, which matters for long recordings.
 */
export function uploadRecording(
  file: File,
  onProgress: (ratio: number) => void,
  signal?: AbortSignal,
): Promise<Recording> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${API_PREFIX}/recordings`);
    xhr.responseType = 'json';
    xhr.upload.addEventListener('progress', (event) => {
      if (event.lengthComputable) onProgress(event.loaded / event.total);
    });
    xhr.addEventListener('load', () => {
      if (xhr.status === 201) resolve(xhr.response as Recording);
      else {
        const code = (xhr.response as { error?: { code?: string } } | null)?.error?.code;
        reject(new UploadError(code ?? 'unknown'));
      }
    });
    xhr.addEventListener('error', () => reject(new UploadError('NETWORK')));
    xhr.addEventListener('abort', () => reject(new UploadError('ABORTED')));
    signal?.addEventListener('abort', () => xhr.abort());

    const form = new FormData();
    form.append('file', file, file.name);
    xhr.send(form);
  });
}
