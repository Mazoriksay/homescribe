import { describe, expect, it } from 'vitest';
import { transcribeChunk, type Chunk } from '../src/stt/chunks';
import type { TranscribeOptions, Transcriber, TranscriptionResult } from '../src/stt/transcriber';

const seg = (start: number, end: number, text: string) => ({ start, end, text });

/** Whisper with Russian forced on an English insert: a few words over and over. */
const looped: TranscriptionResult = {
  language: 'ru',
  text: 'Привет. Счёт. Счёт. Счёт. Счёт. Пока.',
  segments: [
    seg(0, 10, 'Привет.'),
    seg(10, 12, 'Счёт.'),
    seg(12, 14, 'Счёт.'),
    seg(14, 16, 'Счёт.'),
    seg(16, 18, 'Счёт.'),
    seg(40, 50, 'Пока.'),
  ],
};

const english: TranscriptionResult = {
  language: 'en',
  text: 'Shot, scored. Nice and brief.',
  segments: [seg(0, 4, 'Shot, scored.'), seg(5, 9, 'Nice and brief.')],
};

/** Answers the chunk file with a loop and every other file with `part`. */
function fake(part: TranscriptionResult) {
  const calls: { file: string; options: TranscribeOptions | undefined }[] = [];
  const transcriber: Transcriber = {
    model: 'm',
    transcribe: async (file, _signal, options) => {
      calls.push({ file, options });
      return file === 'chunk.wav' ? looped : part;
    },
  };
  return { transcriber, calls };
}

const chunk: Chunk = { start: 100, end: 160 };

function relistenTo(ranges: Chunk[]) {
  return async <T>(range: Chunk, use: (file: string) => Promise<T>) => {
    ranges.push(range);
    return use('part.wav');
  };
}

describe('transcribeChunk: a looped stretch is heard again', () => {
  it('fills the gap when the stretch turns out to be another language', async () => {
    const { transcriber, calls } = fake(english);
    const ranges: Chunk[] = [];
    const result = await transcribeChunk(transcriber, 'chunk.wav', chunk, {
      language: 'ru',
      relisten: relistenTo(ranges),
    });

    // From the first looped segment to the next real one, in recording time.
    expect(ranges).toEqual([{ start: 110, end: 140 }]);
    // The stretch is asked with no language, so Whisper detects it.
    expect(calls.at(-1)).toMatchObject({ file: 'part.wav', options: undefined });
    expect(result.segments).toEqual([
      seg(100, 110, 'Привет.'),
      seg(110, 114, 'Shot, scored.'),
      seg(115, 119, 'Nice and brief.'),
      seg(140, 150, 'Пока.'),
    ]);
    expect(result.gaps).toEqual([]);
    expect(result.text).toBe('Привет. Shot, scored. Nice and brief. Пока.');
    expect(result.language).toBe('ru');
  });

  it('keeps the gap when the stretch is the same language', async () => {
    const { transcriber } = fake({ ...english, language: 'ru' });
    const result = await transcribeChunk(transcriber, 'chunk.wav', chunk, {
      language: 'ru',
      relisten: relistenTo([]),
    });
    expect(result.segments.map((s) => s.text)).toEqual(['Привет.', 'Счёт.', 'Пока.']);
    expect(result.gaps).toEqual([{ start: 112, end: 140 }]);
  });

  it('keeps the gap when the stretch loops again or is empty', async () => {
    const again = { ...looped, language: 'en' };
    for (const part of [again, { language: 'en', text: '', segments: [] }]) {
      const { transcriber } = fake(part);
      const result = await transcribeChunk(transcriber, 'chunk.wav', chunk, {
        language: 'ru',
        relisten: relistenTo([]),
      });
      expect(result.gaps).toEqual([{ start: 112, end: 140 }]);
    }
  });

  it('leaves a loop as a gap without a way to cut the stretch', async () => {
    const { transcriber, calls } = fake(english);
    const result = await transcribeChunk(transcriber, 'chunk.wav', chunk, { language: 'ru' });
    expect(result.gaps).toEqual([{ start: 112, end: 140 }]);
    // The chunk and its retry at a higher temperature, nothing more.
    expect(calls.map((c) => c.file)).toEqual(['chunk.wav', 'chunk.wav']);
  });
});
