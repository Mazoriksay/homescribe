/** Largest cookies.txt accepted; a real YouTube export is a few kilobytes. */
export const COOKIES_MAX_BYTES = 256 * 1024;

const HEADER = '# Netscape HTTP Cookie File';
const HTTP_ONLY = '#HttpOnly_';

export class CookieFormatError extends Error {}

const isYoutube = (domain: string) => {
  const host = domain.replace(/^\./, '').toLowerCase();
  return host === 'youtube.com' || host.endsWith('.youtube.com');
};

/**
 * Keeps only the `youtube.com` lines of a Netscape cookies.txt (the format
 * yt-dlp's `--cookies` reads: domain, subdomains flag, path, secure flag,
 * expiry, name, value, tab-separated; `#HttpOnly_` marks HttpOnly cookies).
 * Throws CookieFormatError when nothing usable is left.
 */
export function youtubeCookies(text: string): { text: string; count: number } {
  if (Buffer.byteLength(text) > COOKIES_MAX_BYTES) {
    throw new CookieFormatError('The cookies file is too large');
  }
  const kept: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (!line || (line.startsWith('#') && !line.startsWith(HTTP_ONLY))) continue;
    const fields = line.split('\t');
    if (fields.length !== 7) continue;
    const domain = fields[0]!.startsWith(HTTP_ONLY)
      ? fields[0]!.slice(HTTP_ONLY.length)
      : fields[0]!;
    const [, subdomains, , secure, expires, name] = fields;
    if (!isYoutube(domain)) continue;
    if (!/^(TRUE|FALSE)$/.test(subdomains!) || !/^(TRUE|FALSE)$/.test(secure!)) continue;
    if (!/^\d+$/.test(expires!) || !name) continue;
    kept.push(line);
  }
  if (kept.length === 0) {
    throw new CookieFormatError('No youtube.com cookies found; export them in Netscape format');
  }
  return { text: [HEADER, '', ...kept, ''].join('\n'), count: kept.length };
}
