import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FfmpegMediaTool } from '../src/media/ffmpeg';
import { MediaError } from '../src/media/media-tool';

const hasFfmpeg =
  spawnSync('ffmpeg', ['-version']).status === 0 && spawnSync('ffprobe', ['-version']).status === 0;

// Runs only where ffmpeg is installed; everything else uses a fake MediaTool.
describe.skipIf(!hasFfmpeg)('FfmpegMediaTool (real ffmpeg)', () => {
  const tool = new FfmpegMediaTool('ffmpeg', 'ffprobe');
  let dir: string;
  let input: string;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'homescribe-ffmpeg-'));
    input = path.join(dir, 'tone.m4a');
    const made = spawnSync('ffmpeg', [
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:duration=2',
      '-ac',
      '2',
      '-ar',
      '44100',
      input,
    ]);
    expect(made.status).toBe(0);
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('reads the duration', async () => {
    const duration = await tool.probeDuration(input);
    expect(duration).toBeGreaterThan(1.9);
    expect(duration).toBeLessThan(2.2);
  });

  it('converts to 16 kHz mono PCM WAV and reports progress', async () => {
    const output = path.join(dir, 'out.wav');
    const ratios: number[] = [];
    await tool.convertToWav(input, output, {
      durationSeconds: 2,
      onProgress: (ratio) => ratios.push(ratio),
    });
    const wav = await readFile(output);
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF');
    expect(wav.readUInt16LE(22)).toBe(1); // channels
    expect(wav.readUInt32LE(24)).toBe(16000); // sample rate
    expect(wav.readUInt16LE(34)).toBe(16); // bits per sample
    expect(ratios.length).toBeGreaterThan(0);
    expect(Math.max(...ratios)).toBeLessThanOrEqual(1);
  });

  it('throws MediaError for a file that is not media', async () => {
    const junk = path.join(dir, 'junk.mp3');
    await writeFile(junk, 'definitely not audio');
    const error = await tool.probeDuration(junk).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MediaError);
    expect((error as Error).message).toContain('junk.mp3');
    expect((error as Error).message).not.toContain(dir);
    await expect(
      tool.convertToWav(junk, path.join(dir, 'junk.wav'), { durationSeconds: null }),
    ).rejects.toBeInstanceOf(MediaError);
  });
});

describe('FfmpegMediaTool (missing binary)', () => {
  it('reports a missing binary as MediaError', async () => {
    const tool = new FfmpegMediaTool('/nonexistent/ffmpeg', '/nonexistent/ffprobe');
    await expect(tool.probeDuration('/tmp/x.wav')).rejects.toBeInstanceOf(MediaError);
  });
});
