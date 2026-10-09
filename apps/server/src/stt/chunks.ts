import { collapseRepeatedSegments, findRepeatRuns, type TranscriptGap } from '@homescribe/shared';
import type { Silence } from '../media/media-tool';
import type { Transcriber, TranscriptionResult } from './transcriber';

/** A part of the recording sent to the STT server on its own, in seconds. */
export interface Chunk {
  start: number;
  end: number;
}

export interface ChunkPlan {
  /** Preferred chunk length. */
  target: number;
  /** How far from the target a cut may move to land in a pause. */
  slack: number;
}

/**
 * Splits a recording into chunks of about `target` seconds, cutting in the
 * middle of a pause near each target point, or at the target when there is
 * none. Whisper conditions on its own previous text, so a loop runs to the
 * end of the request; separate requests keep it inside one chunk.
 */
export function planChunks(
  duration: number,
  silences: readonly Silence[],
  plan: ChunkPlan = { target: 60, slack: 15 },
): Chunk[] {
  const { target, slack } = plan;
  if (duration <= target + slack) return [{ start: 0, end: duration }];
  const chunks: Chunk[] = [];
  let start = 0;
  while (duration - start > target + slack) {
    const ideal = start + target;
    let cut = ideal;
    let best = Infinity;
    for (const silence of silences) {
      const middle = (silence.start + silence.end) / 2;
      const distance = Math.abs(middle - ideal);
      if (distance <= slack && distance < best) {
        best = distance;
        cut = middle;
      }
    }
    chunks.push({ start, end: cut });
    start = cut;
  }
  chunks.push({ start, end: duration });
  return chunks;
}

/**
 * Lines Whisper invents over silence or music, learned from subtitle credits
 * in its training data. A segment that is only one of these is dropped; the
 * same words inside real speech stay.
 */
// \b only knows Latin letters, so Cyrillic words end at a space or the end.
const HALLUCINATIONS = [
  /^продолжение следует$/,
  /^субтитры (создавал|сделал|подготовил|делал)( |$)/,
  /^редактор субтитров( |$)/,
  /^корректор .*субтитр/,
  /^thanks? (you )?for watching$/,
  /^subtitles by\b/,
  /amara\.org/,
];

export function isHallucination(text: string): boolean {
  const plain = text
    .toLowerCase()
    .replace(/[.!?…"«»]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return HALLUCINATIONS.some((pattern) => pattern.test(plain));
}

/** Temperature of the retry when Whisper looped at the default of 0. */
export const RETRY_TEMPERATURE = 0.4;

export interface ChunkResult {
  language: string | null;
  text: string;
  /** Absolute times, within the chunk. */
  segments: TranscriptionResult['segments'];
  gaps: TranscriptGap[];
}

const repeated = (runs: [number, number][]) => runs.reduce((n, [from, to]) => n + to - from, 0);

/** Looped stretches shorter than this are not worth another request. */
const RELISTEN_MIN_SECONDS = 3;
/** At most this many stretches of one chunk are asked again. */
const RELISTEN_LIMIT = 3;

export interface ChunkOptions {
  language: string | null;
  signal?: AbortSignal;
  /**
   * Cuts a stretch of the recording (absolute seconds) into a file of its
   * own for `use` and removes it afterwards. Without it a loop stays a gap.
   */
  relisten?: <T>(range: Chunk, use: (file: string) => Promise<T>) => Promise<T>;
}

/**
 * Transcribes one chunk. When Whisper loops, the chunk is asked again at a
 * higher temperature and the result with fewer repeats is kept; a loop that
 * remains is cut to its first segment and reported as a gap (the speech
 * there is lost), from the end of that segment to the next real one.
 *
 * A loop is often speech in another language: with the recording's language
 * forced on it Whisper writes a few words over and over. So each looped
 * stretch is cut out and asked once more with no language set; when Whisper
 * then hears another language and does not loop, that text fills the gap.
 */
export async function transcribeChunk(
  transcriber: Transcriber,
  file: string,
  chunk: Chunk,
  options: ChunkOptions,
): Promise<ChunkResult> {
  const { language, signal, relisten } = options;
  let result = await transcriber.transcribe(file, signal, { language });
  let runs = findRepeatRuns(result.segments);
  if (runs.length > 0) {
    const retry = await transcriber.transcribe(file, signal, {
      language,
      temperature: RETRY_TEMPERATURE,
    });
    const retryRuns = findRepeatRuns(retry.segments);
    if (repeated(retryRuns) < repeated(runs)) {
      result = retry;
      runs = retryRuns;
    }
  }

  const length = chunk.end - chunk.start;
  const { segments } = result;
  const limit = Number.isFinite(length) ? length : (segments.at(-1)?.end ?? 0);
  let gaps = runs.map(([from, to]) => ({
    start: chunk.start + Math.min(segments[from]!.end, limit),
    end: chunk.start + (to < segments.length ? Math.min(segments[to]!.start, limit) : limit),
  }));
  // Whisper can place its last segments past the end of the audio.
  let kept = collapseRepeatedSegments(segments)
    .filter((s) => s.start < limit && !isHallucination(s.text))
    .map((s) => ({
      start: chunk.start + s.start,
      end: chunk.start + Math.min(s.end, limit),
      text: s.text,
    }));

  if (relisten) {
    for (const [index, [from]] of runs.slice(0, RELISTEN_LIMIT).entries()) {
      const gap = gaps[index]!;
      // From the first looped segment: it belongs to the same stretch.
      const range = { start: chunk.start + Math.min(segments[from]!.start, limit), end: gap.end };
      if (range.end - range.start < RELISTEN_MIN_SECONDS) continue;
      const again = await relisten(range, (part) => transcriber.transcribe(part, signal));
      const heard = again.segments.filter((s) => !isHallucination(s.text));
      const otherLanguage = again.language !== null && again.language !== result.language;
      if (!otherLanguage || heard.length === 0 || findRepeatRuns(heard).length > 0) continue;
      const length = range.end - range.start;
      kept = kept
        .filter((s) => s.start < range.start || s.start >= range.end)
        .concat(
          heard
            .filter((s) => s.start < length)
            .map((s) => ({
              start: range.start + s.start,
              end: range.start + Math.min(s.end, length),
              text: s.text,
            })),
        )
        .sort((a, b) => a.start - b.start);
      gap.end = gap.start;
    }
  }
  gaps = gaps.filter((gap) => gap.end > gap.start);

  return {
    language: result.language,
    text:
      runs.length > 0 || segments.length !== kept.length
        ? kept.map((s) => s.text).join(' ')
        : result.text,
    segments: kept,
    gaps,
  };
}
