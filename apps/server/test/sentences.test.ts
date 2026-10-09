import { describe, expect, it } from 'vitest';
import { segmentsFromWords, type TimedWord } from '../src/stt/sentences';

/** Words 0.4 s long with 0.1 s between them, unless a pause is given as `|seconds`. */
function words(text: string, start = 0): TimedWord[] {
  const result: TimedWord[] = [];
  let at = start;
  for (const token of text.split(' ')) {
    const [word, pause] = token.split('|');
    result.push({ start: at, end: at + 0.4, word: ` ${word}` });
    at += 0.4 + (pause ? Number(pause) : 0.1);
  }
  return result;
}

describe('segmentsFromWords', () => {
  it('cuts after sentence punctuation and keeps the word times', () => {
    const segments = segmentsFromWords(words('Это первая фраза. А это вторая? Да!'));
    expect(segments.map((s) => s.text)).toEqual(['Это первая фраза.', 'А это вторая?', 'Да!']);
    expect(segments[0]).toMatchObject({ start: 0, end: 1.4 });
    expect(segments[1]!.start).toBeCloseTo(1.5);
    expect(segments[2]!.end).toBeCloseTo(3.4);
  });

  it('does not cut at abbreviations, initials or a period inside a sentence', () => {
    const segments = segmentsFromWords(
      words('В 1347 г. чума пришла в Европу, т. е. в Италию. Конец.'),
    );
    expect(segments.map((s) => s.text)).toEqual([
      'В 1347 г. чума пришла в Европу, т. е. в Италию.',
      'Конец.',
    ]);
  });

  it('cuts at a long pause when there is no punctuation', () => {
    const segments = segmentsFromWords(words('раздел первый|1.2 сегодня мы обсуждаем план'));
    expect(segments.map((s) => s.text)).toEqual(['раздел первый', 'сегодня мы обсуждаем план']);
  });

  it('cuts a long sentence after a comma, never past the limit', () => {
    const long = Array.from({ length: 40 }, (_, i) => (i === 24 ? 'слово,' : 'слово')).join(' ');
    const segments = segmentsFromWords(words(long), { maxSeconds: 15 });
    expect(segments.length).toBeGreaterThan(1);
    expect(segments[0]!.text.endsWith('слово,')).toBe(true);
    for (const s of segments) expect(s.end - s.start).toBeLessThanOrEqual(15);
    expect(segments.map((s) => s.text).join(' ')).toBe(long);
  });

  it('cuts a long run without commas at its widest pause', () => {
    const run = Array.from({ length: 40 }, (_, i) => (i === 22 ? 'слово|0.5' : 'слово')).join(' ');
    const segments = segmentsFromWords(words(run), { maxSeconds: 15 });
    expect(segments[0]!.text.split(' ')).toHaveLength(23);
  });

  it('keeps every word, in order, without overlaps', () => {
    const text = 'Раз два три. Четыре пять, шесть семь восемь. Девять|2 десять одиннадцать';
    const segments = segmentsFromWords(words(text));
    expect(segments.map((s) => s.text).join(' ')).toBe(text.replace('|2', ''));
    for (let i = 1; i < segments.length; i++) {
      expect(segments[i]!.start).toBeGreaterThanOrEqual(segments[i - 1]!.end);
    }
  });

  it('returns nothing for no words and skips blank ones', () => {
    expect(segmentsFromWords([])).toEqual([]);
    expect(
      segmentsFromWords([
        { start: 0, end: 0.2, word: ' ' },
        { start: 0.2, end: 0.6, word: ' Да.' },
      ]),
    ).toEqual([{ start: 0.2, end: 0.6, text: 'Да.' }]);
  });
});
