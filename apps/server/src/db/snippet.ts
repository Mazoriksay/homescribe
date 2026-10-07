import type { Snippet } from '@homescribe/shared';

/** Splits a search query into lower-cased terms. */
export function searchTerms(query: string): string[] {
  return [
    ...new Set(
      query
        .toLowerCase()
        .split(/\s+/)
        .map((term) => term.replace(/^["'«(]+|["'»).,!?;:]+$/g, ''))
        .filter(Boolean),
    ),
  ].slice(0, 10);
}

/**
 * A window of `text` around the first occurrence of any term, split into
 * matching and plain parts. Without a match, the start of the text.
 */
export function buildSnippet(text: string, terms: string[], width = 160): Snippet {
  const lower = text.toLowerCase();
  const sameLength = lower.length === text.length;
  let first = -1;
  for (const term of terms) {
    const at = lower.indexOf(term);
    if (at !== -1 && (first === -1 || at < first)) first = at;
  }

  let start = first === -1 ? 0 : Math.max(0, first - Math.floor(width / 3));
  let end = Math.min(text.length, start + width);
  // Avoid cutting words in half where possible.
  if (start > 0) {
    const space = text.indexOf(' ', start);
    if (space !== -1 && space < (first === -1 ? end : first)) start = space + 1;
  }
  if (end < text.length) {
    const space = text.lastIndexOf(' ', end);
    if (space > start) end = space;
  }

  const window = text.slice(start, end);
  const windowLower = sameLength ? lower.slice(start, end) : window.toLowerCase();
  const marks = new Array<boolean>(window.length).fill(false);
  if (windowLower.length === window.length) {
    for (const term of terms) {
      for (let at = windowLower.indexOf(term); at !== -1; at = windowLower.indexOf(term, at + 1)) {
        marks.fill(true, at, at + term.length);
      }
    }
  }

  const parts: Snippet = [];
  if (start > 0) parts.push({ text: '…', match: false });
  for (let i = 0; i < window.length;) {
    let j = i;
    while (j < window.length && marks[j] === marks[i]) j++;
    parts.push({ text: window.slice(i, j), match: marks[i]! });
    i = j;
  }
  if (end < text.length) parts.push({ text: '…', match: false });
  return parts;
}
