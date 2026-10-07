import { API_PREFIX } from '@homescribe/shared';

/**
 * Path the app is served under: "" at the root, or e.g. "/homescribe". The
 * server writes it into <base href> (SPEC.md §11.2), so one build works at any
 * path; in development the template's <base href="/"> applies.
 */
export const basePath =
  typeof document === 'undefined' ? '' : new URL(document.baseURI).pathname.replace(/\/+$/, '');

/** Absolute path of the API, e.g. "/homescribe/api/v1". */
export const apiBase = `${basePath}${API_PREFIX}`;
