/** @public */
export type TransitionListener<Event> = (event: Event) => Promise<void> | void;

/** @public */
export interface TransitionQueueOptions {
  readonly onListenerError?: (error: unknown) => void;
}

/** @public */
export interface TransitionQueue<Event> {
  readonly enqueue: <Result>(
    operation: () => Promise<Result>,
  ) => Promise<Result>;
  readonly publish: (event: Event) => void;
  readonly subscribe: (listener: TransitionListener<Event>) => () => void;
}

/** @public */
export function createTransitionQueue<Event>(
  options: TransitionQueueOptions = {},
): TransitionQueue<Event> {
  const listeners = new Set<TransitionListener<Event>>();
  let tail: Promise<void> = Promise.resolve();

  function reportListenerError(error: unknown): void {
    options.onListenerError?.(error);
  }

  return {
    enqueue<Result>(operation: () => Promise<Result>): Promise<Result> {
      const result = tail.then(operation);
      tail = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
    publish(event): void {
      queueMicrotask(() => {
        for (const listener of listeners) {
          try {
            const completion = listener(event);
            void Promise.resolve(completion).catch(reportListenerError);
          } catch (error) {
            reportListenerError(error);
          }
        }
      });
    },
    subscribe(listener): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
