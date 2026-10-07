import { describe, expect, it } from 'vitest';
import { formatTimestamp } from '../src/format';

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
