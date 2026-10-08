/** Formats a position in seconds as `m:ss`, or `h:mm:ss` from one hour on. */
export function formatTimestamp(seconds: number): string {
  const total = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** How many identical segments in a row count as a Whisper loop. */
export const REPEAT_LIMIT = 3;

const repeatKey = (text: string) =>
  text
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

/**
 * Whisper sometimes gets stuck and repeats one phrase for minutes (a known
 * failure on long or quiet audio). Finds every run of `REPEAT_LIMIT` or more
 * identical segments as `[from, to)` index ranges; shorter runs are left
 * alone, since people do repeat themselves.
 */
export function findRepeatRuns(segments: readonly { text: string }[]): [number, number][] {
  const runs: [number, number][] = [];
  for (let i = 0; i < segments.length;) {
    let j = i + 1;
    while (j < segments.length && repeatKey(segments[j]!.text) === repeatKey(segments[i]!.text)) {
      j++;
    }
    if (j - i >= REPEAT_LIMIT) runs.push([i, j]);
    i = j;
  }
  return runs;
}

/** Keeps the first segment of every run found by `findRepeatRuns`. */
export function collapseRepeatedSegments<T extends { text: string }>(segments: T[]): T[] {
  const drop = new Set<number>();
  for (const [from, to] of findRepeatRuns(segments)) {
    for (let k = from + 1; k < to; k++) drop.add(k);
  }
  return segments.filter((_, index) => !drop.has(index));
}
