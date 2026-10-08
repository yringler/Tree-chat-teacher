/**
 * Wraps `run` so overlapping calls coalesce: one run at a time, and one more
 * after it when called meanwhile, so whatever prompted the latest call is
 * seen. Each call resolves when the runs it joined are over. `run` handles
 * its own errors: one that throws ends the batch, re-run and all.
 */
export function coalesced(run: () => Promise<void>): () => Promise<void> {
  let current: Promise<void> | null = null;
  let again = false;
  return () => {
    if (current) {
      again = true;
      return current;
    }
    current = (async () => {
      try {
        do {
          again = false;
          await run();
        } while (again);
      } finally {
        current = null;
      }
    })();
    return current;
  };
}
