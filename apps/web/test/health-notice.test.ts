import { describe, expect, it } from 'vitest';
import { healthProblems } from '../src/ui/health-problems';

describe('healthProblems', () => {
  it('is quiet when everything works or summaries are off', () => {
    expect(healthProblems(null)).toEqual([]);
    expect(
      healthProblems({
        ffmpeg: 'ok',
        ytdlp: 'ok',
        stt: 'ok',
        llm: 'off',
        embedding: 'same_origin',
      }),
    ).toEqual([]);
  });

  it('lists each problem once', () => {
    expect(
      healthProblems({
        ffmpeg: 'missing',
        ytdlp: 'missing',
        stt: 'model_missing',
        llm: 'unreachable',
        embedding: 'origins',
      }),
    ).toEqual([
      'health.ffmpeg.missing',
      'health.ytdlp.missing',
      'health.stt.model_missing',
      'health.llm.unreachable',
    ]);
  });
});
