import { classifyModel, upstreamModelListSchema, type AiModel } from '@homescribe/shared';
import { authHeaders, httpRequest, withTimeout } from './http';

export class AiUnreachableError extends Error {}

/** `GET {baseUrl}/v1/models` of an OpenAI-compatible server, with a kind guess per model. */
export async function listModels(
  baseUrl: string,
  apiKey: string | null,
  timeoutMs = 5000,
): Promise<AiModel[]> {
  const url = new URL(`${baseUrl}/v1/models`);
  const timer = withTimeout(timeoutMs);
  let result;
  try {
    result = await httpRequest(url, {
      headers: { accept: 'application/json', ...authHeaders(apiKey) },
      signal: timer.signal,
      limit: 4 * 1024 * 1024,
    });
  } catch (error) {
    const reason = timer.timedOut()
      ? 'no answer'
      : error instanceof Error
        ? error.message
        : String(error);
    throw new AiUnreachableError(`Cannot reach ${url.origin}: ${reason}`);
  }
  if (result.status === 401 || result.status === 403) {
    throw new AiUnreachableError(`${url.origin} refused the API key (HTTP ${result.status})`);
  }
  if (result.status < 200 || result.status >= 300) {
    throw new AiUnreachableError(`${url.origin} answered HTTP ${result.status}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(result.body);
  } catch {
    throw new AiUnreachableError(`${url.origin} did not answer with JSON`);
  }
  const parsed = upstreamModelListSchema.safeParse(json);
  if (!parsed.success) {
    throw new AiUnreachableError(`${url.origin} does not look like an OpenAI-compatible server`);
  }
  const seen = new Set<string>();
  return parsed.data.data
    .filter((model) => !seen.has(model.id) && seen.add(model.id))
    .map((model) => ({ id: model.id, kind: classifyModel(model.id, model.task) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}
