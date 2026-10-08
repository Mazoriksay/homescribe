import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Job, ServerEvent } from '@homescribe/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db/database';
import { Repository } from '../src/db/repository';
import { EventBus } from '../src/events';
import { JobRunner } from '../src/jobs/runner';
import { MediaStore } from '../src/storage';
import {
  deferred,
  fakeAi,
  FakeMediaTool,
  FakeSummarizer,
  FakeTranscriber,
  silentLogger,
} from './support/fakes';

describe('JobRunner', () => {
  let dataDir: string;
  let repo: Repository;
  let store: MediaStore;
  let media: FakeMediaTool;
  let transcriber: FakeTranscriber;
  let summarizer: FakeSummarizer;
  let ai: ReturnType<typeof fakeAi>;
  let events: EventBus;
  let seen: ServerEvent[];
  let runner: JobRunner;

  beforeEach(async () => {
    dataDir = await mkdtemp(path.join(os.tmpdir(), 'homescribe-runner-'));
    repo = new Repository(openDatabase(':memory:'));
    store = new MediaStore(dataDir);
    media = new FakeMediaTool();
    transcriber = new FakeTranscriber();
    summarizer = new FakeSummarizer();
    ai = fakeAi(transcriber, summarizer, { llmOff: false, format: 'wav' });
    events = new EventBus();
    seen = [];
    events.subscribe((event) => seen.push(event));
    runner = new JobRunner({
      repo,
      store,
      media,
      ai,
      events,
      logger: silentLogger,
      progressIntervalMs: 0,
    });
  });

  afterEach(async () => {
    await runner.stop();
    await rm(dataDir, { recursive: true, force: true });
  });

  async function upload(): Promise<{ id: string; job: Job }> {
    const id = randomUUID();
    await store.ensureRecordingDir(id);
    await writeFile(store.originalPath(id, 'original.m4a'), 'media');
    const recording = repo.createRecording({
      id,
      title: 'Note',
      originalFilename: 'note.m4a',
      mediaType: 'audio/mp4',
      sizeBytes: 5,
      storedName: 'original.m4a',
    });
    return { id, job: recording.job };
  }

  const statuses = (jobId: string) =>
    seen
      .filter((e): e is Extract<ServerEvent, { event: 'job' }> => e.event === 'job')
      .filter((e) => e.data.id === jobId)
      .map((e) => e.data.status);

  it('converts, transcribes and stores the transcript', async () => {
    const { id, job } = await upload();
    runner.start();
    await runner.idle();

    expect(repo.getJob(job.id)).toMatchObject({ status: 'done', progress: null, error: null });
    expect(repo.getRecording(id)?.durationSeconds).toBe(42);
    expect(repo.getTranscript(id)).toMatchObject({
      model: 'fake-whisper',
      language: 'en',
      segments: [
        { index: 0, start: 0, end: 1.5, text: 'Hello there.' },
        { index: 1, start: 1.5, end: 3, text: 'Bye.' },
      ],
    });
    expect(media.converted[0]?.input).toBe(store.originalPath(id, 'original.m4a'));
    expect(new Set(statuses(job.id))).toEqual(
      new Set(['converting', 'transcribing', 'summarizing', 'done']),
    );
    expect(repo.getSummary(id)).toMatchObject({
      summary: '- Plan agreed',
      actionItems: ['Ann: send notes'],
      model: 'fake-llm',
    });
    expect(summarizer.calls).toEqual([{ text: 'Hello there. Bye.', language: 'en' }]);
    expect(existsSync(store.workDir(id))).toBe(false);
  });

  it('keeps segments within the length of the recording', async () => {
    media.duration = 4;
    transcriber.result = {
      language: 'ru',
      text: 'Конец. Хвост.',
      segments: [
        { start: 2, end: 4.5, text: 'Конец.' },
        { start: 4.2, end: 5, text: 'Хвост.' },
      ],
    };
    const { id } = await upload();
    runner.start();
    await runner.idle();
    expect(repo.getTranscript(id)?.segments).toMatchObject([{ start: 2, end: 4, text: 'Конец.' }]);
  });

  it('publishes conversion progress', async () => {
    const { job } = await upload();
    runner.start();
    await runner.idle();
    const progress = seen
      .filter((e) => e.event === 'job' && e.data.id === job.id && e.data.status === 'converting')
      .map((e) => (e.data as Job).progress);
    expect(progress).toEqual([0, 0.5, 1]);
  });

  it('skips summarizing when summaries are off', async () => {
    ai.state.llmOff = true;
    const { id, job } = await upload();
    runner.start();
    await runner.idle();
    expect(repo.getJob(job.id)?.status).toBe('done');
    expect(statuses(job.id)).not.toContain('summarizing');
    expect(repo.getSummary(id)).toBeNull();
  });

  it('skips summarizing when no speech was recognised', async () => {
    transcriber.result = { language: null, text: '', segments: [] };
    const { job } = await upload();
    runner.start();
    await runner.idle();
    expect(repo.getJob(job.id)?.status).toBe('done');
    expect(summarizer.calls).toEqual([]);
  });

  it('keeps the transcript when the summary fails', async () => {
    summarizer.failWith = 'LLM_UNAVAILABLE';
    const { id, job } = await upload();
    runner.start();
    await runner.idle();
    expect(repo.getJob(job.id)).toMatchObject({
      status: 'failed',
      error: { code: 'LLM_UNAVAILABLE' },
    });
    expect(repo.getTranscript(id)).not.toBeNull();
    expect(repo.getSummary(id)).toBeNull();
  });

  /** Records what the runner asks of the GPU, in order. */
  function fakeGpu(takeTurns: boolean) {
    const calls: string[] = [];
    return {
      calls,
      takeTurns: () => takeTurns,
      waitForSttIdle: async () => {
        calls.push('wait');
        return true;
      },
      waitBeforeRetry: async () => void calls.push('wait before retry'),
      unloadLlm: async () => void calls.push('unload llm'),
    };
  }

  function runnerWith(gpu: ReturnType<typeof fakeGpu>) {
    return new JobRunner({ repo, store, media, ai, events, logger: silentLogger, gpu });
  }

  it('takes turns: waits for Whisper to go before the summary and unloads the model after', async () => {
    const gpu = fakeGpu(true);
    const original = summarizer.summarize.bind(summarizer);
    summarizer.summarize = async (...args) => {
      gpu.calls.push('summarize');
      return original(...args);
    };
    runner = runnerWith(gpu);
    const { job } = await upload();
    runner.start();
    await runner.idle();
    expect(repo.getJob(job.id)?.status).toBe('done');
    expect(gpu.calls).toEqual(['wait', 'summarize', 'unload llm']);
  });

  it('does not wait or unload when not taking turns', async () => {
    const gpu = fakeGpu(false);
    runner = runnerWith(gpu);
    const { job } = await upload();
    runner.start();
    await runner.idle();
    expect(repo.getJob(job.id)?.status).toBe('done');
    expect(gpu.calls).toEqual([]);
  });

  it('tries the summary once more when the model did not load', async () => {
    summarizer.failWith = 'LLM_OUT_OF_MEMORY';
    summarizer.failTimes = 1;
    const gpu = fakeGpu(false);
    runner = runnerWith(gpu);
    const { id, job } = await upload();
    runner.start();
    await runner.idle();
    expect(repo.getJob(job.id)?.status).toBe('done');
    expect(gpu.calls).toEqual(['wait before retry']);
    expect(summarizer.calls).toHaveLength(2);
    expect(repo.getSummary(id)).not.toBeNull();
  });

  it('keeps the transcript and unloads after a second failed load', async () => {
    summarizer.failWith = 'LLM_OUT_OF_MEMORY';
    const gpu = fakeGpu(true);
    runner = runnerWith(gpu);
    const { id, job } = await upload();
    runner.start();
    await runner.idle();
    expect(repo.getJob(job.id)).toMatchObject({
      status: 'failed',
      error: { code: 'LLM_OUT_OF_MEMORY' },
    });
    expect(gpu.calls).toEqual(['wait', 'wait before retry', 'unload llm']);
    expect(repo.getTranscript(id)).not.toBeNull();
  });

  it('regenerates only the summary for a summarize job', async () => {
    const { id } = await upload();
    runner.start();
    await runner.idle();
    summarizer.result = { summary: 'Second take', actionItems: [] };
    const job = repo.createJob(id, 'summarize');
    runner.kick();
    await runner.idle();
    expect(repo.getJob(job.id)?.status).toBe('done');
    expect(statuses(job.id)).toEqual(['summarizing', 'summarizing', 'summarizing', 'done']);
    expect(repo.getSummary(id)?.summary).toBe('Second take');
    expect(transcriber.calls).toBe(1);
    expect(media.converted).toHaveLength(1);
  });

  it('fails a summarize job when summaries are off', async () => {
    const { id } = await upload();
    runner.start();
    await runner.idle();
    ai.state.llmOff = true;
    const job = repo.createJob(id, 'summarize');
    runner.kick();
    await runner.idle();
    expect(repo.getJob(job.id)?.error?.message).toBe('Summaries are turned off');
  });

  it('converts to Ogg Opus for a cloud speech-to-text API', async () => {
    ai.state.format = 'ogg';
    await upload();
    runner.start();
    await runner.idle();
    expect(media.converted[0]?.format).toBe('wav');
    expect(media.cuts).toEqual([expect.objectContaining({ start: 0, end: 42, format: 'ogg' })]);
    expect(transcriber.requests[0]?.file.endsWith('chunk-0.ogg')).toBe(true);
  });

  it('sends a long recording in chunks cut in pauses, with absolute times', async () => {
    media.duration = 150;
    media.silences = [{ start: 58, end: 59 }];
    transcriber.respond = ({ file }) => ({
      language: 'ru',
      text: file,
      segments: [{ start: 1, end: 2, text: path.basename(file) }],
    });
    const { id } = await upload();
    runner.start();
    await runner.idle();

    expect(media.cuts.map((c) => [c.start, c.end])).toEqual([
      [0, 58.5],
      [58.5, 118.5],
      [118.5, 150],
    ]);
    // The language found in the first chunk is passed on to the others.
    expect(transcriber.requests.map((r) => r.options.language)).toEqual([null, 'ru', 'ru']);
    expect(repo.getTranscript(id)?.segments.map((s) => [s.start, s.text])).toEqual([
      [1, 'chunk-0.wav'],
      [59.5, 'chunk-1.wav'],
      [119.5, 'chunk-2.wav'],
    ]);
  });

  it('asks again at a higher temperature when Whisper loops', async () => {
    const loop = Array.from({ length: 5 }, (_, i) => ({
      start: 10 + i,
      end: 11 + i,
      text: 'Борис.',
    }));
    transcriber.respond = ({ options }) => ({
      language: 'ru',
      text: '',
      segments: options.temperature
        ? [
            { start: 0, end: 10, text: 'Начало.' },
            { start: 10, end: 20, text: 'Конец.' },
          ]
        : [{ start: 0, end: 10, text: 'Начало.' }, ...loop],
    });
    const { id } = await upload();
    runner.start();
    await runner.idle();

    expect(transcriber.requests.map((r) => r.options.temperature)).toEqual([undefined, 0.4]);
    expect(repo.getTranscript(id)).toMatchObject({ text: 'Начало. Конец.', gaps: [] });
  });

  it('reports a loop that survives the retry as a gap and keeps one copy', async () => {
    transcriber.respond = () => ({
      language: 'ru',
      text: '',
      segments: [
        { start: 0, end: 10, text: 'Начало.' },
        ...Array.from({ length: 6 }, (_, i) => ({
          start: 10 + i * 5,
          end: 15 + i * 5,
          text: 'Борис.',
        })),
      ],
    });
    const { id, job } = await upload();
    runner.start();
    await runner.idle();

    expect(repo.getJob(job.id)?.status).toBe('done');
    const transcript = repo.getTranscript(id);
    expect(transcript?.segments.map((s) => s.text)).toEqual(['Начало.', 'Борис.']);
    expect(transcript?.text).toBe('Начало. Борис.');
    // From the end of the kept copy to the end of the recording (42 s).
    expect(transcript?.gaps).toEqual([{ start: 15, end: 42 }]);
  });

  it('fails with MEDIA_UNREADABLE when ffmpeg cannot read the file', async () => {
    const { job, id } = await upload();
    media.failWith = 'moov atom not found';
    runner.start();
    await runner.idle();
    expect(repo.getJob(job.id)).toMatchObject({
      status: 'failed',
      error: { code: 'MEDIA_UNREADABLE' },
    });
    expect(repo.getTranscript(id)).toBeNull();
  });

  it.each(['STT_UNAVAILABLE', 'STT_TIMEOUT', 'STT_FAILED'] as const)(
    'fails with %s from the transcriber',
    async (code) => {
      const { job } = await upload();
      transcriber.failWith = code;
      runner.start();
      await runner.idle();
      expect(repo.getJob(job.id)?.error?.code).toBe(code);
    },
  );

  it('runs one job at a time in upload order', async () => {
    const gate = deferred();
    transcriber.gate = gate.promise;
    const first = await upload();
    const second = await upload();
    runner.start();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(repo.getJob(first.job.id)?.status).toBe('transcribing');
    expect(repo.getJob(second.job.id)?.status).toBe('queued');
    expect(transcriber.calls).toBe(1);

    gate.resolve();
    await runner.idle();
    expect(repo.getJob(second.job.id)?.status).toBe('done');
    expect(transcriber.calls).toBe(2);
  });

  it('picks up jobs queued while it is busy', async () => {
    runner.start();
    const { job } = await upload();
    runner.kick();
    await runner.idle();
    expect(repo.getJob(job.id)?.status).toBe('done');
  });

  it('marks jobs left running by a previous process as INTERRUPTED and runs queued ones', async () => {
    const stale = await upload();
    repo.updateJob(stale.job.id, { status: 'transcribing', started: true });
    const queued = await upload();

    runner.start();
    await runner.idle();

    expect(repo.getJob(stale.job.id)).toMatchObject({
      status: 'failed',
      error: { code: 'INTERRUPTED' },
    });
    expect(repo.getJob(queued.job.id)?.status).toBe('done');
  });

  it('fails a job with INTERNAL_ERROR instead of crashing the queue', async () => {
    const broken = await upload();
    media.probeDuration = () => Promise.reject(new Error('disk on fire'));
    const next = await upload();
    runner.start();
    await runner.idle();
    expect(repo.getJob(broken.job.id)?.error?.code).toBe('INTERNAL_ERROR');
    expect(repo.getJob(next.job.id)?.error?.code).toBe('INTERNAL_ERROR');
  });

  it('ends the running job as INTERRUPTED on stop', async () => {
    transcriber.gate = deferred().promise; // never released
    const { job } = await upload();
    runner.start();
    await new Promise((resolve) => setTimeout(resolve, 20));
    await runner.stop();
    expect(repo.getJob(job.id)?.error?.code).toBe('INTERRUPTED');
  });

  it('cancels the running job and goes on with the next one', async () => {
    transcriber.gate = deferred().promise; // never released
    const running = await upload();
    const next = await upload();
    runner.start();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(runner.cancel(running.job.id)?.status).toBe('transcribing');
    transcriber.gate = null;
    await runner.idle();

    expect(repo.getJob(running.job.id)).toMatchObject({
      status: 'failed',
      error: { code: 'CANCELLED' },
    });
    expect(repo.getJob(next.job.id)?.status).toBe('done');
  });

  it('cancels a queued job without running it, and ignores finished ones', async () => {
    const { job } = await upload();
    expect(runner.cancel(job.id)).toMatchObject({ status: 'failed', error: { code: 'CANCELLED' } });
    runner.start();
    await runner.idle();
    expect(transcriber.calls).toBe(0);
    expect(runner.cancel(job.id)).toBeNull();
  });

  it('estimates transcription progress from the speed it measured before', async () => {
    runner = new JobRunner({
      repo,
      store,
      media,
      ai,
      events,
      logger: silentLogger,
      progressIntervalMs: 0,
      estimateIntervalMs: 5,
    });
    // 42 s of audio at 0.01 s per second: about 420 ms of transcription expected.
    repo.recordSttSpeed('fake-whisper', 0.01);
    const gate = deferred();
    transcriber.gate = gate.promise;
    const { job } = await upload();
    runner.start();
    await new Promise((resolve) => setTimeout(resolve, 100));

    const progress = repo.getJob(job.id)?.progress ?? 0;
    expect(repo.getJob(job.id)?.status).toBe('transcribing');
    expect(progress).toBeGreaterThan(0);
    expect(progress).toBeLessThanOrEqual(0.95);

    gate.resolve();
    await runner.idle();
    expect(repo.getSttSpeed('fake-whisper')).toBeGreaterThan(0.005);
  });

  it('leaves transcription progress unknown until a speed is known', async () => {
    const { job } = await upload();
    runner.start();
    await runner.idle();
    const transcribing = seen.find(
      (e) => e.event === 'job' && e.data.id === job.id && e.data.status === 'transcribing',
    );
    expect(transcribing?.event === 'job' && transcribing.data.progress).toBeNull();
    expect(repo.getSttSpeed('fake-whisper')).not.toBeNull();
  });
});
