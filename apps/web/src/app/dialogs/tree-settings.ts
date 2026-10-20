import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  type OnInit,
  signal,
} from '@angular/core';
import {
  DEFAULT_GROUNDING_MODE,
  type Branch,
  type GroundingMode,
  type Tree,
  type UpdateBranchRequest,
  type UpdateTreeRequest,
} from '@tangent/shared';
import { TreeStore } from '../state/tree-store';
import { UiStore } from '../state/ui-store';
import { Icon, Modal } from '@tangent/web-shared';
import { ReplyFields, replyChanges, replyFieldsOf } from '../ui/reply-fields';

let uid = 0;

/** A request that sends something. */
const changed = (req: object) => Object.keys(req).length > 0;

/**
 * Asks before a whole conversation is deleted. Shared by the settings dialog
 * and the conversation lists (home page, sidebar). True if the user agreed.
 */
export function confirmDeleteTree(title: string): boolean {
  return confirm(
    `Delete “${title}” with all its tangents and messages? Its shares stop working. This cannot be undone.`,
  );
}

/**
 * Conversation settings: the title and system prompt, how the main thread
 * replies (which new tangents from it start with) and its privacy, which
 * covers the whole conversation; and Delete. A tangent's own are in Tangent
 * settings.
 */
@Component({
  selector: 'app-tree-settings',
  imports: [Modal, Icon, ReplyFields],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <app-modal
      heading="Conversation settings"
      [openAt]="section() === 'replies' ? replies : null"
      [dirty]="dirty"
      (closed)="close()"
    >
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
            >System prompt <span class="muted">(sent with every tangent, in every mode)</span></span
          >
          <textarea
            rows="8"
            maxlength="20000"
            placeholder="Empty: your default system prompt (Settings), as it is when you send"
            [value]="systemPrompt()"
            (input)="systemPrompt.set(sp.value)"
            #sp
          ></textarea>
        </label>
        <fieldset class="settings-section" tabindex="-1" #replies>
          <legend>Main thread replies</legend>
          <p class="muted small">New tangents from the main thread start with these.</p>
          <app-reply-fields [(route)]="route" [(modelId)]="modelId" [(grounding)]="grounding" />
        </fieldset>
        <div class="field">
          <label class="check">
            <input
              type="checkbox"
              [attr.aria-describedby]="id + '-private'"
              [checked]="isPrivate()"
              (change)="isPrivate.set(!isPrivate())"
            />
            Private
          </label>
          <span class="muted small indent" [id]="id + '-private'"
            >Left out of shares and exports, with every tangent under it: the whole
            conversation.</span
          >
        </div>
        <div class="form-actions">
          <button type="button" class="btn btn-danger-ghost btn-left" (click)="remove()">
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
  /** The conversation's main thread. */
  readonly trunk = input.required<Branch>();
  /** Where it opens: at the main thread's replies (the route chip), else at its top. */
  readonly section = input<'replies' | null>(null);
  /**
   * The tree and its trunk as the form was filled from them, or as last
   * saved. Saving sends what the user changed from these, not from the live
   * ones: the first reply may have titled the tree meanwhile.
   */
  private readonly opened = signal<{ tree: Tree; trunk: Branch } | null>(null);
  protected readonly id = `ts${++uid}`;

  protected readonly title = signal('');
  protected readonly systemPrompt = signal('');
  /** Provider and funding of the main thread, as a `routeKey`. */
  protected readonly route = signal('');
  protected readonly modelId = signal('');
  protected readonly grounding = signal<GroundingMode>(DEFAULT_GROUNDING_MODE);
  protected readonly isPrivate = signal(false);
  protected readonly saving = signal(false);

  /** What Save sends: the conversation's fields and the main thread's that the user changed. */
  private readonly changes = computed<{
    treeReq: UpdateTreeRequest;
    trunkReq: UpdateBranchRequest;
  }>(() => {
    const opened = this.opened();
    if (!opened) return { treeReq: {}, trunkReq: {} };
    const { tree: t, trunk } = opened;
    const treeReq: UpdateTreeRequest = {};
    const title = this.title().trim();
    if (title && title !== t.title) treeReq.title = title;
    const sp = this.systemPrompt().trim() ? this.systemPrompt() : null;
    if (sp !== t.systemPrompt) treeReq.systemPrompt = sp;
    const trunkReq = replyChanges(trunk, {
      route: this.route(),
      modelId: this.modelId(),
      grounding: this.grounding(),
    });
    if (this.isPrivate() !== trunk.isPrivate) trunkReq.isPrivate = this.isPrivate();
    return { treeReq, trunkReq };
  });
  /** Edits that closing would lose. */
  protected readonly dirty = computed(() => {
    const { treeReq, trunkReq } = this.changes();
    return changed(treeReq) || changed(trunkReq);
  });

  ngOnInit(): void {
    const t = this.tree();
    const trunk = this.trunk();
    this.opened.set({ tree: t, trunk });
    this.title.set(t.title);
    this.systemPrompt.set(t.systemPrompt ?? '');
    const replies = replyFieldsOf(trunk);
    this.route.set(replies.route);
    this.modelId.set(replies.modelId);
    this.grounding.set(replies.grounding);
    this.isPrivate.set(trunk.isPrivate);
  }

  protected close(): void {
    this.ui.dialogs.close('tree-settings');
  }

  /**
   * Saves the main thread's fields, then the tree's: the main thread's are
   * the ones the server may refuse (a model, a payer the membership locks),
   * so a refusal leaves nothing saved. Both must be saved to close: when
   * either fails, its error shows and the dialog stays open with every edit,
   * so Save tries again. When only the main thread's were saved, the next
   * Save compares with what the server now has, so an edit taken back since
   * is sent too.
   */
  protected async save(): Promise<void> {
    const opened = this.opened();
    if (!opened) return;
    const { tree: t, trunk } = opened;
    const { treeReq, trunkReq } = this.changes();
    this.saving.set(true);
    let ok = true;
    if (changed(trunkReq)) {
      ok = await this.store.updateBranch(trunk.id, trunkReq);
      if (ok) {
        this.opened.set({ ...opened, trunk: this.store.index()?.branches.get(trunk.id) ?? trunk });
      }
    }
    if (ok && changed(treeReq)) ok = await this.store.updateTree(t.id, treeReq);
    this.saving.set(false);
    if (ok) this.close();
  }

  protected async remove(): Promise<void> {
    const t = this.tree();
    if (!confirmDeleteTree(t.title)) return;
    this.close();
    await this.store.deleteTree(t.id);
  }
}
