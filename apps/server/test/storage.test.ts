import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MediaStore, storedNameFor } from '../src/storage';

const id = '0b9f1a8e-3c6d-4f7a-8e2b-5d4c3b2a1f00';

describe('storedNameFor', () => {
  it('keeps a short alphanumeric extension, lower-cased', () => {
    expect(storedNameFor('Meeting Notes.M4A')).toBe('original.m4a');
    expect(storedNameFor('voice.webm')).toBe('original.webm');
  });

  it('falls back to bin for missing or suspicious extensions', () => {
    expect(storedNameFor('noext')).toBe('original.bin');
    expect(storedNameFor('../../etc/passwd')).toBe('original.bin');
    expect(storedNameFor('a.verylongextension')).toBe('original.bin');
    expect(storedNameFor('a.m4a/../x')).toBe('original.bin');
  });
});

describe('MediaStore', () => {
  const store = new MediaStore('/data');

  it('builds paths under DATA_DIR/media/<id>', () => {
    expect(store.originalPath(id, 'original.m4a')).toBe(
      path.join('/data/media', id, 'original.m4a'),
    );
    expect(store.workDir(id)).toBe(path.join('/data/media', id, 'work'));
  });

  it('refuses anything that is not a UUID or a stored name', () => {
    expect(() => store.recordingDir('../../etc')).toThrow();
    expect(() => store.originalPath(id, '../secret')).toThrow();
  });
});
