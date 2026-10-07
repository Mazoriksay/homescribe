export class DownloadError extends Error {}

export interface DownloadedFile {
  /** Absolute path of the downloaded file. */
  path: string;
  /** Extension without the dot, lower-cased (e.g. "m4a", "webm"). */
  ext: string;
  title: string | null;
  durationSeconds: number | null;
  /** True when the file has no video track. */
  audioOnly: boolean;
}

export interface DownloadOptions {
  /** Directory to download into; created by the caller. */
  dir: string;
  maxBytes: number;
  signal?: AbortSignal;
  onProgress?: (ratio: number) => void;
}

/** Fetches the media behind a link (yt-dlp in production, a fake in tests). */
export interface MediaDownloader {
  available(): Promise<boolean>;
  download(url: string, options: DownloadOptions): Promise<DownloadedFile>;
  /** Updates the downloader itself; resolves with its output, never throws. */
  selfUpdate(): Promise<string>;
}
