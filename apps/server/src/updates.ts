import type { UpdateStatus } from '@homescribe/shared';
import { httpRequest, withTimeout } from './ai/http';

const TIMEOUT_MS = 10_000;

export interface UpdateCheckOptions {
  /** owner/name on GitHub; null turns the check off. */
  repo: string | null;
  version: string;
  commit: string | null;
  /** GitHub's API; a fake in tests. */
  apiBase?: string;
}

const RELEASE = /^v?(\d+)\.(\d+)\.(\d+)$/;

function newer(a: string, b: string): boolean {
  const x = RELEASE.exec(a)!.slice(1).map(Number);
  const y = RELEASE.exec(b)!.slice(1).map(Number);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i]! > y[i]!;
  return false;
}

async function github(apiBase: string, path: string): Promise<unknown> {
  const timer = withTimeout(TIMEOUT_MS);
  const { status, body } = await httpRequest(new URL(`${apiBase}${path}`), {
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'homescribe' },
    signal: timer.signal,
    limit: 2 * 1024 * 1024,
  });
  if (status < 200 || status >= 300) throw new Error(`HTTP ${status}`);
  return JSON.parse(body) as unknown;
}

/**
 * Compares this build with GitHub (SPEC.md §7.9): a release image with the
 * latest release, a `latest` image (built from main) by its commit. Only
 * runs when asked; nothing is sent but the public API request.
 */
export async function checkForUpdates(options: UpdateCheckOptions): Promise<UpdateStatus> {
  const apiBase = options.apiBase ?? 'https://api.github.com';
  const current = { version: options.version, commit: options.commit };
  const none = { latest: null, behind: null, updateAvailable: null };
  if (!options.repo) return { current, ...none, error: 'off' };
  try {
    // 0.0.0 is the default of a build without a release tag.
    if (RELEASE.test(options.version) && options.version !== '0.0.0') {
      const release = (await github(apiBase, `/repos/${options.repo}/releases/latest`)) as {
        tag_name: string;
        published_at?: string;
      };
      const latest = { ref: release.tag_name, date: release.published_at ?? null };
      if (!RELEASE.test(release.tag_name)) return { current, ...none, latest, error: null };
      return {
        current,
        latest,
        behind: null,
        updateAvailable: newer(release.tag_name, options.version),
        error: null,
      };
    }
    if (!options.commit) return { current, ...none, error: 'unknown_build' };
    const compare = (await github(
      apiBase,
      `/repos/${options.repo}/compare/${options.commit}...main`,
    )) as {
      ahead_by: number;
      commits: { sha: string; commit: { committer?: { date?: string } } }[];
    };
    const head = compare.commits.at(-1);
    return {
      current,
      latest: head
        ? { ref: head.sha.slice(0, 7), date: head.commit.committer?.date ?? null }
        : { ref: options.commit.slice(0, 7), date: null },
      behind: compare.ahead_by,
      updateAvailable: compare.ahead_by > 0,
      error: null,
    };
  } catch {
    return { current, ...none, error: 'unreachable' };
  }
}
