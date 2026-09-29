import {
  ChangeDetectionStrategy,
  Component,
  inject,
  input,
  type OnInit,
  signal,
} from '@angular/core';
import type { Tree, UpdateTreeRequest } from '@tangent/shared';
import { TreeStore } from '../state/tree-store';
import { UiStore } from '../state/ui-store';
import { Icon } from '../ui/icon';
import { Modal } from '../ui/modal';

/** Rename the tree, edit its system prompt, delete it. */
@Component({
  selector: 'app-tree-settings',
  imports: [Modal, Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <app-modal heading="Conversation settings" (closed)="close()">
      <form class="form" (submit)="$event.preventDefault(); save()">
        <label class="field">
          <span class="field-label">Title</span>
          <input
            type="text"
            maxlength="200"
            required
            [value]="title()"
            (input)="title.set(t.value)"
            #t
          />
        </label>
        <label class="field">
          <span class="field-label"
            >System prompt <span class="muted">(sent with every branch, in every mode)</span></span
          >
          <textarea
            rows="8"
            maxlength="20000"
            [value]="systemPrompt()"
            (input)="systemPrompt.set(sp.value)"
            #sp
          ></textarea>
        </label>
        <div class="form-actions">
          <button type="button" class="btn btn-danger btn-left" (click)="remove()">
            <app-icon name="trash" /> Delete conversation
          </button>
          <button type="button" class="btn btn-ghost" (click)="close()">Cancel</button>
          <button type="submit" class="btn btn-primary" [disabled]="saving()">
            {{ saving() ? 'Saving…' : 'Save' }}
          </button>
        </div>
      </form>
    </app-modal>
  `,
})
export class TreeSettings implements OnInit {
  private readonly store = inject(TreeStore);
  private readonly ui = inject(UiStore);
  readonly tree = input.required<Tree>();

  protected readonly title = signal('');
  protected readonly systemPrompt = signal('');
  protected readonly saving = signal(false);

  ngOnInit(): void {
    this.title.set(this.tree().title);
    this.systemPrompt.set(this.tree().systemPrompt ?? '');
  }

  protected close(): void {
    this.ui.treeSettingsOpen.set(false);
  }

  protected async save(): Promise<void> {
    const t = this.tree();
    const req: UpdateTreeRequest = {};
    const title = this.title().trim();
    if (title && title !== t.title) req.title = title;
    const sp = this.systemPrompt().trim() ? this.systemPrompt() : null;
    if (sp !== t.systemPrompt) req.systemPrompt = sp;
    if (Object.keys(req).length === 0) {
      this.close();
      return;
    }
    this.saving.set(true);
    const ok = await this.store.updateTree(req);
    this.saving.set(false);
    if (ok) this.close();
  }

  protected async remove(): Promise<void> {
    const t = this.tree();
    if (
      !confirm(
        `Delete “${t.title}” with all its branches and messages? Its shares stop working. This cannot be undone.`,
      )
    )
      return;
    this.close();
    await this.store.deleteTree(t.id);
  }
}
