import type { TranscriptionResult } from './transcriber';

/** A word with its times, as speaches returns it: the text keeps its leading space. */
export interface TimedWord {
  start: number;
  end: number;
  word: string;
}

export interface SentenceOptions {
  /** A segment longer than this is cut even without a sentence end. */
  maxSeconds?: number;
  /** A silence this long ends a segment when the text has no punctuation. */
  pauseSeconds?: number;
}

const SENTENCE_END = /[.!?…]+["»”')\]]*$/;
const CLAUSE_END = /[,;:—–-]["»”')\]]*$/;
/** "т.", "г.", "A." are abbreviations and initials, not sentence ends. */
const ABBREVIATION = /^["«“'([]*\p{L}{1,2}\.$/u;
const STARTS_SENTENCE = /^["«“'([]*[\p{Lu}\p{N}]/u;

/**
 * Groups timed words into sentence-sized segments.
 *
 * A batched speaches returns one segment per 30-second window, which is too
 * coarse to click or to land a search hit on (SPEC.md §7.5). Words are cut
 * after sentence punctuation, at a long pause, and at `maxSeconds`, there
 * preferably after a comma or at the widest pause.
 */
export function segmentsFromWords(
  words: readonly TimedWord[],
  options: SentenceOptions = {},
): TranscriptionResult['segments'] {
  const maxSeconds = options.maxSeconds ?? 15;
  const pauseSeconds = options.pauseSeconds ?? 0.8;
  const clean = words
    .map((w) => ({ start: Math.max(0, w.start), end: Math.max(0, w.end), word: w.word }))
    .filter((w) => w.word.trim().length > 0);
  const segments: TranscriptionResult['segments'] = [];
  let from = 0;

  const close = (to: number) => {
    const part = clean.slice(from, to);
    const text = part
      .map((w) => w.word)
      .join('')
      .replace(/\s+/g, ' ')
      .trim();
    if (text) segments.push({ start: part[0]!.start, end: part.at(-1)!.end, text });
    from = to;
  };

  for (let i = 0; i < clean.length; i++) {
    const word = clean[i]!;
    const next = clean[i + 1];
    if (!next) break;
    const text = word.word.trim();
    const pause = next.start - word.end;
    const sentenceEnd =
      SENTENCE_END.test(text) &&
      !ABBREVIATION.test(text) &&
      (STARTS_SENTENCE.test(next.word.trim()) || pause >= 0.3);
    if (sentenceEnd || pause >= pauseSeconds) {
      close(i + 1);
      continue;
    }
    if (next.end - clean[from]!.start <= maxSeconds) continue;
    // Too long: cut after the latest clause end in the second half, else at
    // the widest pause there, else right here.
    const half = clean[from]!.start + maxSeconds / 2;
    let cut = i + 1;
    let widest = 0;
    let clause = -1;
    for (let k = from; k <= i; k++) {
      if (clean[k]!.end < half) continue;
      if (CLAUSE_END.test(clean[k]!.word.trim())) clause = k + 1;
      const gap = clean[k + 1]!.start - clean[k]!.end;
      if (gap > widest) {
        widest = gap;
        cut = k + 1;
      }
    }
    close(clause !== -1 ? clause : cut);
  }
  close(clean.length);
  return segments;
}
