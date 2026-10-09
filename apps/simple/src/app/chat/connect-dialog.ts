import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  signal,
} from '@angular/core';
import { describeEndpoint } from '@tangent/core/links';
import { Modal, NodePicker, type LinkPick } from '@tangent/web-shared';
import { LessonStore } from '../state/lesson-store';
import { UiStore } from '../state/ui-store';
import { connectionTitleOf } from './connections';

/**
 * "Connect": a full-height sheet to connect a message to another one of the
 * lesson (search or browse, then an optional note). Opened from a message
 * (`UiStore.linkDialog`); closes on Connect, Cancel, Escape, or when the
 * message is gone (another lesson opened).
 */
@Component({
  selector: 'app-connect-dialog',
  imports: [Modal, NodePicker],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (store.index(); as index) {
      <app-modal class="connect-sheet" heading="Connect this message" (closed)="close()">
        @if (source(); as from) {
          <p class="connect-from muted small">
            From <span class="connect-from-text">“{{ from }}”</span>
          </p>
        }
        <app-node-picker
          [index]="index"
          [sourceNodeId]="sourceNodeId()"
          [linksByNode]="store.linksByNode()"
          [titleOf]="titleOf"
          placeholder="This connects to…"
          noteLabel="Why? (a note for yourself)"
          notePlaceholder="How do they connect?"
          submitLabel="Connect"
          tangentLabel="Side question"
          (picked)="connect($event)"
          (cancelled)="close()"
        />
        @if (saving()) {
          <p class="muted small" aria-live="polite">Connecting…</p>
        }
      </app-modal>
    }
  `,
})
export class ConnectDialog {
  protected readonly store = inject(LessonStore);
  private readonly ui = inject(UiStore);
  protected readonly titleOf = connectionTitleOf;

  /** The message the connection is made from. */
  readonly sourceNodeId = input.required<string>();

  protected readonly saving = signal(false);
  /** The message the connection starts from, as a snippet. */
  protected readonly source = computed(() => {
    const idx = this.store.index();
    const endpoint = idx && describeEndpoint(idx, this.sourceNodeId(), connectionTitleOf);
    return endpoint ? endpoint.snippet || null : null;
  });

  constructor() {
    // The message went away under the sheet (another lesson opened): nothing left to connect.
    effect(() => {
      const idx = this.store.index();
      if (!idx?.nodes.has(this.sourceNodeId())) this.close();
    });
  }

  protected async connect(pick: LinkPick): Promise<void> {
    if (this.saving()) return;
    this.saving.set(true);
    try {
      const link = await this.store.createLink(this.sourceNodeId(), pick.nodeId, pick.note);
      if (link) this.close();
    } finally {
      this.saving.set(false);
    }
  }

  protected close(): void {
    this.ui.dialogs.close('connect');
  }
}
