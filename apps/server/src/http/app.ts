import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import fastifyMultipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { API_PREFIX } from '@homescribe/shared';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Config } from '../config';
import type { Repository } from '../db/repository';
import type { EventBus } from '../events';
import type { JobRunner } from '../jobs/runner';
import { createNetworkAllowList } from '../network';
import type { MediaStore } from '../storage';
import { registerAiRoutes, type AiRouteDeps } from './ai';
import { errorBody, errorHandler } from './errors';
import { registerEventRoutes } from './events';
import { registerRecordingRoutes } from './recordings';
import { registerSearchRoutes } from './search';

export interface AppDeps extends AiRouteDeps {
  config: Config;
  repo: Repository;
  store: MediaStore;
  runner: JobRunner;
  events: EventBus;
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const { config } = deps;
  const app = Fastify({
    logger: { level: config.logLevel },
    // Never derive the client address from X-Forwarded-For (SPEC.md §10).
    trustProxy: false,
    forceCloseConnections: true,
  });

  const isAllowed = createNetworkAllowList(config.allowedNetworks);
  // Everything is same-origin; Ant Design injects <style> tags, hence 'unsafe-inline' for
  // styles. Only FRAME_ANCESTORS may embed the UI (e.g. a home dashboard), SPEC.md §10.
  const csp = [
    "default-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    ["frame-ancestors 'self'", ...config.frameAncestors].join(' '),
  ].join('; ');
  app.addHook('onRequest', async (request, reply) => {
    if (!isAllowed(request.socket.remoteAddress)) {
      return reply
        .status(403)
        .send(
          errorBody(
            'NETWORK_NOT_ALLOWED',
            'This server only accepts clients from its local network',
          ),
        );
    }
  });
  app.addHook('onSend', async (_request, reply) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'no-referrer');
    // Routes may send a stricter policy (media files are sandboxed).
    if (!reply.hasHeader('content-security-policy')) reply.header('content-security-policy', csp);
  });

  app.setErrorHandler(errorHandler);

  await app.register(fastifyMultipart);

  app.get(`${API_PREFIX}/health`, async () => ({
    status: 'ok' as const,
    search: deps.repo.search.mode,
  }));
  registerRecordingRoutes(app, deps);
  registerSearchRoutes(app, deps.repo);
  registerAiRoutes(app, deps);
  registerEventRoutes(app, deps.events);

  const hasWeb = existsSync(path.join(config.webDistDir, 'index.html'));
  if (hasWeb) {
    await app.register(fastifyStatic, {
      root: config.webDistDir,
      setHeaders: (reply, filePath) => {
        // Vite fingerprints everything under assets/; the shell must revalidate.
        reply.header(
          'cache-control',
          filePath.includes(`${path.sep}assets${path.sep}`)
            ? 'public, max-age=31536000, immutable'
            : 'no-cache',
        );
      },
    });
  } else {
    app.log.warn({ webDistDir: config.webDistDir }, 'web UI not built; serving the API only');
    // Still needed for reply.sendFile (recording media).
    await mkdir(deps.store.root, { recursive: true });
    await app.register(fastifyStatic, { root: deps.store.root, serve: false });
  }

  app.setNotFoundHandler((request, reply) => {
    const isApi = request.url === '/api' || request.url.startsWith('/api/');
    if (hasWeb && request.method === 'GET' && !isApi) {
      // Client-side routes: let the SPA handle them.
      return reply.header('cache-control', 'no-cache').sendFile('index.html');
    }
    return reply.status(404).send(errorBody('NOT_FOUND', 'Route not found'));
  });

  return app;
}
