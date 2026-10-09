import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import type { ChatNode } from '@tangent/shared';
import { Icon, ToastStore } from '@tangent/web-shared';
import { copyText, selectionWithin } from '../core/selection';
import { TreeStore } from '../state/tree-store';
import { UiStore } from '../state/ui-store';

/**
 * In pick mode, what "Link here" does on a message: `open` links it; the
 * message linked from (`source`) and those already linked can't be picked.
 */
export type PickState = 'open' | 'source' | 'linked';

const PICK_LABELS: Readonly<Record<PickState, string>> = {
  open: 'Link here',
  source: 'Linking from here',
  linked: 'Already linked',
};

/** A message's header buttons: Branch from here, Review, Link, Copy; "Link here" in pick mode. */
@Component({
  selector: 'app-message-actions',
  imports: [Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'msg-actions' },
  template: `
    @if (pick(); as p) {
      <!-- Pick mode ("Pick on the page instead"): this message can be the other end. -->
      <button
        type="button"
        class="btn btn-primary btn-sm link-here"
        [disabled]="p !== 'open'"
        (click)="linkHere($event)"
      >
        <app-icon name="link" [size]="14" />
        {{ pickLabels[p] }}
      </button>
    } @else {
      <!-- Without a route to generate on (no membership for own keys, no credit), no new branches or reviews. -->
      @if (store.account.canGenerate()) {
        <button
          type="button"
          class="btn btn-ghost btn-sm"
          (mousedown)="captureSelection()"
          (click)="branch($event)"
          title="Branch from here (b)"
        >
          <app-icon name="branch" [size]="14" /> Branch from here
        </button>
      }
      @if (canReview()) {
        <button
          type="button"
          class="btn btn-ghost btn-sm"
          (click)="openReview($event)"
          title="Have a stronger model check the conversation up to here (v)"
        >
          <app-icon name="review" [size]="14" /> Review
        </button>
      }
      <!-- Not a generating call: links stay available while power is read-only. -->
      <button
        type="button"
        class="btn btn-ghost btn-sm"
        (click)="openLinkDialog($event)"
        title="Link to another message (l)"
      >
        <app-icon name="link" [size]="14" /> Link…
      </button>
      <button
        type="button"
        class="icon-btn"
        [attr.aria-label]="copied() ? 'Copied' : 'Copy message'"
        (click)="copy($event)"
      >
        <app-icon name="copy" [size]="14" />
      </button>
    }
  `,
})
export class MessageActions {
  protected readonly store = inject(TreeStore);
  private readonly ui = inject(UiStore);
  private readonly toast = inject(ToastStore);

  readonly node = input.required<ChatNode>();
  /** The rendered message, whose selected text "Branch from here" quotes. */
  readonly body = input.required<HTMLElement>();
  /** What Copy copies (the reply without its tangents block). */
  readonly text = input.required<string>();
  /** Pick mode is on: this message's "Link here" state. */
  readonly pick = input<PickState | null>(null);

  protected readonly pickLabels = PICK_LABELS;
  protected readonly copied = signal(false);
  private pendingQuote: string | null = null;

  /** A finished reply on a branch that can be reviewed. */
  protected readonly canReview = computed(() => {
    const n = this.node();
    return (
      n.role === 'assistant' &&
      n.status === 'complete' &&
      this.store.canReview(this.store.branchOf(n.id))
    );
  });

  /** Mousedown runs before the click collapses the selection. */
  protected captureSelection(): void {
    this.pendingQuote = selectionWithin(this.body());
  }

  protected branch(e: Event): void {
    e.stopPropagation();
    const quote = this.pendingQuote ?? selectionWithin(this.body());
    this.pendingQuote = null;
    this.ui.dialogs.open({ kind: 'branch', fromNodeId: this.node().id, quote });
  }

  protected openReview(e: Event): void {
    e.stopPropagation();
    this.ui.dialogs.open({ kind: 'review', nodeId: this.node().id });
  }

  protected openLinkDialog(e: Event): void {
    e.stopPropagation();
    this.ui.dialogs.open({ kind: 'link', fromNodeId: this.node().id });
  }

  protected async linkHere(e: Event): Promise<void> {
    e.stopPropagation();
    const pick = this.ui.linkPick();
    if (!pick || this.pick() !== 'open') return;
    this.ui.linkPick.set(null);
    await this.store.createLink(pick.fromNodeId, this.node().id);
  }

  protected async copy(e: Event): Promise<void> {
    e.stopPropagation();
    if (await copyText(this.text())) {
      this.copied.set(true);
      this.toast.notify('Copied to clipboard');
      setTimeout(() => this.copied.set(false), 1500);
    }
  }
}
