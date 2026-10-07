import { lookup } from 'node:dns/promises';
import net from 'node:net';
import { localServerPorts, type AiModel, type Discovery } from '@homescribe/shared';
import { listModels } from './models';

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

export interface DiscoveryOptions {
  hosts: readonly string[];
  /** This server's own port; skipped on loopback hosts so it does not find itself. */
  selfPort: number;
  timeoutMs?: number;
  ports?: readonly { port: number; product: string }[];
  list?: (baseUrl: string) => Promise<AiModel[]>;
  /** Address to probe for a host name, or null when it does not resolve. */
  resolve?: (host: string, timeoutMs: number) => Promise<string | null>;
}

/**
 * One lookup per host, IPv4 first. Docker Desktop gives host.docker.internal
 * an IPv6 address the container may not route, and a name that does not
 * resolve (an `ollama` service that is not running) can hold Node's few DNS
 * threads for seconds: per-port lookups would then run out of time.
 */
export async function resolveHost(host: string, timeoutMs: number): Promise<string | null> {
  const bare = host.replace(/^\[|\]$/g, '');
  if (net.isIP(bare)) return host;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
  });
  try {
    const addresses = await Promise.race([lookup(bare, { all: true }).catch(() => null), timeout]);
    const best = addresses?.find((a) => a.family === 4) ?? addresses?.[0];
    if (!best) return null;
    return best.family === 6 ? `[${best.address}]` : best.address;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Looks for OpenAI-compatible AI servers on well-known ports of the given
 * hosts (this machine by default; more via AI_DISCOVERY_HOSTS). Only a fixed
 * list of addresses is probed, never a whole network. Servers are reported
 * by host name, which is what the settings keep.
 */
export async function discoverServers(options: DiscoveryOptions): Promise<Discovery> {
  const ports = options.ports ?? localServerPorts;
  const timeoutMs = options.timeoutMs ?? 1500;
  const list = options.list ?? ((baseUrl) => listModels(baseUrl, null, timeoutMs));
  const resolve = options.resolve ?? resolveHost;

  const candidates = options.hosts.flatMap((host) =>
    ports
      .filter(({ port }) => !(LOOPBACK.has(host) && port === options.selfPort))
      .map(({ port, product }) => ({ host, port, product })),
  );
  const addresses = new Map(
    await Promise.all(
      [...new Set(candidates.map((c) => c.host))].map(
        async (host) => [host, await resolve(host, timeoutMs)] as const,
      ),
    ),
  );

  const results = await Promise.all(
    candidates.map(async ({ host, port, product }) => {
      const address = addresses.get(host);
      if (!address) return null;
      try {
        const models = await list(`http://${address}:${port}`);
        return { baseUrl: `http://${host}:${port}`, product, models };
      } catch {
        return null;
      }
    }),
  );

  return {
    servers: results.filter((server) => server !== null),
    probed: candidates.map(({ host, port }) => `http://${host}:${port}`),
  };
}
