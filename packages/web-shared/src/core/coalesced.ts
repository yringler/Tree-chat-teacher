/** How long a run may take before calls stop joining it (a read that never answers). */
const STALE_MS = 20_000;

/**
 * Wraps `run` so overlapping calls coalesce: one run at a time, and one more
 * after it when called meanwhile, so whatever prompted the latest call is
 * seen. Each call resolves when the runs it joined are over. A run going on
 * for 20 seconds (a request that hangs, with no timeout of its own) is
 * left to itself: the next call starts a fresh batch instead of joining it
 * for the life of the page. `run` handles its own errors: one that throws
 * ends the batch, re-run and all.
 */
export function coalesced(run: () => Promise<void>): () => Promise<void> {
  let current: { done: Promise<void>; runStarted: number } | null = null;
  let again = false;
  return () => {
    if (current && Date.now() - current.runStarted < STALE_MS) {
      again = true;
      return current.done;
    }
    again = false;
    const batch: { done: Promise<void>; runStarted: number } = {
      done: Promise.resolve(),
      runStarted: Date.now(),
    };
    current = batch;
    batch.done = (async () => {
      try {
        do {
          again = false;
          batch.runStarted = Date.now();
          await run();
        } while (again && current === batch);
      } finally {
        if (current === batch) current = null;
      }
    })();
    return batch.done;
  };
}
