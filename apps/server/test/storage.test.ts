import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MediaStore, servedMediaType, storedNameFor } from '../src/storage';

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

  it('only keeps known media extensions', () => {
    expect(storedNameFor('page.html')).toBe('original.bin');
    expect(storedNameFor('script.svg')).toBe('original.bin');
    expect(storedNameFor('constructor')).toBe('original.bin');
    expect(storedNameFor('x.constructor')).toBe('original.bin');
  });
});

describe('servedMediaType', () => {
  it('serves by our own extension map, not by what the client claimed', () => {
    expect(servedMediaType('original.m4a', 'text/html')).toBe('audio/mp4');
    expect(servedMediaType('original.webm', 'audio/webm')).toBe('audio/webm');
    expect(servedMediaType('original.webm', 'application/octet-stream')).toBe('video/webm');
    expect(servedMediaType('original.bin', 'audio/mpeg')).toBe('application/octet-stream');
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
