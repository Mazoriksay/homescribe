import { spawn } from 'node:child_process';
import { access, copyFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import {
  DownloadBlockedError,
  DownloadError,
  type DownloadedFile,
  type DownloadOptions,
  type MediaDownloader,
} from './downloader';

const PROGRESS = '[hs-progress]';
const DONE = '[hs-done]';
const STDERR_LIMIT = 4000;

const doneSchema = z.object({
  filepath: z.string(),
  ext: z.string().nullish(),
  title: z.string().nullish(),
  duration: z.number().nullish(),
  vcodec: z.string().nullish(),
});

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function run(
  bin: string,
  args: string[],
  signal?: AbortSignal,
  onLine?: (line: string) => void,
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], signal });
    let stdout = '';
    let stderr = '';
    let pending = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      stdout = (stdout + chunk).slice(-64_000);
      pending += chunk;
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? '';
      for (const line of lines) onLine?.(line);
    });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-STDERR_LIMIT);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (pending) onLine?.(pending);
      resolve({ code, stdout, stderr });
    });
  });
}

/** The most useful line of yt-dlp's stderr, e.g. "ERROR: [youtube] x: Video unavailable". */
function errorLine(stderr: string): string {
  const lines = stderr
    .trim()
    .split('\n')
    .map((line) => line.trim());
  return (
    lines.filter((line) => line.startsWith('ERROR:')).at(-1) ?? lines.at(-1) ?? 'unknown error'
  );
}

const BLOCKED = /confirm you.re not a bot|sign in to confirm|--cookies-from-browser/i;

const exists = (file: string) =>
  access(file).then(
    () => true,
    () => false,
  );

/**
 * Downloads with yt-dlp (SPEC.md §7.7): best audio of a single video, size
 * capped, no config files, URL after "--", arguments as an array. Option
 * names follow the yt-dlp README.
 */
export class YtDlpDownloader implements MediaDownloader {
  constructor(
    private readonly bin: string,
    /** A Netscape cookies.txt passed to yt-dlp when the file exists. */
    private readonly cookiesFile: string | null = null,
  ) {}

  async available(): Promise<boolean> {
    try {
      return (await run(this.bin, ['--version'])).code === 0;
    } catch {
      return false;
    }
  }

  async download(url: string, options: DownloadOptions): Promise<DownloadedFile> {
    const { dir, maxBytes, signal, onProgress } = options;
    // yt-dlp writes cookies back on exit: give it a copy, keep the original as is.
    const cookies = this.cookiesFile && (await exists(this.cookiesFile)) ? this.cookiesFile : null;
    const cookiesCopy = path.join(dir, '.cookies.txt');
    if (cookies) await copyFile(cookies, cookiesCopy);
    const args = [
      ...(cookies ? ['--cookies', cookiesCopy] : []),
      '--ignore-config',
      '--no-playlist',
      '--no-mtime',
      '-f',
      'bestaudio/best',
      '--max-filesize',
      String(maxBytes),
      '--newline',
      '--progress',
      '--progress-template',
      `download:${PROGRESS} %(progress.downloaded_bytes)s %(progress.total_bytes)s %(progress.total_bytes_estimate)s`,
      '--print',
      `after_move:${DONE} %(.{filepath,ext,title,duration,vcodec})j`,
      '--no-simulate',
      '-o',
      path.join(dir, 'download.%(ext)s'),
      '--',
      url,
    ];

    let done: z.infer<typeof doneSchema> | null = null;
    let result: RunResult;
    try {
      result = await run(this.bin, args, signal, (line) => {
        if (line.startsWith(PROGRESS)) {
          const [downloaded, total, estimate] = line.slice(PROGRESS.length).trim().split(' ');
          const size = Number(total) || Number(estimate);
          const got = Number(downloaded);
          if (size > 0 && Number.isFinite(got)) onProgress?.(Math.min(1, got / size));
        } else if (line.startsWith(DONE)) {
          try {
            const parsed = doneSchema.safeParse(JSON.parse(line.slice(DONE.length).trim()));
            if (parsed.success) done = parsed.data;
          } catch {
            // Reported below as a missing result.
          }
        }
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new DownloadError(`Cannot run ${path.basename(this.bin)}: is yt-dlp installed?`, {
        cause: error,
      });
    } finally {
      if (cookies) await rm(cookiesCopy, { force: true });
    }

    if (result.code !== 0) {
      const line = errorLine(result.stderr);
      throw BLOCKED.test(line) ? new DownloadBlockedError(line) : new DownloadError(line);
    }
    const file = done as z.infer<typeof doneSchema> | null;
    if (!file) {
      // --max-filesize skips a file without failing.
      throw new DownloadError(
        /larger than max-filesize|File is larger/i.test(result.stdout + result.stderr)
          ? 'The media is larger than MAX_UPLOAD_MB'
          : 'yt-dlp finished without a file',
      );
    }
    if (path.dirname(path.resolve(file.filepath)) !== path.resolve(dir)) {
      throw new DownloadError('yt-dlp wrote outside the download directory');
    }
    return {
      path: file.filepath,
      ext: (file.ext ?? path.extname(file.filepath).slice(1)).toLowerCase(),
      title: file.title?.trim() || null,
      durationSeconds: file.duration ?? null,
      audioOnly: file.vcodec === 'none',
    };
  }

  async selfUpdate(): Promise<string> {
    try {
      const { stdout, stderr } = await run(this.bin, ['-U'], AbortSignal.timeout(120_000));
      return (stdout + stderr).trim().split('\n').at(-1) ?? '';
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }
}
