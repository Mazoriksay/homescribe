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
}

/**
 * Looks for OpenAI-compatible AI servers on well-known ports of the given
 * hosts (this machine by default; more via AI_DISCOVERY_HOSTS). Only a fixed
 * list of addresses is probed, never a whole network.
 */
export async function discoverServers(options: DiscoveryOptions): Promise<Discovery> {
  const ports = options.ports ?? localServerPorts;
  const timeoutMs = options.timeoutMs ?? 1500;
  const list = options.list ?? ((baseUrl) => listModels(baseUrl, null, timeoutMs));

  const candidates = options.hosts.flatMap((host) =>
    ports
      .filter(({ port }) => !(LOOPBACK.has(host) && port === options.selfPort))
      .map(({ port, product }) => ({ baseUrl: `http://${host}:${port}`, product })),
  );

  const results = await Promise.all(
    candidates.map(async ({ baseUrl, product }) => {
      try {
        return { baseUrl, product, models: await list(baseUrl) };
      } catch {
        return null;
      }
    }),
  );

  return {
    servers: results.filter((server) => server !== null),
    probed: candidates.map((candidate) => candidate.baseUrl),
  };
}
