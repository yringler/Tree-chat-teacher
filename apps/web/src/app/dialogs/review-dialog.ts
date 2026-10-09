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
import { parseReview, parseRouteKey, routeKey, type BranchFunding } from '@tangent/shared';
import { copyText } from '../core/selection';
import { Icon, MarkdownService, Modal, TypesetMath } from '@tangent/web-shared';
import { ReviewStore } from '../state/review-store';
import { TreeStore } from '../state/tree-store';
import { UiStore } from '../state/ui-store';
import { ModelPicker } from '../ui/model-picker';
import { ReviewVerdict } from '../ui/review-verdict';

const EXCERPT_CHARS = 280;

/**
 * "Review up to here": pick a reviewer model, stream its review, then act on
 * it: send the corrections back into the thread, move the branch to the
 * reviewer's model, or branch off on it.
 */
@Component({
  selector: 'app-review-dialog',
  imports: [Modal, ModelPicker, Icon, ReviewVerdict, TypesetMath],
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
              >Reviewed by <strong>{{ labelOf(r, r.model) }}</strong></span
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
            <div class="md review-body" [innerHTML]="html()" [appTypesetMath]="html()"></div>
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
                  <app-icon name="refresh" /> Continue this branch with
                  {{ labelOf(r, r.model) }}
                </button>
              }
              <button
                type="button"
                class="btn btn-ghost"
                [disabled]="acting()"
                (click)="branchWithReviewer()"
              >
                <app-icon name="branch" /> Branch here with {{ labelOf(r, r.model) }}
              </button>
              <button type="button" class="icon-btn" aria-label="Copy review" (click)="copy()">
                <app-icon name="copy" [size]="14" />
              </button>
            </div>
          }

          @if (choice(); as c) {
            <form class="form review-form" (submit)="$event.preventDefault(); run()">
              <app-model-picker [(route)]="route" [(modelId)]="modelId" />
              <div class="form-actions">
                <button
                  type="button"
                  class="btn btn-ghost btn-left"
                  (click)="ui.settingsOpen.set(true); close()"
                >
                  <app-icon name="gear" /> Default reviewer…
                </button>
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
  protected readonly ui = inject(UiStore);
  private readonly md = inject(MarkdownService);

  readonly nodeId = input.required<string>();

  /** The reviewer's provider and funding, as a `routeKey`. */
  protected readonly route = signal('');
  protected readonly modelId = signal('');
  protected readonly acting = signal(false);

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
  protected readonly excerpt = computed(() => {
    const text = plainText(this.node()?.content ?? '');
    return text.length > EXCERPT_CHARS ? `${text.slice(0, EXCERPT_CHARS - 1)}…` : text;
  });
  /** The branch already runs on the reviewer's model. */
  protected readonly sameModel = computed(() => {
    const r = this.review();
    const b = this.continueBranch();
    return !!r && !!b && routeKey(r) === routeKey(b) && r.model === b.model;
  });

  ngOnInit(): void {
    const previous = this.review();
    const start = previous ?? this.reviews.defaultReviewer(this.branch());
    if (start) {
      this.route.set(routeKey(start));
      this.modelId.set(start.model);
    }
  }

  protected labelOf(route: { providerId: string; funding?: BranchFunding }, model: string): string {
    const p = this.store.account.providerOf(route);
    return p?.models.find((m) => m.id === model)?.label ?? model;
  }

  protected run(): void {
    const c = this.choice();
    if (c) void this.reviews.start(this.nodeId(), c);
  }

  protected sendCorrections(): void {
    const r = this.review();
    if (!r) return;
    this.ui.insertIntoComposer(
      `A reviewer (${this.labelOf(r, r.model)}) checked your earlier answer and ` +
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
      this.ui.notify(`“${b.title}” now uses ${this.labelOf(r, r.model)}`);
      if (b.id !== this.store.selectedBranchId()) this.store.go(b.id);
      this.close();
    }
  }

  protected async branchWithReviewer(): Promise<void> {
    const r = this.review();
    if (!r) return;
    this.acting.set(true);
    const branch = await this.store.createBranch({
      fromNodeId: this.nodeId(),
      contextMode: 'path',
      providerId: r.providerId,
      funding: r.funding ?? 'own-key',
      model: r.model,
    });
    this.acting.set(false);
    if (branch) this.close();
  }

  protected async copy(): Promise<void> {
    if (await copyText(this.parsed().body)) this.ui.notify('Review copied');
  }

  protected openKeys(): void {
    this.close();
    this.ui.keysDialog.set({ provider: null });
  }

  protected close(): void {
    this.ui.reviewDialog.set(null);
  }
}
