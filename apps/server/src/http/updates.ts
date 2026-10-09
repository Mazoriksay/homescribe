import { API_PREFIX } from '@homescribe/shared';
import type { FastifyInstance } from 'fastify';
import type { Config } from '../config';
import { checkForUpdates } from '../updates';

/** "Check for updates" in the settings (SPEC.md §7.9). */
export function registerUpdateRoutes(
  app: FastifyInstance,
  deps: { config: Config; githubApi?: string },
): void {
  app.get(`${API_PREFIX}/updates`, async () =>
    checkForUpdates({
      repo: deps.config.updates.repo,
      version: deps.config.version,
      commit: deps.config.updates.commit,
      apiBase: deps.githubApi,
    }),
  );
}
