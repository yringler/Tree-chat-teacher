/**
 * A message that didn't reach the lesson (refused, e.g. out of credit or for
 * want of the own key, or a failed request), offered back to the composer
 * of its branch. Kept for the tab and its user (`UNSENT_STORAGE_KEY`):
 * a top-up (checkout) and the human check leave the page and come back to it.
 */
export interface UnsentDraft {
  treeId: string;
  branchId: string;
  text: string;
  /** Sent as a "Check sources" request: resent as one, never offered as typed text. */
  ground?: 'required';
  /**
   * Refused for want of the learner's own key (401 `key_required`): once
   * "How replies are paid for" is settled (a key saved, credit or the pool
   * picked), it is sent (`resumeUnsent`).
   */
  needsKey?: boolean;
}

/** Where the unsent message waits in sessionStorage (this tab only, like the page it left). */
const UNSENT_STORAGE_KEY = 'tangent.learn.unsent';

/** The message `userId` left unsent in this tab; one left by anyone else is dropped. */
export function storedDraft(userId: string): UnsentDraft | null {
  try {
    const raw = sessionStorage.getItem(UNSENT_STORAGE_KEY);
    const d: unknown = raw ? JSON.parse(raw) : null;
    if (typeof d !== 'object' || d === null) return null;
    const { owner, treeId, branchId, text, ground, needsKey } = d as Record<string, unknown>;
    if (owner !== userId) {
      storeDraft(null, null);
      return null;
    }
    if (typeof treeId !== 'string' || typeof branchId !== 'string' || typeof text !== 'string')
      return null;
    return {
      treeId,
      branchId,
      text,
      ...(ground === 'required' ? { ground } : {}),
      ...(needsKey === true ? { needsKey } : {}),
    };
  } catch {
    return null;
  }
}

/** Keeps `d` for the tab as `owner`'s (no one signed in: for this page only). */
export function storeDraft(d: UnsentDraft | null, owner: string | null): void {
  try {
    if (d && owner) sessionStorage.setItem(UNSENT_STORAGE_KEY, JSON.stringify({ ...d, owner }));
    else sessionStorage.removeItem(UNSENT_STORAGE_KEY);
  } catch {
    // Storage unavailable: the message waits for this page only.
  }
}
