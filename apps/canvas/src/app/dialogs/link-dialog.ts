import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { describeEndpoint } from '@tangent/core/links';
import { endpointTitle, Modal, NodePicker, type LinkPick } from '@tangent/web-shared';
import { laneTitle } from '../canvas/titles';
import { CanvasStore } from '../state/canvas-store';
import { UiStore, type LinkDialogState } from '../state/ui-store';

/**
 * "Search" for the other end of a link: the shared picker (search, or browse
 * every lane's messages) over the open tree, with a note. "Pick on the
 * canvas instead" goes back to clicking a card.
 */
@Component({
  selector: 'app-link-dialog',
  imports: [Modal, NodePicker],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <app-modal heading="Link to another message" [wide]="true" (closed)="close()">
      @if (store.index(); as idx) {
        @if (sourceTitle(); as title) {
          <div class="excerpt">
            <span class="field-label">From</span>
            <p>{{ title }}</p>
          </div>
        }
        <app-node-picker
          [index]="idx"
          [sourceNodeId]="state().fromNodeId"
          [linksByNode]="store.linksByNode()"
          [titleOf]="laneTitle"
          placeholder="Search messages and lanes"
          (picked)="link($event)"
          (cancelled)="close()"
        >
          <button type="button" class="btn btn-ghost btn-left" (click)="pickOnCanvas()">
            Pick on the canvas instead
          </button>
        </app-node-picker>
      }
    </app-modal>
  `,
})
export class LinkDialog {
  protected readonly store = inject(CanvasStore);
  private readonly ui = inject(UiStore);
  protected readonly laneTitle = laneTitle;

  readonly state = input.required<LinkDialogState>();

  protected readonly sourceTitle = computed(() => {
    const idx = this.store.index();
    const ep = idx ? describeEndpoint(idx, this.state().fromNodeId, laneTitle) : null;
    return ep ? endpointTitle(ep) : null;
  });

  protected async link(pick: LinkPick): Promise<void> {
    const from = this.state().fromNodeId;
    this.close();
    await this.store.createLink(from, pick.nodeId, pick.note);
  }

  protected pickOnCanvas(): void {
    this.ui.startLinkPick(this.state().fromNodeId);
  }

  protected close(): void {
    this.ui.dialogs.close('link');
  }
}
