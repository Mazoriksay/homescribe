import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { rename, rm, stat, writeFile } from 'node:fs/promises';
import type { CookieStatus } from '@homescribe/shared';
import type { CookieState, Repository } from '../db/repository';
import type { EventBus } from '../events';
import type { MediaDownloader } from '../media/downloader';
import { youtubeCookies } from './netscape';

/** No look-alikes (0/O, 1/I/L). */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 8;
const CODE_TTL_MS = 10 * 60_000;
const CODE_ATTEMPTS = 5;
/** yt-dlp checks hit YouTube; cookies arrive in bursts from the extension. */
const CHECK_INTERVAL_MS = 10 * 60_000;
const DAILY_MS = 24 * 60 * 60_000;
/** Jobs failed for want of cookies this recently are retried once cookies work. */
const RETRY_WINDOW_MS = 24 * 60 * 60_000;
export const COOKIE_FAILURES = ['DOWNLOAD_BLOCKED', 'DOWNLOAD_COOKIES_EXPIRED'] as const;

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const normalizeCode = (code: string) => code.toUpperCase().replace(/[^A-Z0-9]/g, '');

export class PairingError extends Error {}

export interface CookieServiceDeps {
  repo: Repository;
  /** Where yt-dlp reads cookies from (YTDLP_COOKIES_FILE). */
  file: string;
  downloader?: MediaDownloader;
  /** Re-runs recordings that failed for want of cookies (new `process` jobs). */
  retry: (recordingIds: string[]) => void;
  logger: { info(obj: object, msg: string): void };
  now?: () => Date;
}

/** YouTube cookies from the extension or a file, their pairing and their check (SPEC.md §7.8). */
export class CookieService {
  private readonly now: () => Date;
  private checkTimer: NodeJS.Timeout | null = null;
  private dailyTimer: NodeJS.Timeout | null = null;
  private checking: Promise<void> | null = null;
  private lastCheckAt = 0;

