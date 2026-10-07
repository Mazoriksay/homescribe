import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { randomUUID } from 'node:crypto';
import {
  API_PREFIX,
  createJobBodySchema,
  idParamsSchema,
  listRecordingsQuerySchema,
  TITLE_MAX_LENGTH,
  titleSchema,
  updateRecordingBodySchema,
} from '@homescribe/shared';
import type { FastifyInstance } from 'fastify';
import { servedMediaType, storedNameFor } from '../storage';
import { AppError, notFound, parseInput } from './errors';
import type { AppDeps } from './app';

const ACCEPTED_TYPE = /^(audio|video)\/[\w.+-]+$|^application\/octet-stream$/i;

function defaultTitle(filename: string): string {
  const base = filename.replace(/\.[^.]*$/, '').trim();
  return (base || 'Untitled').slice(0, TITLE_MAX_LENGTH);
}

/** Display-only file name: no control characters, bounded length. */
function cleanFilename(filename: string | undefined): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = (filename ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return (cleaned || 'upload').slice(0, 255);
}

export function registerRecordingRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { repo, store, runner, events, config, aiSettings } = deps;

  app.post(`${API_PREFIX}/recordings`, async (request, reply) => {
    const data = await request.file({
      limits: { fileSize: config.maxUploadBytes, files: 1, fields: 5, fieldSize: 1024 },
    });
    if (!data) throw new AppError(400, 'FILE_REQUIRED', 'Send the media as a "file" part');

    if (!ACCEPTED_TYPE.test(data.mimetype)) {
      data.file.resume();
      throw new AppError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Only audio and video files are accepted', {
        mediaType: data.mimetype,
      });
    }

    const titleField = data.fields.title;
    const rawTitle =
      titleField && !Array.isArray(titleField) && titleField.type === 'field'
        ? titleField.value
        : undefined;
    const originalFilename = cleanFilename(data.filename);
    const title =
      rawTitle === undefined || rawTitle === ''
        ? defaultTitle(originalFilename)
        : parseInput(titleSchema, rawTitle, 'title');

    const id = randomUUID();
    const storedName = storedNameFor(originalFilename);
    const target = store.originalPath(id, storedName);
    await store.ensureRecordingDir(id);
    const output = createWriteStream(target, { flags: 'wx' });
    try {
      await pipeline(data.file, output);
      if (data.file.truncated) {
        throw new AppError(413, 'FILE_TOO_LARGE', 'The upload is larger than allowed');
      }
    } catch (error) {
      await store.removeRecording(id);
      throw error;
    }

    const recording = repo.createRecording({
      id,
      title,
      originalFilename,
      mediaType: data.mimetype,
      sizeBytes: output.bytesWritten,
      storedName,
    });
    events.emit({ event: 'job', data: recording.job });
    runner.kick();
    return reply.status(201).header('location', `${API_PREFIX}/recordings/${id}`).send(recording);
  });

  app.get(`${API_PREFIX}/recordings`, async (request) => {
    const query = parseInput(listRecordingsQuerySchema, request.query, 'query');
    return repo.listRecordings(query);
  });

  app.get(`${API_PREFIX}/recordings/:id`, async (request) => {
    const { id } = parseInput(idParamsSchema, request.params, 'recording id');
    return repo.getRecording(id) ?? Promise.reject(notFound('Recording'));
  });

  app.patch(`${API_PREFIX}/recordings/:id`, async (request) => {
    const { id } = parseInput(idParamsSchema, request.params, 'recording id');
    const { title } = parseInput(updateRecordingBodySchema, request.body ?? {}, 'body');
    return repo.renameRecording(id, title) ?? Promise.reject(notFound('Recording'));
  });

  app.get(`${API_PREFIX}/recordings/:id/summary`, async (request) => {
    const { id } = parseInput(idParamsSchema, request.params, 'recording id');
    if (!repo.getRecording(id)) throw notFound('Recording');
    const summary = repo.getSummary(id);
    if (!summary) throw new AppError(409, 'SUMMARY_NOT_READY', 'There is no summary yet');
    return summary;
  });

  app.get(`${API_PREFIX}/recordings/:id/media`, async (request, reply) => {
    const { id } = parseInput(idParamsSchema, request.params, 'recording id');
    const recording = repo.getRecording(id);
    const storedName = repo.getStoredName(id);
    if (!recording || !storedName) throw notFound('Recording');
    return reply
      .header('content-type', servedMediaType(storedName, recording.mediaType))
      .header('content-disposition', 'inline')
      .header('content-security-policy', "sandbox; default-src 'none'")
      .sendFile(storedName, store.recordingDir(id), { contentType: false, cacheControl: false });
  });

  app.delete(`${API_PREFIX}/recordings/:id`, async (request, reply) => {
    const { id } = parseInput(idParamsSchema, request.params, 'recording id');
    if (!repo.getRecording(id)) throw notFound('Recording');
    const active = repo.activeJob(id);
    if (active && active.status !== 'queued') {
      throw new AppError(409, 'JOB_ACTIVE', 'Wait for the current job to finish');
    }
    repo.deleteRecording(id);
    await store.removeRecording(id);
    events.emit({ event: 'recording.deleted', data: { id } });
    return reply.status(204).send();
  });

  app.get(`${API_PREFIX}/recordings/:id/transcript`, async (request) => {
    const { id } = parseInput(idParamsSchema, request.params, 'recording id');
    if (!repo.getRecording(id)) throw notFound('Recording');
    const transcript = repo.getTranscript(id);
    if (!transcript) {
      throw new AppError(409, 'TRANSCRIPT_NOT_READY', 'The transcript is not ready yet');
    }
    return transcript;
  });

  app.post(`${API_PREFIX}/recordings/:id/jobs`, async (request, reply) => {
    const { id } = parseInput(idParamsSchema, request.params, 'recording id');
    const body = parseInput(createJobBodySchema, request.body ?? {}, 'body');
    if (!repo.getRecording(id)) throw notFound('Recording');
    if (repo.activeJob(id)) {
      throw new AppError(409, 'JOB_ACTIVE', 'This recording already has a job in progress');
    }
    if (body.kind === 'summarize') {
      if (!repo.getTranscript(id)) {
        throw new AppError(409, 'TRANSCRIPT_NOT_READY', 'Transcribe the recording first');
      }
      if (aiSettings.effective('llm').mode === 'off') {
        throw new AppError(409, 'SUMMARIES_OFF', 'Summaries are turned off in the settings');
      }
    }
    const job = repo.createJob(id, body.kind);
    events.emit({ event: 'job', data: job });
    runner.kick();
    return reply.status(202).send(job);
  });

  app.get(`${API_PREFIX}/jobs/:id`, async (request) => {
    const { id } = parseInput(idParamsSchema, request.params, 'job id');
    return repo.getJob(id) ?? Promise.reject(notFound('Job'));
  });
}
