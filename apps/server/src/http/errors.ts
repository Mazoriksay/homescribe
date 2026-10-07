import type { ApiError, ApiErrorCode } from '@homescribe/shared';
import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import type { z } from 'zod';

/** An error that maps directly onto an HTTP error response (SPEC.md §7.1). */
export class AppError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: ApiErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export const notFound = (what: string) => new AppError(404, 'NOT_FOUND', `${what} not found`);

/** Validates untrusted input; failures become 400 VALIDATION_ERROR with the issues. */
export function parseInput<T extends z.ZodType>(
  schema: T,
  input: unknown,
  where: string,
): z.infer<T> {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new AppError(
      400,
      'VALIDATION_ERROR',
      `Invalid ${where}`,
      result.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
    );
  }
  return result.data;
}

export function errorBody(code: ApiErrorCode, message: string, details?: unknown): ApiError {
  return { error: details === undefined ? { code, message } : { code, message, details } };
}

/** Maps framework/plugin errors onto the single error shape. */
function fromFrameworkError(error: FastifyError): AppError {
  switch (error.code) {
    case 'FST_REQ_FILE_TOO_LARGE':
    case 'FST_ERR_CTP_BODY_TOO_LARGE':
      return new AppError(413, 'FILE_TOO_LARGE', 'The upload is larger than allowed');
    case 'FST_INVALID_MULTIPART_CONTENT_TYPE':
    case 'FST_ERR_CTP_INVALID_MEDIA_TYPE':
      return new AppError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Unsupported content type');
  }
  const status = error.statusCode ?? 500;
  if (status >= 400 && status < 500) {
    return new AppError(400, 'VALIDATION_ERROR', error.message);
  }
  return new AppError(500, 'INTERNAL_ERROR', 'Internal server error');
}

export function errorHandler(
  error: FastifyError | AppError,
  request: FastifyRequest,
  reply: FastifyReply,
): void {
  const appError = error instanceof AppError ? error : fromFrameworkError(error);
  if (appError.statusCode >= 500) request.log.error({ err: error }, 'request failed');
  void reply
    .status(appError.statusCode)
    .send(errorBody(appError.code, appError.message, appError.details));
}
