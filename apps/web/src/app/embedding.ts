import { useEffect } from 'react';
import { useLocation } from 'react-router';

export interface EmbedMessage {
  source: 'homescribe';
  type: 'ready' | 'navigate';
  /** Route relative to the base path, e.g. "/recordings/<id>". */
  path: string;
}

/** Posts to the parent window when the app runs inside an iframe (SPEC.md §11.1). */
export function postToParent(message: EmbedMessage, target: Window | null = window.parent): void {
  if (!target || target === window) return;
  // Any origin: the payload is only a route, and the embedder may be on another origin.
  target.postMessage(message, '*');
}

/** Tells an embedding page that the app has rendered, then about every route change. */
export function useEmbedSignals(): void {
  const { pathname, search } = useLocation();
  const path = pathname + search;

  useEffect(() => {
    postToParent({ source: 'homescribe', type: 'ready', path });
    // Once, after the first render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    postToParent({ source: 'homescribe', type: 'navigate', path });
  }, [path]);
}
