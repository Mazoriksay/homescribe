import { describe, expect, it } from 'vitest';
import type { Transcript } from '../src/api';
import { cueTime, exportFileName, toMarkdown, toSrt, toText, toVtt } from '../src/export';

const transcript = (over: Partial<Transcript> = {}): Transcript => ({
  recordingId: '00000000-0000-4000-8000-000000000000',
  language: 'en',
  model: 'm',
  text: 'Hello there. Bye.',
  segments: [
    { index: 0, start: 0, end: 2.4, text: ' Hello  there. ' },
    { index: 1, start: 3725.5, end: 3727, text: 'A --> B' },
  ],
  gaps: [],
  createdAt: '2026-10-07T10:30:00.000Z',
  ...over,
});

describe('export formats', () => {
  it('writes cue times for SRT and WebVTT', () => {
    expect(cueTime(0, ',')).toBe('00:00:00,000');
    expect(cueTime(3725.5, '.')).toBe('01:02:05.500');
    expect(cueTime(-1, ',')).toBe('00:00:00,000');
  });

  it('numbers SRT cues and keeps each on one line', () => {
    expect(toSrt(transcript())).toBe(
      '1\n00:00:00,000 --> 00:00:02,400\nHello there.\n\n2\n01:02:05,500 --> 01:02:07,000\nA --> B\n',
    );
  });

  it('starts WebVTT with its header and keeps "-->" out of the text', () => {
    const vtt = toVtt(transcript());
    expect(vtt.startsWith('WEBVTT\n\n00:00:00.000 --> 00:00:02.400\nHello there.\n')).toBe(true);
    expect(vtt).toContain('A -> B');
  });

  it('makes one cue from the text when there are no segments', () => {
    expect(toSrt(transcript({ segments: [] }), 90)).toBe(
      '1\n00:00:00,000 --> 00:01:30,000\nHello there. Bye.\n',
    );
    expect(toSrt(transcript({ segments: [], text: '' }))).toBe('');
  });

  it('writes plain text one segment per line', () => {
    expect(toText(transcript())).toBe('Hello there.\nA --> B\n');
  });

  it('writes Markdown with the summary, to-dos, gaps and timestamps', () => {
    const md = toMarkdown(
      {
        title: 'Weekly planning',
        createdAt: '2026-10-07T10:30:00.000Z',
        durationSeconds: 3727,
        sourceUrl: null,
      },
      transcript({ gaps: [{ start: 10, end: 20 }] }),
      { summary: 'We **agreed**.', actionItems: ['Call the landlord'] },
    );
    expect(md).toBe(
      [
        '# Weekly planning',
        '',
        '2026-10-07 · 1:02:07',
        '',
        '## Summary',
        '',
        'We **agreed**.',
        '',
        '## To do',
        '',
        '- [ ] Call the landlord',
        '',
        '## Transcript',
        '',
        '_Not recognized: 0:10–0:20_',
        '',
        '**0:00** Hello there.',
        '',
        '**1:02:05** A --> B',
        '',
      ].join('\n'),
    );
  });

  it('leaves the summary out when there is none', () => {
    const md = toMarkdown(
      {
        title: 'Note',
        createdAt: '2026-10-07T10:30:00.000Z',
        durationSeconds: null,
        sourceUrl: null,
      },
      transcript(),
      null,
      'ru',
    );
    expect(md).not.toContain('## Итоги');
    expect(md).toContain('## Расшифровка');
  });

  it('makes a safe file name from the title', () => {
    expect(exportFileName('Meeting: plan/budget?', 'srt')).toBe('Meeting plan budget.srt');
    expect(exportFileName('..hidden', 'md')).toBe('hidden.md');
    expect(exportFileName('  ', 'txt')).toBe('transcript.txt');
    expect(exportFileName('x'.repeat(300), 'vtt')).toBe(`${'x'.repeat(100)}.vtt`);
  });
});
