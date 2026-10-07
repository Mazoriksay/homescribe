import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Media extensions kept on upload, with the type they are served as. */
const MEDIA_TYPES: Record<string, string> = {
  '3gp': 'video/3gpp',
  aac: 'audio/aac',
  aif: 'audio/aiff',
  aiff: 'audio/aiff',
  amr: 'audio/amr',
  avi: 'video/x-msvideo',
  caf: 'audio/x-caf',
  flac: 'audio/flac',
  m4a: 'audio/mp4',
  m4v: 'video/mp4',
  mka: 'audio/x-matroska',
  mkv: 'video/x-matroska',
  mov: 'video/quicktime',
  mp3: 'audio/mpeg',
  mp4: 'video/mp4',
  mpeg: 'video/mpeg',
  mpg: 'video/mpeg',
  oga: 'audio/ogg',
  ogg: 'audio/ogg',
  opus: 'audio/ogg',
  wav: 'audio/wav',
  weba: 'audio/webm',
  webm: 'video/webm',
  wma: 'audio/x-ms-wma',
  wmv: 'video/x-ms-wmv',
};

/**
 * Type a stored file is served as. Derived from our own allow-list, never
 * from the client, so an upload can never be served as HTML or script.
 */
export function servedMediaType(storedName: string, clientType: string): string {
  const ext = path.extname(storedName).slice(1);
  const known = MEDIA_TYPES[ext];
  if (known) {
    // Keep the client's audio/* vs video/* when it agrees on the container (e.g. audio/webm).
    return /^(audio|video)\/[\w.+-]+$/.test(clientType) &&
      clientType.split('/')[1] === known.split('/')[1]
      ? clientType
      : known;
  }
  return 'application/octet-stream';
}

/**
 * Name under which an upload is stored: `original.<ext>`. The extension comes
 * from the client file name only when it is a known media extension; the rest
 * of the client file name never reaches the file system (SPEC.md §6).
 */
export function storedNameFor(originalFilename: string): string {
  const ext = path.extname(originalFilename).slice(1).toLowerCase();
  return `original.${Object.hasOwn(MEDIA_TYPES, ext) ? ext : 'bin'}`;
}

/** Builds every media path from DATA_DIR and a recording UUID. */
export class MediaStore {
  readonly root: string;

  constructor(dataDir: string) {
    this.root = path.join(dataDir, 'media');
  }

  recordingDir(id: string): string {
    if (!UUID.test(id)) throw new Error(`Not a recording id: ${id}`);
    return path.join(this.root, id);
  }

  originalPath(id: string, storedName: string): string {
    if (!/^original\.[a-z0-9]{1,8}$/.test(storedName)) {
      throw new Error(`Unexpected stored name: ${storedName}`);
    }
    return path.join(this.recordingDir(id), storedName);
  }

  workDir(id: string): string {
    return path.join(this.recordingDir(id), 'work');
  }

  async ensureRecordingDir(id: string): Promise<string> {
    const dir = this.recordingDir(id);
    await mkdir(dir, { recursive: true });
    return dir;
  }

  async removeRecording(id: string): Promise<void> {
    await rm(this.recordingDir(id), { recursive: true, force: true });
  }

  async removeWorkDir(id: string): Promise<void> {
    await rm(this.workDir(id), { recursive: true, force: true });
  }
}
