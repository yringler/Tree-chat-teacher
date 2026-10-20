import { computed, inject } from '@angular/core';
import { composerExcerpt, composerPlan } from '@tangent/shared';
import { ComposerController } from '../ui/composer';
import type { ConversationStore } from './conversation-store';
import type { ThreadScroll } from './thread-scroll';

/** What a page's `ComposerTarget` works on. */
export interface ComposerTargetOptions {
  readonly store: Pick<
    ConversationStore,
    | 'path'
    | 'selectedBranchId'
    | 'selectedBranch'
    | 'focusedInPath'
    | 'focusedNodeId'
    | 'focus'
    | 'index'
    | 'send'
    | 'askFrom'
  >;
  /** The page's thread: a send follows the reply, and the named reply comes into view. */
  readonly thread: Pick<ThreadScroll, 'pin' | 'toMessage'>;
}

/**
 * Where the message box of a power or Learn page sends, from one rule
 * (`composerPlan`): the lead the box is aimed at, else the focused reply of
 * the open thread, else its last reply; the reply the box names; and its
 * two ways to send, on in the open thread or on a tangent from that reply.
 * Each page adds its placeholders and buttons (power's caret, Learn's
 * walkthrough).
 *
 * Made in a page's injection context: the page holds the lead
 * (`ComposerController.holdLead`), so it goes with the page or its message.
 */
export class ComposerTarget {
  private readonly composer = inject(ComposerController);

  /**
   * What the box's next message asks about, on a tangent made when it is
   * sent: words "Ask about this" quoted, or a whole message (its Tangent ↳, `b`).
   */
  readonly lead = this.composer.lead;

  /** What the box offers and where its tangent starts. */
  readonly plan = computed(() =>
    composerPlan({
      path: this.o.store.path(),
      branchId: this.o.store.selectedBranchId(),
      inTangent: this.o.store.selectedBranch()?.parentBranchId != null,
      focusedId: this.o.store.focusedInPath()?.id ?? null,
      lead: this.lead(),
    }),
  );

  /**
   * The opening words of the reply the box's tangent starts at, for the open
   * box to name when it may not be the one in view; a lead names itself.
   */
  readonly target = computed(() => {
    const target = this.plan().target;
    return target && !this.lead() ? this.excerptOf(target) : null;
  });

  constructor(private readonly o: ComposerTargetOptions) {
    this.composer.holdLead((nodeId) => o.store.index()?.nodes.has(nodeId) ?? false);
  }

  /** The opening words of message `nodeId`, for the box to say what it asks about. */
  excerptOf(nodeId: string): string {
    return composerExcerpt(this.o.store.index()?.nodes.get(nodeId)?.content ?? '');
  }

  /** The lead taken off the box, which keeps the focus. */
  dropLead(): void {
    this.composer.drop();
    this.composer.focus();
  }

  /** The named reply clicked: it comes into view. */
  showTarget(): void {
    const target = this.plan().target;
    if (target) this.o.thread.toMessage(target);
  }

  /** The message continues the open thread (Send or Next ➜), and the focus lets go. */
  send(content: string): void {
    const { store } = this.o;
    const id = store.selectedBranchId();
    if (!id) return;
    this.o.thread.pin();
    if (store.focusedNodeId()) store.focus(null);
    void store.send(id, content);
  }

  /**
   * The message starts a `path` tangent from the box's target, quoting the
   * lead's words if any; the lead stays on the box if the tangent can't be
   * made, to try again.
   */
  async goOnTangent(content: string): Promise<void> {
    const from = this.plan().target;
    if (!from) return;
    this.o.thread.pin();
    if (await this.o.store.askFrom(from, content, this.lead()?.quote ?? null)) this.composer.drop();
  }
}
