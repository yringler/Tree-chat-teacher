import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import {
  maxUsageNote,
  POOL_FUNDING_TEXT,
  poolModelText,
  tierModel,
  tierOf,
  type PoolStatusResponse,
  type TreeSummary,
} from '@tangent/shared';
import { Icon, PoolMeter } from '@tangent/web-shared';
import { Composer } from '../chat/composer';
import { lessonTitle } from '../chat/titles';
import { ModelToggle } from '../chat/model-toggle';
import { KeyLockedNotice } from '../chat/key-locked-notice';
import { AccountStore } from '../state/account-store';
import { ImportLessonButton } from './import-lesson-button';
import { PaidBy } from '../shell/paid-by';
import { LessonStore } from '../state/lesson-store';
import { UiStore } from '../state/ui-store';

/** `/learn/`: start a new lesson, list the existing ones (Export, Delete) and import one. */
@Component({
  selector: 'app-home-page',
  imports: [
    Composer,
    ModelToggle,
    PoolMeter,
    RouterLink,
    Icon,
    ImportLessonButton,
    PaidBy,
    DatePipe,
    KeyLockedNotice,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="page-body">
      @if (account.needsKey()) {
        <p class="notice" role="status">
          Replies run on your own OpenRouter key, and none is saved in this browser yet.
          <button type="button" class="link-btn" (click)="ui.dialogs.open({ kind: 'access' })">
            Add your key{{
              account.payment.builtInCredit() && account.payment.creditUsable()
                ? ' or use Tangent credit'
                : ''
            }}
          </button>
        </p>
      }
      <section class="new-lesson card" aria-labelledby="new-lesson-title">
        <h1 id="new-lesson-title">New lesson</h1>
        <p class="muted">
          Name a topic or ask a first question (optional). Every answer ends with tangents you can
          follow, and you can select any part of an answer to ask about it on the side.
        </p>
        <form class="form" (submit)="$event.preventDefault(); start()">
          <app-composer
            inputId="new-lesson-topic"
            label="Topic or first question"
            placeholder="e.g. Why is the sky blue?"
            [autofocus]="true"
            [hideSend]="true"
            [clearOnSend]="false"
            [disabled]="starting()"
            (draft)="topic.set($event)"
            (send)="start()"
          />
          @if (account.membershipBlocked()) {
            <!-- The own key needs a membership the learner lacks: the ways out, not Start. -->
            <app-key-locked-notice />
          } @else {
            <div class="new-lesson-actions">
              @if (store.models().length > 1) {
                <app-model-toggle
                  [models]="store.models()"
                  [value]="account.poolModel()?.id ?? model()"
                  [disabled]="starting()"
                  [lockedHint]="account.poolModelHint()"
                  (changed)="pickedModel.set($event)"
                />
              }
              <div class="start-group">
                <app-paid-by />
                <button type="submit" class="btn btn-primary" [disabled]="starting()">
                  <app-icon name="plus" /> Start lesson
                </button>
              </div>
            </div>
            @if (maxNote(); as note) {
              <p class="tier-note" role="status">{{ note }}</p>
            }
          }
        </form>
      </section>

      @if (pool(); as status) {
        <section class="card pool-card" aria-labelledby="pool-title">
          <h2 id="pool-title">Open pool</h2>
          <app-pool-meter [status]="status" />
          <p class="muted small">
            {{ funding }} Any signed-in learner can use it, on {{ poolModelName(status) }}, within
            daily limits. <a href="/pool" target="_blank" rel="noopener">How it works</a>
          </p>
        </section>
      }

      <section class="lessons" aria-labelledby="lessons-title">
        <div class="lessons-head">
          <h2 id="lessons-title">Your lessons</h2>
          <app-import-lesson-button />
        </div>
        @if (!store.treesLoaded()) {
          <p class="muted">Loading…</p>
        } @else if (store.trees().length === 0) {
          <p class="muted">No lessons yet. Start one above, or import a backup.</p>
        }
        <ul class="card-list">
          @for (t of store.trees(); track t.id) {
            <li class="lesson-row">
              <a class="card card-link" [routerLink]="['/t', t.id]">
                <strong>{{ lessonTitle(t.title) }}</strong>
                <span class="muted small">
                  {{ t.updatedAt | date: 'mediumDate' }}
                  @if (t.branchCount > 1) {
                    · {{ t.branchCount - 1 }}
                    {{ t.branchCount === 2 ? 'side question' : 'side questions' }}
                  }
                </span>
              </a>
              <button
                type="button"
                class="icon-btn"
                [attr.aria-label]="'Export ' + lessonTitle(t.title)"
                title="Export (download a backup)"
                [disabled]="store.exportingId() !== null"
                (click)="store.exportLesson(t.id)"
              >
                <app-icon name="download" />
              </button>
              <button
                type="button"
                class="icon-btn"
                [attr.aria-label]="'Delete ' + lessonTitle(t.title)"
                title="Delete lesson"
                (click)="remove(t)"
              >
                <app-icon name="trash" />
              </button>
            </li>
          }
        </ul>
      </section>
    </div>
  `,
  host: { class: 'page home-page' },
})
export class HomePage {
  protected readonly store = inject(LessonStore);
  protected readonly account = inject(AccountStore);
  protected readonly ui = inject(UiStore);
  protected readonly lessonTitle = lessonTitle;
  protected readonly topic = signal('');
  protected readonly pickedModel = signal<string | null>(null);
  protected readonly starting = signal(false);
  /** The learner's pick, else the provider's default (Normal). */
  protected readonly model = computed(() => this.pickedModel() ?? this.store.defaultModel());
  /** "Max uses about 14× as much as Normal." while Max is picked (not on the pool, which picks for them). */
  protected readonly maxNote = computed(() => {
    const models = this.store.models();
    if (this.account.poolModel() || tierOf(models, this.model()) !== 'max') return null;
    return maxUsageNote(tierModel(models, 'max')?.usageFactor);
  });
  /** The open pool's meter while the pool is on (never in the demo, where it is off). */
  protected readonly pool = computed(() => {
    const status = this.account.poolStatus();
    return status?.enabled ? status : null;
  });

  /** Where the pool's credit comes from. */
  protected readonly funding = POOL_FUNDING_TEXT;

  /** The pool's model, as the copy names it (`poolModelText`). */
  protected poolModelName(status: PoolStatusResponse): string {
    return poolModelText(status.model);
  }

  protected async start(): Promise<void> {
    // Enter in the topic box while the own key is locked: the notice offers the ways out.
    if (this.starting() || this.account.membershipBlocked()) return;
    this.starting.set(true);
    try {
      await this.store.startLesson(this.model(), this.topic());
    } finally {
      this.starting.set(false);
    }
  }

  protected remove(t: TreeSummary): void {
    if (!confirm(`Delete the lesson “${lessonTitle(t.title)}” with all its side questions?`))
      return;
    void this.store.deleteTree(t.id);
  }
}
