import { describe, expect, it } from 'vitest';
import { cleanToolOutput, languageName } from '../src/features/recording/recording-text';

describe('recording helpers', () => {
  it('names the transcript language in the UI language', () => {
    expect(languageName('ru', 'ru')).toBe('русский');
    expect(languageName('ru', 'en')).toBe('Russian');
    expect(languageName('not a code', 'en')).toBe('not a code');
  });

  it('drops memory addresses from tool output', () => {
    expect(
      cleanToolOutput(
        "ffprobe exited with code 1: [wav @ 0x64cdfd927340] no 'data' tag found\noriginal.wav: Invalid data\n",
      ),
    ).toBe("ffprobe exited with code 1: [wav] no 'data' tag found\noriginal.wav: Invalid data");
  });
});
