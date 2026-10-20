import {
  ChangeDetectionStrategy,
  Component,
  inject,
  input,
  type OnInit,
  signal,
} from '@angular/core';
import {
  DEFAULT_GROUNDING_MODE,
  type Branch,
  type ContextMode,
  type GroundingMode,
  type UpdateBranchRequest,
} from '@tangent/shared';
import { TreeStore } from '../state/tree-store';
import { UiStore } from '../state/ui-store';
import { deleteBranchQuestion, Icon, Modal, ToastStore } from '@tangent/web-shared';
import { ModePicker } from '../ui/mode-picker';
import { ReplyFields, replyChanges, replyFieldsOf } from '../ui/reply-fields';

/**
 * Asks, then deletes a branch with every branch below it. Shared by the
 * settings dialog, the outline, the chat header (the open branch) and each
 * message's branch list. Resolves true if it was deleted.
 */
export async function confirmDeleteBranch(store: TreeStore, branchId: string): Promise<boolean> {
  const idx = store.index();
  const branch = idx?.branches.get(branchId);
  const question =
    idx && branch
      ? deleteBranchQuestion(idx, branchId, {
          title: branch.title,
          noun: { one: 'tangent', many: 'tangents' },
          consequences:
            'Replies still generating there are stopped, and shares of its messages stop working.',
        })
      : null;
  if (!question || !confirm(question)) return false;
  return store.deleteBranch(branchId);
}

/**
 * Edit the open tangent: title, mode, anchor quote, its replies (who pays,
 * the model, web search), privacy; delete it. The main thread's are in
 * Conversation settings.
 */
@Component({
  selector: 'app-branch-settings',
  imports: [Icon, Modal, ModePicker, ReplyFields],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <app-modal heading="Tangent settings" (closed)="close()">
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
          @if (branch().titleSource !== 'user') {
            <span class="muted small"
              >{{
                branch().titleSource === 'auto' ? 'Generated automatically.' : 'Default title.'
              }}
              Editing it keeps your title.</span
            >
          }
        </label>

        <app-mode-picker [(mode)]="mode" />
        <label class="field">
          <span class="field-label">Anchor quote</span>
          <textarea rows="3" [value]="quote()" (input)="quote.set(q.value)" #q></textarea>
        </label>

        <app-reply-fields [(route)]="route" [(modelId)]="modelId" [(grounding)]="grounding" />

        <label class="check">
          <input type="checkbox" [checked]="isPrivate()" (change)="isPrivate.set(!isPrivate())" />
          Private (excluded from shares and exports, with everything below it)
        </label>

        <div class="form-actions">
          <button type="button" class="btn btn-danger-ghost btn-left" (click)="remove()">
            <app-icon name="trash" /> Delete tangent
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
export class BranchSettings implements OnInit {
  private readonly store = inject(TreeStore);
  private readonly ui = inject(UiStore);
  private readonly toast = inject(ToastStore);
  readonly branch = input.required<Branch>();
  /**
   * The branch as the form was filled from it. Saving sends what the user
   * changed from this, not from the live branch: a reply finishing meanwhile
   * may have retitled it.
   */
  private opened: Branch | null = null;

  protected readonly title = signal('');
  protected readonly mode = signal<ContextMode>('path');
  protected readonly quote = signal('');
  protected readonly isPrivate = signal(false);
  /** Provider and funding, as a `routeKey`. */
  protected readonly route = signal('');
  protected readonly modelId = signal('');
  protected readonly grounding = signal<GroundingMode>(DEFAULT_GROUNDING_MODE);
  protected readonly saving = signal(false);

  ngOnInit(): void {
    const b = this.branch();
    this.opened = b;
    this.title.set(b.title);
    this.mode.set(b.contextMode);
    this.quote.set(b.anchorQuote ?? '');
    this.isPrivate.set(b.isPrivate);
    const replies = replyFieldsOf(b);
    this.route.set(replies.route);
    this.modelId.set(replies.modelId);
    this.grounding.set(replies.grounding);
  }

  protected close(): void {
    this.ui.dialogs.close('branch-settings');
  }

  protected async remove(): Promise<void> {
    if (await confirmDeleteBranch(this.store, this.branch().id)) this.close();
  }

  protected async save(): Promise<void> {
    const b = this.opened;
    if (!b) return;
    const req: UpdateBranchRequest = replyChanges(b, {
      route: this.route(),
      modelId: this.modelId(),
      grounding: this.grounding(),
    });
    const title = this.title().trim();
    if (title && title !== b.title) req.title = title;
    if (this.mode() !== b.contextMode) req.contextMode = this.mode();
    const quote = this.quote().trim() || null;
    if (quote !== b.anchorQuote) req.anchorQuote = quote;
    if (this.isPrivate() !== b.isPrivate) req.isPrivate = this.isPrivate();
    if (Object.keys(req).length === 0) {
      this.close();
      return;
    }
    this.saving.set(true);
    const ok = await this.store.updateBranch(b.id, req);
    this.saving.set(false);
    if (ok) {
      this.toast.notify('Tangent updated');
      this.close();
    }
  }
}