  constructor(private readonly deps: CookieServiceDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  status(): CookieStatus {
    const state = this.deps.repo.getCookieState();
    return {
      status: state.status,
      source: state.source,
      updatedAt: state.updatedAt,
      checkedAt: state.checkedAt,
      paired: state.tokenHash !== null,
    };
  }

  /**
   * Adopts a cookies.txt put into the data folder by hand (0.3.1 asked for
   * that) and checks once a day while cookies are stored.
   */
  async start(): Promise<void> {
    const found = await stat(this.deps.file).catch(() => null);
    const { status } = this.deps.repo.getCookieState();
    if (found && status === 'none') {
      this.deps.repo.updateCookieState({
        status: 'unchecked',
        source: 'file',
        updatedAt: found.mtime.toISOString(),
      });
    } else if (!found && status !== 'none') {
      // The file went away; a paired extension stays paired and sends new ones.
      this.deps.repo.updateCookieState({ status: 'none', source: null, checkedAt: null });
    }
    if (this.deps.repo.getCookieState().status !== 'none') this.scheduleCheck();
    this.dailyTimer = setInterval(() => {
      if (this.deps.repo.getCookieState().status !== 'none') void this.check();
    }, DAILY_MS);
    this.dailyTimer.unref();
  }

  async stop(): Promise<void> {
    if (this.dailyTimer) clearInterval(this.dailyTimer);
    if (this.checkTimer) clearTimeout(this.checkTimer);
    await this.checking;
  }

  /** Stores cookies, keeping only youtube.com; throws CookieFormatError. */
  async save(text: string, source: 'extension' | 'file'): Promise<CookieStatus> {
    const { text: clean } = youtubeCookies(text);
    const temp = `${this.deps.file}.tmp`;
    await writeFile(temp, clean, { mode: 0o600 });
    await rename(temp, this.deps.file);
    this.deps.repo.updateCookieState({
      status: 'unchecked',
      source,
      updatedAt: this.now().toISOString(),
    });
    this.scheduleCheck();
    return this.status();
  }

  /** Deletes the cookies and forgets the extension. */
  async remove(): Promise<CookieStatus> {
    await rm(this.deps.file, { force: true });
    this.deps.repo.updateCookieState({
      status: 'none',
      source: null,
      updatedAt: null,
      checkedAt: null,
      tokenHash: null,
      pairingHash: null,
      pairingExpiresAt: null,
      pairingAttempts: 0,
    });
    return this.status();
  }

  /** A new one-time code; replaces any earlier one. */
  createPairing(): { code: string; expiresAt: string } {
    let code = '';
    for (let i = 0; i < CODE_LENGTH; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
    const expiresAt = new Date(this.now().getTime() + CODE_TTL_MS).toISOString();
    this.deps.repo.updateCookieState({
      pairingHash: sha256(code),
      pairingExpiresAt: expiresAt,
      pairingAttempts: 0,
    });
    return { code: `${code.slice(0, 4)}-${code.slice(4)}`, expiresAt };
  }

  /** Exchanges a valid code for a new token, once. Throws PairingError. */
  pair(code: string): string {
    const state = this.deps.repo.getCookieState();
    const usable =
      state.pairingHash !== null &&
      state.pairingExpiresAt !== null &&
      Date.parse(state.pairingExpiresAt) > this.now().getTime() &&
      state.pairingAttempts < CODE_ATTEMPTS;
    if (!usable || !sameHash(sha256(normalizeCode(code)), state.pairingHash!)) {
      if (usable) {
        const attempts = state.pairingAttempts + 1;
        this.deps.repo.updateCookieState(
          attempts >= CODE_ATTEMPTS
            ? { pairingHash: null, pairingExpiresAt: null, pairingAttempts: 0 }
            : { pairingAttempts: attempts },
        );
      }
      throw new PairingError('The code is wrong or has expired; make a new one in the settings');
    }
    const token = randomBytes(32).toString('base64url');
    this.deps.repo.updateCookieState({
      tokenHash: sha256(token),
      pairingHash: null,
      pairingExpiresAt: null,
      pairingAttempts: 0,
    });
    return token;
  }

  verifyToken(token: string): boolean {
    const { tokenHash } = this.deps.repo.getCookieState();
    return tokenHash !== null && token.length > 0 && sameHash(sha256(token), tokenHash);
  }

  /** A job found the cookies stale. */
  markExpired(): void {
    this.update({ status: 'expired', checkedAt: this.now().toISOString() });
  }

  /** Runs a check now, or when the 10-minute slot frees up. */
  scheduleCheck(): void {
    if (this.checkTimer) return;
    const wait = Math.max(0, this.lastCheckAt + CHECK_INTERVAL_MS - this.now().getTime());
    this.checkTimer = setTimeout(() => {
      this.checkTimer = null;
      void this.check();
    }, wait);
    this.checkTimer.unref();
  }

  /** Tries the cookies with yt-dlp; on success re-runs recently blocked recordings. */
  async check(): Promise<void> {
    if (this.checking) return this.checking;
    this.checking = (async () => {
      const { downloader } = this.deps;
      if (!downloader || this.deps.repo.getCookieState().status === 'none') return;
      this.lastCheckAt = this.now().getTime();
      const result = await downloader.checkCookies();
      this.deps.logger.info({ result }, 'checked YouTube cookies');
      if (result === 'unknown') return;
      this.update({
        status: result,
        checkedAt: this.now().toISOString(),
      });
      if (result === 'ok') this.retryBlocked();
    })().finally(() => {
      this.checking = null;
    });
    return this.checking;
  }

  private update(patch: Partial<CookieState>): void {
    // Deleted meanwhile: stay deleted.
    if (this.deps.repo.getCookieState().status === 'none') return;
    this.deps.repo.updateCookieState(patch);
  }

  private retryBlocked(): void {
    const since = new Date(this.now().getTime() - RETRY_WINDOW_MS).toISOString();
    const ids = this.deps.repo.recordingsFailedWith(COOKIE_FAILURES, since);
    if (ids.length > 0) {
      this.deps.logger.info({ count: ids.length }, 'retrying links blocked for want of cookies');
      this.deps.retry(ids);
    }
  }
}

function sameHash(a: string, b: string): boolean {
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  return left.length === right.length && timingSafeEqual(left, right);
}

/** New `process` jobs for recordings that have no job running; wakes the queue. */
export function retryRecordings(
  deps: { repo: Repository; events: EventBus; kick: () => void },
  recordingIds: string[],
): void {
  for (const id of recordingIds) {
    if (deps.repo.activeJob(id)) continue;
    deps.events.emit({ event: 'job', data: deps.repo.createJob(id, 'process') });
  }
  deps.kick();
}
