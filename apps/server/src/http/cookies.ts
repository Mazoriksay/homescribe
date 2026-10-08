import { API_PREFIX, EXTENSION_ID, pairBodySchema } from '@homescribe/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Config } from '../config';
import { extensionZip } from '../cookies/extension-zip';
import { CookieFormatError } from '../cookies/netscape';
import { PairingError, type CookieService } from '../cookies/service';
import { AppError, parseInput } from './errors';

const bodyText = (request: FastifyRequest) => {
  if (typeof request.body !== 'string') {
    throw new AppError(400, 'VALIDATION_ERROR', 'Send the cookies as text/plain');
  }
  return request.body;
};

const bearer = (request: FastifyRequest) =>
  /^Bearer (\S+)$/.exec(request.headers.authorization ?? '')?.[1] ?? '';

/**
 * YouTube cookies (SPEC.md §7.8). Cookie values and tokens are never part
 * of an answer and never logged (Fastify logs method, URL and status only).
 */
export function registerCookieRoutes(
  app: FastifyInstance,
  deps: { cookies: CookieService; config: Config },
): void {
  const { cookies } = deps;
  const save = async (text: string, source: 'extension' | 'file') => {
    try {
      return await cookies.save(text, source);
    } catch (error) {
      if (error instanceof CookieFormatError) {
        throw new AppError(400, 'VALIDATION_ERROR', error.message);
      }
      throw error;
    }
  };

  app.get(`${API_PREFIX}/cookies`, async () => cookies.status());

  app.put(`${API_PREFIX}/cookies/file`, async (request) => save(bodyText(request), 'file'));

  app.delete(`${API_PREFIX}/cookies`, async () => cookies.remove());

  app.post(`${API_PREFIX}/cookies/pairing`, async () => ({
    ...cookies.createPairing(),
    extensionId: EXTENSION_ID,
    extensionFolder: deps.config.extensionFolder,
  }));

  app.post(`${API_PREFIX}/cookies/pair`, async (request) => {
    const { code } = parseInput(pairBodySchema, request.body ?? {}, 'body');
    try {
      return { token: cookies.pair(code) };
    } catch (error) {
      if (error instanceof PairingError) throw new AppError(400, 'PAIRING_INVALID', error.message);
      throw error;
    }
  });

  // From the extension; without the token anyone on the LAN could swap the account.
  app.put(`${API_PREFIX}/cookies`, async (request) => {
    if (!cookies.verifyToken(bearer(request))) {
      throw new AppError(401, 'TOKEN_INVALID', 'Pair the extension again in the settings');
    }
    return save(bodyText(request), 'extension');
  });

  // ?browser=firefox: the Firefox build; anything else gets the Chromium one.
  app.get(`${API_PREFIX}/extension.zip`, async (request, reply) => {
    const { browser } = request.query as { browser?: string };
    const firefox = browser === 'firefox';
    return reply
      .header('content-type', 'application/zip')
      .header(
        'content-disposition',
        `attachment; filename="homescribe-extension${firefox ? '-firefox' : ''}.zip"`,
      )
      .send(
        await extensionZip(
          deps.config.extensionDir,
          deps.config.version,
          firefox ? 'firefox' : 'chromium',
        ),
      );
  });
}
