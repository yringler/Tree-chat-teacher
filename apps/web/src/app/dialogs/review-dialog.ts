import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  type OnInit,
  signal,
} from '@angular/core';
import { plainText } from '@tangent/shared';
import { parseReview, parseRouteKey, routeKey } from '@tangent/shared';
import { copyText } from '../core/selection';
import {
  ComposerController,
  errorMessage,
  Icon,
  MarkdownService,
  Modal,
  RenderDiagrams,
  ToastStore,
  TypesetMath,
} from '@tangent/web-shared';
import { ReviewStore } from '../state/review-store';
import { type ModelChoice, savedChoice, SettingsStore } from '../state/settings-store';
import { threadTitle } from '../state/thread-title';
import { sameChoice, TierStore } from '../state/tier-store';
import { TreeStore } from '../state/tree-store';
import { UiStore } from '../state/ui-store';
import { ModelPicker } from '../ui/model-picker';
import { ReviewVerdict } from '../ui/review-verdict';

const EXCERPT_CHARS = 280;

let uid = 0;

/**
 * "Review up to here": pick a reviewer model (and keep it as the default
 * reviewer, which "Use as my default reviewer" saves as it is ticked),
 * stream its review, then act on it: send the corrections back into the
 * thread, move the branch to the reviewer's model, or branch off on it.
 */
