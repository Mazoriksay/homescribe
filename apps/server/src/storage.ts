import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SAFE_EXTENSION = /^[a-z0-9]{1,8}$/;

/**
 * Name under which an upload is stored: `original.<ext>`. The extension comes
 * from the client file name only when it is short and alphanumeric; the rest
 * of the client file name never reaches the file system (SPEC.md §6).
 */
export function storedNameFor(originalFilename: string): string {
  const ext = path.extname(originalFilename).slice(1).toLowerCase();
  return `original.${SAFE_EXTENSION.test(ext) ? ext : 'bin'}`;
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
