import { describe, expect, it } from 'vitest';
import { parseSilences } from '../src/media/ffmpeg';
import { isHallucination, planChunks } from '../src/stt/chunks';

describe('planChunks', () => {
  it('keeps a short recording whole', () => {
    expect(planChunks(70, [])).toEqual([{ start: 0, end: 70 }]);
  });

  it('cuts in the pause nearest to each target point', () => {
    const silences = [
      { start: 30, end: 31 },
      { start: 52, end: 53 },
      { start: 64, end: 66 },
      { start: 118, end: 119 },
    ];
    expect(planChunks(200, silences)).toEqual([
      { start: 0, end: 65 },
      { start: 65, end: 118.5 },
      { start: 118.5, end: 178.5 },
      { start: 178.5, end: 200 },
    ]);
  });

  it('cuts at the target when there is no pause nearby', () => {
    expect(planChunks(150, [{ start: 5, end: 6 }])).toEqual([
      { start: 0, end: 60 },
      { start: 60, end: 120 },
      { start: 120, end: 150 },
    ]);
  });
});

describe('parseSilences', () => {
  it('reads silencedetect output', () => {
    const log = [
      '[silencedetect @ 0x1] silence_start: -0.02',
      '[silencedetect @ 0x1] silence_end: 1.5 | silence_duration: 1.52',
      'size=N/A time=00:01:00.00',
      '[silencedetect @ 0x1] silence_start: 61.25',
      '[silencedetect @ 0x1] silence_end: 62 | silence_duration: 0.75',
      '[silencedetect @ 0x1] silence_start: 90',
    ].join('\n');
    expect(parseSilences(log)).toEqual([
      { start: 0, end: 1.5 },
      { start: 61.25, end: 62 },
    ]);
  });
});

describe('isHallucination', () => {
  it('spots subtitle credits Whisper makes up over silence, not real speech', () => {
    for (const text of [
      'Продолжение следует...',
      'Субтитры создавал DimaTorzok',
      'Редактор субтитров А.Синецкая Корректор А.Егорова',
      'Thank you for watching!',
      'Subtitles by the Amara.org community',
    ]) {
      expect(isHallucination(text), text).toBe(true);
    }
    for (const text of [
      'Продолжение следует на следующей неделе, когда вернётся Борис.',
      'Мы обсудили субтитры к ролику.',
      'До новых встреч.',
    ]) {
      expect(isHallucination(text), text).toBe(false);
    }
  });
});
