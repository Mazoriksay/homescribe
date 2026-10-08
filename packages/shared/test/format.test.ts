import { describe, expect, it } from 'vitest';
import { collapseRepeatedSegments, findRepeatRuns, formatTimestamp } from '../src/format';

describe('formatTimestamp', () => {
  it('formats seconds under an hour as m:ss', () => {
    expect(formatTimestamp(0)).toBe('0:00');
    expect(formatTimestamp(5.9)).toBe('0:05');
    expect(formatTimestamp(65)).toBe('1:05');
    expect(formatTimestamp(3599)).toBe('59:59');
  });

  it('formats an hour or more as h:mm:ss', () => {
    expect(formatTimestamp(3600)).toBe('1:00:00');
    expect(formatTimestamp(3 * 3600 + 7 * 60 + 9)).toBe('3:07:09');
  });

  it('treats negative and non-finite input as zero', () => {
    expect(formatTimestamp(-3)).toBe('0:00');
    expect(formatTimestamp(Number.NaN)).toBe('0:00');
  });
});

describe('collapseRepeatedSegments', () => {
  const seg = (text: string, start = 0) => ({ start, end: start + 1, text });

  it('keeps one segment of a run of three or more identical ones', () => {
    const input = [
      seg('Hello.'),
      seg('Again', 1),
      seg('again.', 2),
      seg('AGAIN', 3),
      seg('Bye.', 4),
    ];
    expect(collapseRepeatedSegments(input).map((s) => s.text)).toEqual(['Hello.', 'Again', 'Bye.']);
  });

  it('leaves short repeats and different text alone', () => {
    const input = [seg('Yes.'), seg('Yes.', 1), seg('No.', 2), seg('Yes.', 3)];
    expect(collapseRepeatedSegments(input)).toEqual(input);
  });

  it('handles a loop that runs to the end', () => {
    const input = [seg('Start.'), ...Array.from({ length: 149 }, (_, i) => seg('Borís', i + 1))];
    expect(collapseRepeatedSegments(input).map((s) => s.text)).toEqual(['Start.', 'Borís']);
  });
});

describe('findRepeatRuns', () => {
  it('reports runs of three or more as index ranges', () => {
    const texts = ['a', 'Борис', 'борис.', 'Борис', 'b', 'c', 'c', 'd', 'd', 'd'];
    expect(findRepeatRuns(texts.map((text) => ({ text })))).toEqual([
      [1, 4],
      [7, 10],
    ]);
  });
});
