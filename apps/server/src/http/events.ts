import type { ServerResponse } from 'node:http';
import { API_PREFIX } from '@homescribe/shared';
import type { FastifyInstance } from 'fastify';
import type { EventBus } from '../events';

const PING_INTERVAL_MS = 15_000;

/** `GET /api/v1/events`: Server-Sent Events stream of job changes (SPEC.md §7.4). */
export function registerEventRoutes(app: FastifyInstance, events: EventBus): void {
  const open = new Set<ServerResponse>();

  app.get(`${API_PREFIX}/events`, (request, reply) => {
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write('retry: 3000\n\n');
    open.add(res);

    const unsubscribe = events.subscribe(({ event, data }) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    });
    const ping = setInterval(() => res.write(': ping\n\n'), PING_INTERVAL_MS);

    request.raw.on('close', () => {
      clearInterval(ping);
      unsubscribe();
      open.delete(res);
    });
  });

  // Hijacked responses would keep the server from closing.
  app.addHook('preClose', (done) => {
    for (const res of open) res.end();
    done();
  });
}
