import { API_PREFIX, searchQuerySchema, type SearchHit } from '@homescribe/shared';
import type { FastifyInstance } from 'fastify';
import type { Repository } from '../db/repository';
import { buildSnippet, searchTerms } from '../db/snippet';
import { parseInput } from './errors';

export function registerSearchRoutes(app: FastifyInstance, repo: Repository): void {
  app.get(`${API_PREFIX}/search`, async (request) => {
    const { q, page, pageSize } = parseInput(searchQuerySchema, request.query, 'query');
    const terms = searchTerms(q);
    const { total, matches } = repo.search.query(q, page, pageSize);
    const data: SearchHit[] = [];
    for (const match of matches) {
      const recording = repo.getRecording(match.recordingId);
      if (!recording) continue;
      const body = match.body.toLowerCase();
      const inBody = terms.some((term) => body.includes(term));
      data.push({
        recording,
        snippet: buildSnippet(inBody ? match.body : match.title, terms),
        segment: inBody ? repo.firstMatchingSegment(recording.id, terms) : null,
      });
    }
    return {
      data,
      pagination: { page, pageSize, totalItems: total, totalPages: Math.ceil(total / pageSize) },
    };
  });
}
