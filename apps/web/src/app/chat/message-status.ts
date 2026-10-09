import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { CONTINUE_MESSAGE, isCutOffReply, isStoppedReply, type ChatNode } from '@tangent/shared';
import { TreeStore } from '../state/tree-store';

/** Why a reply isn't whole: cut off at its length limit (with "Continue"), stopped, or failed. */
@Component({
  selector: 'app-message-status',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { style: 'display: contents' },
  template: `
    @let n = node();
    @if (cutOff()) {
      <!-- Ended at its length limit: what it said is kept, but it isn't a whole answer. -->
      <div class="msg-error-box msg-cut-off" role="alert">
        <strong>Cut off.</strong>
        <span>{{ n.error }}</span>
        @if (canContinue()) {
          <button type="button" class="btn btn-sm msg-continue" (click)="continueReply($event)">
            Continue
          </button>
        } @else {
          <span class="muted small"
            >To get the rest, ask the model to continue (Settings → Reply length raises the
            limit).</span
          >
        }
      </div>
    } @else if (n.status === 'error') {
      <div class="msg-error-box" role="alert">
        <strong>{{ stopped() ? 'Stopped.' : 'The reply failed.' }}</strong>
        @if (n.error && !stopped()) {
          <span>{{ n.error }}</span>
        }
        <span class="muted small"
          >To retry, send your message again (or branch from the previous message).</span
        >
      </div>
    }
  `,
})
export class MessageStatus {
  private readonly store = inject(TreeStore);
  readonly node = input.required<ChatNode>();

  /** A reply cut off at its length limit (stored as an error that keeps its text). */
  protected readonly cutOff = computed(() => isCutOffReply(this.node()));
  protected readonly stopped = computed(() => isStoppedReply(this.node()));
  /** "Continue" is offered on the open branch's last message, while it can generate. */
  protected readonly canContinue = computed(() => {
    const id = this.node().id;
    return (
      this.cutOff() &&
      this.store.isLatest(id) &&
      !this.store.busy() &&
      !this.store.nodeLocked(id) &&
      this.store.account.canGenerate()
    );
  });

  /** Asks the model to go on from where the cut-off reply ended (it is in the context). */
  protected continueReply(e: Event): void {
    e.stopPropagation();
    if (!this.canContinue()) return;
    void this.store.send(this.node().branchId, CONTINUE_MESSAGE);
  }
}