@Component({
  selector: 'app-review-dialog',
  imports: [Modal, ModelPicker, Icon, RenderDiagrams, ReviewVerdict, TypesetMath],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <app-modal heading="Review up to here" [wide]="true" (closed)="close()">
      @if (node(); as n) {
        <p class="muted small">
          The reviewer reads the conversation exactly as {{ n.model ?? 'the model' }} saw it, up to
          and including this reply, and checks it for mistakes.
        </p>
        <blockquote class="excerpt">{{ excerpt() }}</blockquote>

        @if (review(); as r) {
          <div class="review-head">
            <span class="small"
              >Reviewed by <strong>{{ tiers.modelLabel(r) }}</strong></span
            >
            <app-review-verdict
              [accuracy]="parsed().accuracy"
              [recommendation]="parsed().recommendation"
            />
          </div>
          @if (r.status) {
            <p class="msg-status muted small">{{ r.status }}</p>
          }
          @if (parsed().body) {
            <div
              class="md review-body"
              [innerHTML]="html()"
              [appTypesetMath]="html()"
              [appRenderDiagrams]="html()"
              [diagramsPaused]="r.phase === 'running'"
            ></div>
          }
          @if (r.phase === 'running') {
            <span class="cursor" aria-hidden="true"></span>
            <span class="sr-only">Reviewing…</span>
          }
          @if (r.phase === 'error') {
            <p class="notice notice-error" role="alert">{{ r.error }}</p>
          }
          @if (r.usage) {
            <p class="muted small">
              {{ r.usage.inputTokens }} input · {{ r.usage.outputTokens }} output tokens
            </p>
          }
        }

        @if (review()?.phase === 'running') {
          <div class="form-actions">
            <button type="button" class="btn btn-danger" (click)="reviews.stop(n.id)">
              <app-icon name="stop" /> Stop
            </button>
          </div>
        } @else {
          @if (review()?.phase === 'done' && review(); as r) {
            <div class="review-actions">
              @if (parsed().body && parsed().accuracy !== 'ok') {
                <button type="button" class="btn btn-ghost" (click)="sendCorrections()">
                  <app-icon name="send" /> Add corrections to the message box
                </button>
              }
              @if (!sameModel()) {
                <button
                  type="button"
                  class="btn"
                  [class.btn-primary]="parsed().recommendation === 'upgrade'"
                  [class.btn-ghost]="parsed().recommendation !== 'upgrade'"
                  [disabled]="acting()"
                  (click)="switchBranch()"
                >
                  <app-icon name="refresh" /> Continue this thread with
                  {{ tiers.modelLabel(r) }}
                </button>
              }
              <button
                type="button"
                class="btn btn-ghost"
                [disabled]="acting()"
                (click)="branchWithReviewer()"
              >
                <app-icon name="tangent" /> Tangent here with {{ tiers.modelLabel(r) }}…
              </button>
              <button type="button" class="icon-btn" aria-label="Copy review" (click)="copy()">
                <app-icon name="copy" [size]="14" />
              </button>
            </div>
          }

          @if (choice(); as c) {
            <form class="form review-form" (submit)="$event.preventDefault(); run()">
              <app-model-picker [(route)]="route" [(modelId)]="modelId" />
              <div class="field">
                <label class="check">
                  <input
                    type="checkbox"
                    [attr.aria-describedby]="id + '-default'"
                    [checked]="isDefault()"
                    [disabled]="!c.providerId || !c.model || savingDefault()"
                    (change)="setDefault(box)"
                    #box
                  />
                  Use as my default reviewer
                </label>
                <span class="muted small indent" [id]="id + '-default'">{{ defaultNote() }}</span>
              </div>
              <div class="form-actions">
                <button type="button" class="btn btn-ghost" (click)="close()">Close</button>
                <button type="submit" class="btn btn-primary" autofocus [disabled]="!c.providerId">
                  <app-icon name="review" /> {{ review() ? 'Review again' : 'Review' }}
                </button>
              </div>
            </form>
          } @else {
            <p class="notice">
              No provider has an API key, so there is no model to review with.
              <button type="button" class="link-btn" (click)="openKeys()">Add a key</button>
            </p>
          }
        }
      } @else {
        <p class="muted">This message is no longer available.</p>
      }
    </app-modal>
  `,
})
export class ReviewDialog implements OnInit {
  protected readonly store = inject(TreeStore);
  protected readonly reviews = inject(ReviewStore);
  private readonly ui = inject(UiStore);
  /** Names models as power does: "Normal" and "Max" are only the user's tiers. */
  protected readonly tiers = inject(TierStore);
  private readonly settings = inject(SettingsStore);
  private readonly composer = inject(ComposerController);
  private readonly toast = inject(ToastStore);
  private readonly md = inject(MarkdownService);

  readonly nodeId = input.required<string>();

  /** The reviewer's provider and funding, as a `routeKey`. */
  protected readonly route = signal('');
  protected readonly modelId = signal('');
  protected readonly acting = signal(false);
  /** "Use as my default reviewer" is being saved. */
  protected readonly savingDefault = signal(false);
  protected readonly id = `rv${++uid}`;

  protected readonly node = computed(() => this.store.index()?.nodes.get(this.nodeId()) ?? null);
  protected readonly branch = computed(() => {
    const n = this.node();
    return (n && this.store.index()?.branches.get(n.branchId)) || null;
  });
  /**
   * Branch that "continue with" moves: the one being viewed when the reviewed
   * message is on its path (the thread the user continues), else the message's own.
   */
  protected readonly continueBranch = computed(() => {
    const n = this.node();
    const selected = this.store.selectedBranch();
    if (n && selected && this.store.path().some((p) => p.id === n.id)) return selected;
    return this.branch();
  });
  protected readonly review = computed(() => this.reviews.reviews().get(this.nodeId()) ?? null);
  protected readonly parsed = computed(() => parseReview(this.review()?.text ?? ''));
  protected readonly html = computed(() =>
    this.md.render(this.parsed().body, this.review()?.phase !== 'running'),
  );
  protected readonly choice = computed(() =>
    this.route() ? { ...parseRouteKey(this.route()), model: this.modelId().trim() } : null,
  );
  protected readonly excerpt = computed(() =>
    plainText(this.node()?.content ?? '', { max: EXCERPT_CHARS }),
  );
  /**
   * "Use as my default reviewer" is ticked while the picked model is the
   * saved default, so picking another unticks it: a one-off review never
   * replaces the default unless it is ticked again.
   */
  protected readonly isDefault = computed(() => {
    const saved = this.settings.settings().reviewer;
    const c = this.choice();
    return !!saved && !!c && sameChoice(saved, c);
  });
  /** The branch already runs on the reviewer's model. */
  protected readonly sameModel = computed(() => {
    const r = this.review();
    const b = this.continueBranch();
    return !!r && !!b && routeKey(r) === routeKey(b) && r.model === b.model;
  });

  /**
   * The default reviewer by what it is: the saved one, or the default model
   * of the thread's provider, which is often the model it chats with; where
   * that provider can't be used (no key here, or a funding the membership
   * locks), another provider's (`threadReviewer`), which it names.
   */
  protected readonly defaultNote = computed(() => {
    const saved = this.settings.settings().reviewer;
    if (saved) return `Your default: ${this.tiers.modelLabel(saved)} on ${this.payer(saved)}.`;
    const branch = this.branch();
    const here = this.reviews.threadReviewer(branch);
    const thread = 'Your default: same provider as the thread, its default model';
    if (!here) return `${thread}.`;
    if (branch && routeKey(here) !== routeKey(branch)) {
      return (
        `Your default: the default model of the thread's provider, which can't be used ` +
        `here, so ${this.tiers.modelLabel(here)} on ${this.payer(here)}.`
      );
    }
    return `${thread} (here: ${this.tiers.modelLabel(here)}).`;
  });

  ngOnInit(): void {
    const previous = this.review();
    const start = previous ?? this.reviews.defaultReviewer(this.branch());
    if (start) {
      this.route.set(routeKey(start));
      this.modelId.set(start.model);
    }
  }

  protected run(): void {
    const c = this.choice();
    if (c) void this.reviews.start(this.nodeId(), c);
  }

  /**
   * "Use as my default reviewer", saved to the account as it is toggled,
   * like the label says, so closing keeps it: ticked, the picked model
   * becomes the default; unticked, the default goes back to the thread's
   * provider's. The box waits for the save; one that fails says so, and the
   * box shows the saved default again.
   */
  protected async setDefault(box: HTMLInputElement): Promise<void> {
    const c = this.choice();
    const reviewer = box.checked && c?.providerId && c.model ? savedChoice(c) : null;
    if (!reviewer && !this.isDefault()) return;
    this.savingDefault.set(true);
    try {
      await this.settings.save({ reviewer });
    } catch (err) {
      this.toast.notify(`Couldn't save your default reviewer: ${errorMessage(err)}`, 'error');
    } finally {
      this.savingDefault.set(false);
      box.checked = this.isDefault();
    }
  }

  private payer(c: ModelChoice): string {
    return this.store.account.providerOf(c)?.label ?? c.providerId;
  }

  protected sendCorrections(): void {
    const r = this.review();
    if (!r) return;
    this.composer.insert(
      `A reviewer (${this.tiers.modelLabel(r)}) checked your earlier answer and ` +
        `flagged the following. Please correct course where they are right:\n\n${this.parsed().body}`,
    );
    this.close();
  }

  protected async switchBranch(): Promise<void> {
    const r = this.review();
    const b = this.continueBranch();
    if (!r || !b) return;
    this.acting.set(true);
    const ok = await this.store.updateBranch(b.id, {
      providerId: r.providerId,
      funding: r.funding ?? 'own-key',
      model: r.model,
    });
    this.acting.set(false);
    if (ok) {
      this.toast.notify(`“${threadTitle(b)}” now uses ${this.tiers.modelLabel(r)}`);
      if (b.id !== this.store.selectedBranchId()) this.store.go(b.id);
      this.close();
    }
  }

  /** "Tangent here with …": the tangent dialog on the reviewer's model, to write its first message. */
  protected branchWithReviewer(): void {
    const r = this.review();
    if (!r) return;
    this.close();
    this.ui.dialogs.open({
      kind: 'branch',
      fromNodeId: this.nodeId(),
      quote: null,
      route: { providerId: r.providerId, funding: r.funding ?? 'own-key', model: r.model },
    });
  }

  protected async copy(): Promise<void> {
    if (await copyText(this.parsed().body)) this.toast.notify('Review copied');
  }

  protected openKeys(): void {
    this.close();
    this.ui.dialogs.open({ kind: 'keys', provider: null });
  }

  protected close(): void {
    this.ui.dialogs.close('review');
  }
}
