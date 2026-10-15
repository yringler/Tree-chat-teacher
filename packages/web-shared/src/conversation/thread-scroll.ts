import { DestroyRef, effect, inject, Injectable, signal, untracked } from '@angular/core';
import type { ConversationStore } from './conversation-store';

/** What a page's `ThreadScroll` works on. */
export interface ThreadScrollOptions {
  readonly store: Pick<
    ConversationStore,
    'selectedBranchId' | 'focusedInPath' | 'path' | 'firstNodeOf' | 'streamingNode' | 'live'
  >;
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

/** The jump to the end is offered once the end is this far below, or half a view if more. */
const FAR_FROM_END = 240;

/** The reader asked for less motion: jumps rather than glides. */
function lessMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * The thread on screen, for what reaches it from outside its page: `Home`
 * and `End` (the app's shortcuts). Each page's `ThreadScroll` stands here
 * while the page is open.
 */
@Injectable({ providedIn: 'root' })
export class ThreadEnds {
  private current: ThreadScroll | null = null;

  /** The start of the branch on screen; false with no thread open. */
  toStart(): boolean {
    return this.current?.toStart() ?? false;
  }

  /** The end of the thread on screen; false with no thread open. */
  toEnd(): boolean {
    return this.current?.toEnd() ?? false;
  }

  /** `thread` is the one on screen until it goes. */
  open(thread: ThreadScroll, destroyRef: DestroyRef): void {
    this.current = thread;
    destroyRef.onDestroy(() => {
      if (this.current === thread) this.current = null;
    });
  }
}

/**
 * Where the thread on a power or Learn page is scrolled. A tangent opened at
 * its first message (`openAtStart`, the outline, the keys) shows from its
 * start, its fork at the top of the view, every time: the reader chose it,
 * so what it is about comes first. A move to another message scrolls that
 * one into view. A branch opened without one (the main thread) opens at its
 * end, and the view follows the end while replies grow there, until the
 * reader scrolls away from it. `toStart` and `toEnd` go to either end on
 * request (the title, a tangent's current step in its path, the jump to the
 * end, `Home` and `End`).
 *
 * Made in a page's injection context: its effects live as long as the page.
 */
export class ThreadScroll {
  /** The view is at the end of the thread: new text keeps it there. */
  private pinned = true;

  /** Counts the moves to another branch or message: a follow asked for before the last one is dropped. */
  private moves = 0;

  /** The end is far enough below to offer the jump to it. */
  private readonly far = signal(false);
  readonly farFromEnd = this.far.asReadonly();

  constructor(private readonly o: ThreadScrollOptions) {
    const { store } = o;
    inject(ThreadEnds).open(this, inject(DestroyRef));

    // The end moves without a scroll when the thread changes size: a reply
    // growing, a message laid out, another branch shown. Only the offer
    // follows: whether the view follows the end is the reader's scrolling,
    // and a reply grows before the view catches up with it.
    effect((onCleanup) => {
      const el = o.scroller();
      if (!el || typeof ResizeObserver !== 'function') return;
      const sizes = new ResizeObserver(() => this.far.set(this.farBelow(el)));
      sizes.observe(el);
      if (el.firstElementChild) sizes.observe(el.firstElementChild);
      onCleanup(() => sizes.disconnect());
    });

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
        if (moved) {
          this.moves++;
          o.moved?.();
        }
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
        } else if (moved) {
          this.pinned = true;
          this.followSoon(true);
        } else {
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

  /**
   * Scrolls to the start of the branch on screen: on a tangent its fork,
   * with what it came from above; on the main thread its first message.
   */
  toStart(): boolean {
    const el = this.o.scroller();
    if (!el) return false;
    this.pinned = false;
    this.scroll(el, this.startOf(el));
    return true;
  }

  /** Scrolls to the end and follows it from there, so a reply being written stays in view. */
  toEnd(): boolean {
    const el = this.o.scroller();
    if (!el) return false;
    this.pinned = true;
    this.scroll(el, el.scrollHeight - el.clientHeight);
    return true;
  }

  /**
   * Glides a short way, which shows where it went; jumps a long one, or
   * while a reply is written, whose growth would move the target under the
   * glide, or when the reader asked for less motion.
   */
  private scroll(el: HTMLElement, top: number): void {
    const distance = Math.abs(top - el.scrollTop);
    if (distance <= 1) return;
    const glide =
      !lessMotion() && this.o.store.streamingNode() === null && distance <= 2 * el.clientHeight;
    el.scrollTo({ top, behavior: glide ? 'smooth' : 'instant' });
    if (!glide) this.measure(el);
  }

  private measure(el: HTMLElement): void {
    this.pinned = el.scrollHeight - el.scrollTop - el.clientHeight < AT_END;
    this.far.set(this.farBelow(el));
  }

  private farBelow(el: HTMLElement): boolean {
    const below = el.scrollHeight - el.scrollTop - el.clientHeight;
    return below > Math.max(FAR_FROM_END, el.clientHeight / 2);
  }

  /**
   * On the next frame, once the thread is laid out, if the view still
   * follows the end and is still where it was asked for. `opened`: the move
   * to this thread asked, and its end is followed even if the view no
   * longer is by then, since the old thread giving way to the new one
   * scrolls the view without the reader.
   */
  private followSoon(opened = false): void {
    if (!this.pinned) return;
    const move = this.moves;
    requestAnimationFrame(() => {
      // Asked again: another move since, or the reader scrolling away from
      // a reply being written, stops the following.
      const el = this.o.scroller();
      if (el && move === this.moves && (opened || this.pinned)) this.followEnd(el);
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
        el.scrollTop = top;
        this.measure(el);
        this.pinned = false;
        return;
      }
    }
    el.scrollTop = el.scrollHeight;
    this.measure(el);
  }
}
