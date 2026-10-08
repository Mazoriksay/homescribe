export class DownloadError extends Error {}

/** The site wants a signed-in visitor (YouTube: "confirm you're not a bot"). */
export class DownloadBlockedError extends DownloadError {}

/** The cookies yt-dlp got are no longer valid (signed out or rotated). */
export class DownloadCookiesExpiredError extends DownloadBlockedError {}

/** `ok`: a signed-in request went through; `expired`: refused; `unknown`: could not tell. */
export type CookieCheck = 'ok' | 'expired' | 'unknown';

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
  /** Tries the cookies file on one public video without downloading it. Never throws. */
  checkCookies(signal?: AbortSignal): Promise<CookieCheck>;
}
