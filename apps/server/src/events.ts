import type { ServerEvent } from '@homescribe/shared';

type Listener = (event: ServerEvent) => void;

/** In-process fan-out of server events to SSE connections (SPEC.md §7.4). */
export class EventBus {
  private readonly listeners = new Set<Listener>();

  emit(event: ServerEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  get size(): number {
    return this.listeners.size;
  }
}
