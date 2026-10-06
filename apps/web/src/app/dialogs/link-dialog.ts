import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { plainText } from '@tangent/core';
import { splitTangents } from '@tangent/shared';
import { Modal, NodePicker, type LinkPick } from '@tangent/web-shared';
import { TreeStore } from '../state/tree-store';
import { UiStore, type LinkDialogState } from '../state/ui-store';

/**
 * "Link…" on a message: search or browse the conversation for the message it
 * relates to, add an optional note, link. "Pick on the page instead" hands
 * over to pick mode (the chat page's banner and "Link here" buttons).
 */
@Component({
  selector: 'app-link-dialog',
  imports: [Modal, NodePicker],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <app-modal heading="Link to another message" [wide]="true" (closed)="close()">
      <div class="form link-dialog">
        @if (source(); as n) {
          <div class="excerpt">
            <span class="field-label">{{ n.role === 'user' ? 'Your message' : 'Assistant' }}</span>
            <p>{{ excerpt() }}</p>
          </div>
        }
        @if (store.index(); as index) {
          <app-node-picker
            [index]="index"
            [sourceNodeId]="state().fromNodeId"
            [linksByNode]="store.linksByNode()"
            placeholder="Search messages and branches"
            (picked)="link($event)"
            (cancelled)="close()"
          >
            <button type="button" class="btn btn-ghost btn-left" (click)="pickOnPage()">
              Pick on the page instead
            </button>
          </app-node-picker>
        }
      </div>
    </app-modal>
  `,
})
export class LinkDialog {
  protected readonly store = inject(TreeStore);
  private readonly ui = inject(UiStore);
  readonly state = input.required<LinkDialogState>();

  protected readonly source = computed(
    () => this.store.index()?.nodes.get(this.state().fromNodeId) ?? null,
  );
  protected readonly excerpt = computed(() => {
    const text = plainText(splitTangents(this.source()?.content ?? '').body);
    return text.length > 200 ? `${text.slice(0, 200)}…` : text;
  });
  private readonly saving = signal(false);

  protected close(): void {
    this.ui.linkDialog.set(null);
  }

  protected pickOnPage(): void {
    this.ui.linkPick.set({ fromNodeId: this.state().fromNodeId });
    this.close();
  }

  protected async link(pick: LinkPick): Promise<void> {
    if (this.saving()) return;
    this.saving.set(true);
    const link = await this.store.createLink(this.state().fromNodeId, pick.nodeId, pick.note);
    this.saving.set(false);
    if (link) this.close();
  }
}
