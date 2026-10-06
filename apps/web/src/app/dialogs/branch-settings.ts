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
  GROUNDING_MODES,
  parseRouteKey,
  routeKey,
  type Branch,
  type ContextMode,
  type GroundingMode,
  type UpdateBranchRequest,
} from '@tangent/shared';
import { TreeStore } from '../state/tree-store';
import { UiStore } from '../state/ui-store';
import { Icon, Modal } from '@tangent/web-shared';
import { ModelPicker } from '../ui/model-picker';
import { ModePicker } from '../ui/mode-picker';

/**
 * Asks, then deletes a branch with every branch below it. Shared by the
 * settings dialog and the outline. Resolves true if it was deleted.
 */
export async function confirmDeleteBranch(store: TreeStore, branchId: string): Promise<boolean> {
  const idx = store.index();
  const branch = idx?.branches.get(branchId);
  if (!idx || !branch?.parentBranchId) return false;
  let branches = 0;
  let messages = 0;
  const stack = [branch];
  for (let b = stack.pop(); b; b = stack.pop()) {
    branches++;
    messages += idx.nodesByBranch.get(b.id)?.length ?? 0;
    stack.push(...(idx.childBranches.get(b.id) ?? []));
  }
  const what =
    branches > 1
      ? `“${branch.title}” and the ${branches - 1} branch${branches === 2 ? '' : 'es'} below it (${messages} message${messages === 1 ? '' : 's'})`
      : `“${branch.title}” (${messages} message${messages === 1 ? '' : 's'})`;
  if (
    !confirm(
      `Delete ${what}? Replies still generating there are stopped, and shares of its messages stop working. This cannot be undone.`,
    )
  )
    return false;
  return store.deleteBranch(branchId);
}

/** Edit the selected branch: title, mode, anchor quote, privacy, provider/model; delete it. */
@Component({
  selector: 'app-branch-settings',
  imports: [Icon, Modal, ModePicker, ModelPicker],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <app-modal heading="Branch settings" (closed)="close()">
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

        @if (branch().parentBranchId) {
          <app-mode-picker [(mode)]="mode" />
          <label class="field">
            <span class="field-label">Anchor quote</span>
            <textarea rows="3" [value]="quote()" (input)="quote.set(q.value)" #q></textarea>
          </label>
        } @else {
          <p class="muted small">This is the trunk: it has no parent context, mode or anchor.</p>
        }

        @if (route()) {
          <app-model-picker [(route)]="route" [(modelId)]="modelId" />
        }

        <label class="field">
          <span class="field-label">Check facts with web search</span>
          <select
            #g
            [value]="grounding()"
            [disabled]="!canSearch()"
            (change)="grounding.set(asGrounding(g.value))"
          >
            <option value="auto" [selected]="grounding() === 'auto'">
              When a reply likely needs it (deep tangents, specific facts)
            </option>
            <option value="always" [selected]="grounding() === 'always'">
              Offer it on every reply
            </option>
            <option value="off" [selected]="grounding() === 'off'">
              Off (Check sources still works)
            </option>
          </select>
          <span class="muted small">
            @if (canSearch()) {
              The model decides whether to search, at most once per reply. A search costs about
              $0.007 at OpenRouter. New branches inherit this setting.
            } @else {
              This provider can't search the web; use an OpenRouter model to check facts.
            }
          </span>
        </label>

        <label class="check">
          <input type="checkbox" [checked]="isPrivate()" (change)="isPrivate.set(!isPrivate())" />
          Private (excluded from shares and exports, with everything below it)
        </label>

        <div class="form-actions">
          @if (branch().parentBranchId) {
            <button type="button" class="btn btn-danger btn-left" (click)="remove()">
              <app-icon name="trash" /> Delete branch
            </button>
          }
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
  readonly branch = input.required<Branch>();

  protected readonly title = signal('');
  protected readonly mode = signal<ContextMode>('path');
  protected readonly quote = signal('');
  protected readonly isPrivate = signal(false);
  /** Provider and funding, as a `routeKey`. */
  protected readonly route = signal('');
  protected readonly modelId = signal('');
  protected readonly saving = signal(false);
  protected readonly grounding = signal<GroundingMode>(DEFAULT_GROUNDING_MODE);
  protected readonly canSearch = computed(() => {
    const { providerId, funding } = parseRouteKey(this.route());
    return this.store
      .providers()
      .some(
        (p) => p.id === providerId && (p.funding ?? 'own-key') === funding && p.webSearch === true,
      );
  });

  protected asGrounding(value: string): GroundingMode {
    return (GROUNDING_MODES as readonly string[]).includes(value)
      ? (value as GroundingMode)
      : DEFAULT_GROUNDING_MODE;
  }

  ngOnInit(): void {
    const b = this.branch();
    this.title.set(b.title);
    this.mode.set(b.contextMode);
    this.quote.set(b.anchorQuote ?? '');
    this.isPrivate.set(b.isPrivate);
    this.route.set(routeKey(b));
    this.modelId.set(b.model);
    this.grounding.set(b.grounding ?? DEFAULT_GROUNDING_MODE);
  }

  protected close(): void {
    this.ui.branchSettingsOpen.set(false);
  }

  protected async remove(): Promise<void> {
    if (await confirmDeleteBranch(this.store, this.branch().id)) this.close();
  }

  protected async save(): Promise<void> {
    const b = this.branch();
    const req: UpdateBranchRequest = {};
    const title = this.title().trim();
    if (title && title !== b.title) req.title = title;
    if (b.parentBranchId) {
      if (this.mode() !== b.contextMode) req.contextMode = this.mode();
      const quote = this.quote().trim() || null;
      if (quote !== b.anchorQuote) req.anchorQuote = quote;
    }
    if (this.isPrivate() !== b.isPrivate) req.isPrivate = this.isPrivate();
    if (this.grounding() !== (b.grounding ?? DEFAULT_GROUNDING_MODE)) {
      req.grounding = this.grounding();
    }
    const model = this.modelId().trim();
    if (this.route() !== routeKey(b) || model !== b.model) {
      const { providerId, funding } = parseRouteKey(this.route());
      req.providerId = providerId;
      req.funding = funding;
      req.model = model;
    }
    if (Object.keys(req).length === 0) {
      this.close();
      return;
    }
    this.saving.set(true);
    const ok = await this.store.updateBranch(b.id, req);
    this.saving.set(false);
    if (ok) {
      this.ui.notify('Branch updated');
      this.close();
    }
  }
}
