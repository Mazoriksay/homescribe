import { z } from 'zod';
import type { Recording, Segment, Summary, Transcript } from './api';
import { formatTimestamp } from './format';

/** Download formats of a transcript (SPEC.md §7.3). */
export const exportFormats = ['srt', 'vtt', 'txt', 'md'] as const;
export type ExportFormat = (typeof exportFormats)[number];

export const exportQuerySchema = z.object({
  format: z.enum(exportFormats),
  /** Language of the Markdown headings; the transcript itself is never translated. */
  lang: z.enum(['en', 'ru']).default('en'),
});
export type ExportQuery = z.infer<typeof exportQuerySchema>;

export const exportMediaTypes: Record<ExportFormat, string> = {
  srt: 'application/x-subrip; charset=utf-8',
  vtt: 'text/vtt; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  md: 'text/markdown; charset=utf-8',
};

/** "01:02:03,450" (SRT) or "01:02:03.450" (WebVTT). */
export function cueTime(seconds: number, separator: ',' | '.'): string {
  const ms = Math.max(0, Math.round((Number.isFinite(seconds) ? seconds : 0) * 1000));
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const pad = (n: number, width = 2) => String(n).padStart(width, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)}${separator}${pad(ms % 1000, 3)}`;
}

/**
 * The cues of a transcript: its segments, or the whole text as one cue
 * when the server returned no segments. A cue never ends before it starts.
 */
function cues(transcript: Transcript, duration: number | null): Segment[] {
  const segments = transcript.segments.filter((s) => s.text.trim().length > 0);
  if (segments.length > 0) return segments;
  const text = transcript.text.trim();
  return text ? [{ index: 0, start: 0, end: Math.max(duration ?? 0, 1), text }] : [];
}

const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim();

export function toSrt(transcript: Transcript, duration: number | null = null): string {
  return cues(transcript, duration)
    .map(
      (cue, i) =>
        `${i + 1}\n${cueTime(cue.start, ',')} --> ${cueTime(Math.max(cue.end, cue.start), ',')}\n${oneLine(cue.text)}\n`,
    )
    .join('\n');
}

export function toVtt(transcript: Transcript, duration: number | null = null): string {
  const body = cues(transcript, duration)
    // "-->" inside a cue would end its text early in some players.
    .map(
      (cue) =>
        `${cueTime(cue.start, '.')} --> ${cueTime(Math.max(cue.end, cue.start), '.')}\n${oneLine(cue.text).replaceAll('-->', '->')}\n`,
    )
    .join('\n');
  return `WEBVTT\n\n${body}`;
}

/** One line per segment, as "Copy text" does. */
export function toText(transcript: Transcript): string {
  const lines = transcript.segments.map((s) => oneLine(s.text)).filter(Boolean);
  return `${lines.length > 0 ? lines.join('\n') : transcript.text.trim()}\n`;
}

const headings = {
  en: { summary: 'Summary', todo: 'To do', transcript: 'Transcript', gaps: 'Not recognized' },
  ru: { summary: 'Итоги', todo: 'Задачи', transcript: 'Расшифровка', gaps: 'Не распознано' },
} as const;

/** Title, summary, to-dos and the transcript with timestamps, for notes apps. */
export function toMarkdown(
  recording: Pick<Recording, 'title' | 'createdAt' | 'durationSeconds' | 'sourceUrl'>,
  transcript: Transcript,
  summary: Pick<Summary, 'summary' | 'actionItems'> | null,
  lang: 'en' | 'ru' = 'en',
): string {
  const h = headings[lang];
  const facts = [
    recording.createdAt.slice(0, 10),
    recording.durationSeconds !== null ? formatTimestamp(recording.durationSeconds) : null,
    recording.sourceUrl,
  ].filter(Boolean);
  const out = [`# ${oneLine(recording.title)}`, '', facts.join(' · '), ''];
  if (summary) {
    out.push(`## ${h.summary}`, '', summary.summary.trim(), '');
    if (summary.actionItems.length > 0) {
      out.push(
        `## ${h.todo}`,
        '',
        ...summary.actionItems.map((item) => `- [ ] ${oneLine(item)}`),
        '',
      );
    }
  }
  out.push(`## ${h.transcript}`, '');
  if (transcript.gaps.length > 0) {
    const ranges = transcript.gaps.map(
      (g) => `${formatTimestamp(g.start)}–${formatTimestamp(g.end)}`,
    );
    out.push(`_${h.gaps}: ${ranges.join(', ')}_`, '');
  }
  if (transcript.segments.length > 0) {
    for (const s of transcript.segments) {
      const text = oneLine(s.text);
      if (text) out.push(`**${formatTimestamp(s.start)}** ${text}`, '');
    }
  } else if (transcript.text.trim()) {
    out.push(transcript.text.trim(), '');
  }
  return `${out.join('\n').trimEnd()}\n`;
}

/** A file name from the title: no path or reserved characters, at most 100 characters. */
export function exportFileName(title: string, format: ExportFormat): string {
  const base =
    title
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001f\u007f/\\:*?"<>|]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/^\.+/, '')
      .slice(0, 100)
      .trim() || 'transcript';
  return `${base}.${format}`;
}
