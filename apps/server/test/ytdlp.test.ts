import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DownloadBlockedError, DownloadError } from '../src/media/downloader';
import { YtDlpDownloader } from '../src/media/ytdlp';

/**
 * A stand-in yt-dlp: records its arguments and behaves by URL. Output lines
 * follow the templates our downloader passes.
 */
const FAKE = `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
fs.writeFileSync(process.env.FAKE_YTDLP_ARGS, JSON.stringify(args));
if (args[0] === '--version') { console.log('2026.09.30'); process.exit(0); }
if (args[0] === '-U') { console.log('yt-dlp is up to date (stable@2026.09.30)'); process.exit(0); }
const url = args[args.indexOf('--') + 1];
const out = args[args.indexOf('-o') + 1];
if (url.includes('unavailable')) {
  console.error('WARNING: something');
  console.error('ERROR: [youtube] abc: Video unavailable');
  process.exit(1);
}
if (url.includes('bot')) {
  const at = args.indexOf('--cookies');
  if (at !== -1) {
    fs.writeFileSync(process.env.FAKE_YTDLP_ARGS + '.cookies', fs.readFileSync(args[at + 1]));
    fs.appendFileSync(args[at + 1], 'written back by yt-dlp');
  }
  console.error("ERROR: [youtube] abc: Sign in to confirm you’re not a bot. Use --cookies-from-browser or --cookies for the authentication.");
  process.exit(1);
}
if (url.includes('huge')) {
  console.log('[download] File is larger than max-filesize (999 bytes > 10 bytes). Aborting.');
  process.exit(0);
}
if (url.includes('escape')) {
  console.log('[hs-done] ' + JSON.stringify({ filepath: '/etc/passwd', ext: 'mp3' }));
  process.exit(0);
}
console.log('[hs-progress] 500 1000 NA');
console.log('[hs-progress] 750 NA 1000');
const file = out.replace('%(ext)s', 'webm');
fs.writeFileSync(file, 'media');
console.log('[hs-done] ' + JSON.stringify({ filepath: file, ext: 'webm', title: '  A talk  ', duration: 61.5, vcodec: 'none' }));
`;

describe('YtDlpDownloader (fake executable)', () => {
  let dir: string;
  let bin: string;
  let argsFile: string;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'homescribe-ytdlp-'));
    bin = path.join(dir, 'yt-dlp');
    argsFile = path.join(dir, 'args.json');
    await writeFile(bin, FAKE);
    await chmod(bin, 0o755);
    process.env.FAKE_YTDLP_ARGS = argsFile;
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const target = async (name: string) => {
    const out = path.join(dir, name);
    await mkdir(out, { recursive: true });
    return out;
  };

  it('downloads best audio of one video with the safety options, and reports progress', async () => {
    const out = await target('ok');
    const progress: number[] = [];
    const file = await new YtDlpDownloader(bin).download('https://www.youtube.com/watch?v=x', {
      dir: out,
      maxBytes: 1_000_000,
      onProgress: (ratio) => progress.push(ratio),
    });

    expect(file).toEqual({
      path: path.join(out, 'download.webm'),
      ext: 'webm',
      title: 'A talk',
      durationSeconds: 61.5,
      audioOnly: true,
    });
    expect(progress).toEqual([0.5, 0.75]);
    const args = JSON.parse(await readFile(argsFile, 'utf8')) as string[];
    expect(args).toEqual(
      expect.arrayContaining(['--ignore-config', '--no-playlist', '-f', 'bestaudio/best']),
    );
    expect(args[args.indexOf('--max-filesize') + 1]).toBe('1000000');
    expect(args.slice(-2)).toEqual(['--', 'https://www.youtube.com/watch?v=x']);
  });

  it('passes on the yt-dlp error line', async () => {
    const error = await new YtDlpDownloader(bin)
      .download('https://www.youtube.com/watch?v=unavailable', {
        dir: await target('e'),
        maxBytes: 10,
      })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DownloadError);
    expect((error as Error).message).toBe('ERROR: [youtube] abc: Video unavailable');
  });

  it('tells a sign-in wall apart and hands yt-dlp a copy of the cookies', async () => {
    const out = await target('bot');
    const cookies = path.join(dir, 'cookies.txt');
    await writeFile(cookies, '# Netscape HTTP Cookie File\n');
    const error = await new YtDlpDownloader(bin, cookies)
      .download('https://www.youtube.com/watch?v=bot', { dir: out, maxBytes: 10 })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DownloadBlockedError);
    expect(await readFile(`${argsFile}.cookies`, 'utf8')).toBe('# Netscape HTTP Cookie File\n');
    expect(await readFile(cookies, 'utf8')).toBe('# Netscape HTTP Cookie File\n');
    expect(await readdir(out)).toEqual([]);
  });

  it('runs without cookies when the file does not exist', async () => {
    await new YtDlpDownloader(bin, path.join(dir, 'missing.txt')).download('https://x.example/a', {
      dir: await target('nc'),
      maxBytes: 10,
    });
    const args = JSON.parse(await readFile(argsFile, 'utf8')) as string[];
    expect(args).not.toContain('--cookies');
  });

  it('explains a file over the size limit', async () => {
    await expect(
      new YtDlpDownloader(bin).download('https://x.example/huge', {
        dir: await target('h'),
        maxBytes: 10,
      }),
    ).rejects.toThrow(/larger than MAX_UPLOAD_MB/);
  });

  it('refuses a result outside the download directory', async () => {
    await expect(
      new YtDlpDownloader(bin).download('https://x.example/escape', {
        dir: await target('x'),
        maxBytes: 10,
      }),
    ).rejects.toThrow(/outside the download directory/);
  });

  it('checks availability and self-updates', async () => {
    const downloader = new YtDlpDownloader(bin);
    expect(await downloader.available()).toBe(true);
    expect(await downloader.selfUpdate()).toContain('up to date');
    expect(await new YtDlpDownloader('/nonexistent/yt-dlp').available()).toBe(false);
    await expect(
      new YtDlpDownloader('/nonexistent/yt-dlp').download('https://x.example/a', {
        dir,
        maxBytes: 10,
      }),
    ).rejects.toThrow(/is yt-dlp installed/);
  });
});

const hasYtDlp = spawnSync('yt-dlp', ['--version']).status === 0;

// The real binary only where it is installed; it still needs no network here.
describe.skipIf(!hasYtDlp)('YtDlpDownloader (real yt-dlp)', () => {
  it('reports itself available', async () => {
    expect(await new YtDlpDownloader('yt-dlp').available()).toBe(true);
  });
});
