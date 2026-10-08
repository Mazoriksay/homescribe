import http from 'node:http';
import https from 'node:https';
import { Readable } from 'node:stream';

const DEFAULT_RESPONSE_LIMIT = 64 * 1024 * 1024;

export interface HttpResult {
  status: number;
  body: string;
  headers: http.IncomingHttpHeaders;
}

export interface HttpOptions {
  method?: 'GET' | 'POST' | 'DELETE';
  headers?: Record<string, string>;
  body?: string | Readable;
  signal?: AbortSignal;
  /** Largest accepted response body in bytes. */
  limit?: number;
}

/**
 * Minimal HTTP client for AI backends. node:http instead of fetch because
 * fetch gives up after 300 s without response headers, and a long
 * transcription or summary sends nothing until it is done.
 */
export function httpRequest(url: URL, options: HttpOptions = {}): Promise<HttpResult> {
  const client = url.protocol === 'https:' ? https : http;
  const limit = options.limit ?? DEFAULT_RESPONSE_LIMIT;
  return new Promise((resolve, reject) => {
    const req = client.request(
      url,
      { method: options.method ?? 'GET', headers: options.headers, signal: options.signal },
      (res) => {
        let size = 0;
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > limit) {
            req.destroy(new Error('Response too large'));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8'),
            headers: res.headers,
          }),
        );
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    const { body } = options;
    if (body instanceof Readable) {
      body.on('error', (error) => req.destroy(error));
      body.pipe(req);
    } else {
      req.end(body);
    }
  });
}

export function authHeaders(apiKey: string | null | undefined): Record<string, string> {
  return apiKey ? { authorization: `Bearer ${apiKey}` } : {};
}

/** Combines a caller's signal with a timeout; tells which one fired. */
export function withTimeout(timeoutMs: number, signal?: AbortSignal) {
  const timeout = AbortSignal.timeout(timeoutMs);
  return {
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    timedOut: () => timeout.aborted,
  };
}
