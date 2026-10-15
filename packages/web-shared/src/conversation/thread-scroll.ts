import { effect, untracked } from '@angular/core';
import type { ConversationStore } from './conversation-store';

/** What a page's `ThreadScroll` works on. */
export interface ThreadScrollOptions {
  readonly store: ConversationStore;
  /** The element the thread scrolls in (the page's `.messages`). */
  readonly scroller: () => HTMLElement | undefined;
  /**
   * A reply being written is followed only until its start reaches the top
   * of the view, so the reader reads it from its first line (Learn); without
   * it, the view follows the reply's end.
   */
  readonly readRepliesFromStart?: boolean;
  /** The view moved to another branch or message: what belonged to the old place goes. */
  readonly moved?: () => void;
}

/** Closer than this to the end, the view counts as at the end, and follows it. */
const AT_END = 80;

/**
 * Where the thread on a power or Learn page is scrolled. A tangent opened at
 * its first message (`openAtStart`, the outline, the keys) shows from its
 * start, its fork at the top of the view, every time: the reader chose it,
 * so what it is about comes first. A move to another message scrolls that
 * one into view. A branch opened without one (the main thread) opens at its
 * end, and the view follows the end while replies grow there, until the
 * reader scrolls away from it.
 *
 * Made in a page's injection context: its effects live as long as the page.
 */
export class ThreadScroll {
  /** The view is at the end of the thread: new text keeps it there. */
  private pinned = true;

  constructor(private readonly o: ThreadScrollOptions) {
    const { store } = o;
    let lastBranch: string | null = null;
    let lastFocus: string | null = null;
    effect(() => {
      const branchId = store.selectedBranchId();
      const focus = store.focusedInPath()?.id ?? null;
      const count = store.path().length;
      if (!branchId || count === 0) return;
      untracked(() => {
        const opened = branchId !== lastBranch;
        const moved = opened || focus !== lastFocus;
        lastBranch = branchId;
        lastFocus = focus;
        if (moved) o.moved?.();
        if (opened && focus !== null && focus === store.firstNodeOf(branchId)?.id) {
          // Decided here: a follow of the old thread's end, asked for before
          // the frame, finds the view no longer following.
          this.pinned = false;
          requestAnimationFrame(() => this.landAtStart());
        } else if (moved && focus !== null) {
          requestAnimationFrame(() =>
            document
              .getElementById(`msg-${focus}`)
              ?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }),
          );
        } else {
          if (moved) this.pinned = true;
          this.followSoon();
        }
      });
    });

    // A reply being written grows the end.
    effect(() => {
      const s = store.streamingNode();
      if (s && store.live().get(s.id)?.content !== undefined) untracked(() => this.followSoon());
    });
  }

  /** The page's scroll handler: the reader moving away from the end stops the following. */
  onScroll(): void {
    const el = this.o.scroller();
    if (el) this.measure(el);
  }

  /** The reader sent a message: the view follows the reply to it. */
  pin(): void {
    this.pinned = true;
  }

  private measure(el: HTMLElement): void {
    this.pinned = el.scrollHeight - el.scrollTop - el.clientHeight < AT_END;
  }

  /** On the next frame, once the thread is laid out, if the view still follows the end. */
  private followSoon(): void {
    if (!this.pinned) return;
    requestAnimationFrame(() => {
      // Asked again: opening a tangent in the meantime stops the following.
      const el = this.o.scroller();
      if (this.pinned && el) this.followEnd(el);
    });
  }

  /** The start of the branch on screen: a tangent's fork, or the top of the main thread. */
  private startOf(el: HTMLElement): number {
    const fork = el.querySelector('.fork-current');
    if (!fork) return 0;
    return el.scrollTop + fork.getBoundingClientRect().top - el.getBoundingClientRect().top;
  }

  private landAtStart(): void {
    const el = this.o.scroller();
    if (!el) return;
    el.scrollTop = this.startOf(el);
    // The jump fires its scroll event after this frame; till then, a reply
    // growing must not take the view back to the end.
    this.measure(el);
  }

  /**
   * Scrolls to the end; with `readRepliesFromStart`, a reply being written
   * only until its start reaches the top of the view, and past that the end
   * grows out of sight. A reader who scrolls on below its start is followed
   * again.
   */
  private followEnd(el: HTMLElement): void {
    const reply = this.o.readRepliesFromStart ? this.o.store.streamingNode() : null;
    const host = reply ? document.getElementById(`msg-${reply.id}`) : null;
    if (host) {
      const top = el.scrollTop + host.getBoundingClientRect().top - el.getBoundingClientRect().top;
      if (el.scrollTop <= top && top < el.scrollHeight - el.clientHeight) {
        this.pinned = false;
        el.scrollTop = top;
        return;
      }
    }
    el.scrollTop = el.scrollHeight;
  }
}
