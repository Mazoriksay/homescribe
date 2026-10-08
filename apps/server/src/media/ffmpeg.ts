import { spawn } from 'node:child_process';
import path from 'node:path';
import {
  MediaError,
  type AudioFormat,
  type ConvertOptions,
  type CutOptions,
  type MediaTool,
  type Silence,
} from './media-tool';

const STDERR_LIMIT = 4000;

const codecArgs = (format: AudioFormat) =>
  format === 'ogg' ? ['-c:a', 'libopus', '-b:a', '32k'] : ['-c:a', 'pcm_s16le'];

/** Parses ffmpeg's silencedetect lines ("silence_start: 12.3", "silence_end: 13.1 | ..."). */
export function parseSilences(log: string): Silence[] {
  const silences: Silence[] = [];
  let start: number | null = null;
  for (const line of log.split('\n')) {
    const begin = /silence_start: (-?[\d.]+)/.exec(line);
    if (begin) start = Math.max(0, Number(begin[1]));
    const end = /silence_end: ([\d.]+)/.exec(line);
    if (end && start !== null) {
      silences.push({ start, end: Number(end[1]) });
      start = null;
    }
  }
  return silences;
}

interface RunResult {
  stdout: string;
  stderr: string;
}

/**
 * Runs a binary with an argument array (never through a shell). `onStdout`
 * receives output as it arrives; stderr is kept (tail only) for error messages,
 * or whole with `keepStderr` (silencedetect reports there).
 */
function run(
  bin: string,
  args: string[],
  signal: AbortSignal | undefined,
  redact: string[],
  onStdout?: (chunk: string) => void,
  { keepStderr = false } = {},
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], signal });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      if (onStdout) onStdout(chunk);
      else stdout += chunk;
    });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      stderr = keepStderr ? stderr + chunk : (stderr + chunk).slice(-STDERR_LIMIT);
    });
    child.on('error', (error) => {
      reject(
        signal?.aborted
          ? error
          : new MediaError(`Cannot run ${path.basename(bin)}`, { cause: error }),
      );
    });
    child.on('close', (code) => {
      if (code === 0) return resolve({ stdout, stderr });
      // Error messages reach API clients; never leak server paths.
      const message = redact.reduce(
        (text, filePath) => text.replaceAll(filePath, path.basename(filePath)),
        stderr.slice(-STDERR_LIMIT).trim(),
      );
      reject(new MediaError(`${path.basename(bin)} exited with code ${code}: ${message}`));
    });
  });
}

/** MediaTool backed by the system ffmpeg and ffprobe binaries. */
export class FfmpegMediaTool implements MediaTool {
  constructor(
    private readonly ffmpegPath: string,
    private readonly ffprobePath: string,
  ) {}

  async available(): Promise<boolean> {
    try {
      await run(this.ffmpegPath, ['-version'], undefined, []);
      await run(this.ffprobePath, ['-version'], undefined, []);
      return true;
    } catch {
      return false;
    }
  }

  async probeDuration(input: string, signal?: AbortSignal): Promise<number | null> {
    const { stdout } = await run(
      this.ffprobePath,
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', input],
      signal,
      [input],
    );
    let parsed: unknown;
    try {
      parsed = JSON.parse(stdout);
    } catch {
      throw new MediaError('ffprobe returned invalid JSON');
    }
    const raw = (parsed as { format?: { duration?: unknown } }).format?.duration;
    const duration = typeof raw === 'string' || typeof raw === 'number' ? Number(raw) : NaN;
    return Number.isFinite(duration) && duration >= 0 ? duration : null;
  }

  async convertAudio(input: string, output: string, options: ConvertOptions): Promise<void> {
    const { durationSeconds, onProgress, signal, format } = options;
    const codec = codecArgs(format);
    let buffer = '';
    const handleProgress = (chunk: string) => {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        // `-progress` reports the output position as out_time_us (microseconds).
        const match = /^out_time_us=(\d+)/.exec(line);
        if (match && durationSeconds && onProgress) {
          onProgress(Math.min(1, Number(match[1]) / 1e6 / durationSeconds));
        }
      }
    };
    await run(
      this.ffmpegPath,
      [
        '-nostdin',
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-i',
        input,
        '-vn',
        '-ac',
        '1',
        '-ar',
        '16000',
        ...codec,
        '-progress',
        'pipe:1',
        '-nostats',
        output,
      ],
      signal,
      [input, output],
      handleProgress,
    );
  }

  async findSilences(input: string, signal?: AbortSignal): Promise<Silence[]> {
    // silencedetect logs at info level on stderr; nothing is written.
    const { stderr } = await run(
      this.ffmpegPath,
      [
        '-nostdin',
        '-hide_banner',
        '-nostats',
        '-i',
        input,
        '-af',
        'silencedetect=noise=-35dB:d=0.5',
        '-f',
        'null',
        '-',
      ],
      signal,
      [input],
      undefined,
      { keepStderr: true },
    );
    return parseSilences(stderr);
  }

  async cutAudio(input: string, output: string, options: CutOptions): Promise<void> {
    const { start, end, format, signal } = options;
    await run(
      this.ffmpegPath,
      [
        '-nostdin',
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-ss',
        start.toFixed(3),
        '-to',
        end.toFixed(3),
        '-i',
        input,
        '-ac',
        '1',
        '-ar',
        '16000',
        ...codecArgs(format),
        output,
      ],
      signal,
      [input, output],
    );
  }
}
