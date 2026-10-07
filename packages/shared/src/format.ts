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

/**
 * Whisper sometimes gets stuck and repeats one phrase for minutes (a known
 * failure on long or quiet audio). Keeps the first segment of every run of
 * `REPEAT_LIMIT` or more identical segments and drops the rest; shorter runs
 * stay, since people do repeat themselves.
 */
export function collapseRepeatedSegments<T extends { text: string }>(segments: T[]): T[] {
  const key = (text: string) =>
    text
      .toLocaleLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .trim();
  const result: T[] = [];
  for (let i = 0; i < segments.length;) {
    let j = i + 1;
    while (j < segments.length && key(segments[j]!.text) === key(segments[i]!.text)) j++;
    if (j - i >= REPEAT_LIMIT) result.push(segments[i]!);
    else result.push(...segments.slice(i, j));
    i = j;
  }
  return result;
}
