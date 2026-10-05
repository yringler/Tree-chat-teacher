import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import type { TreeSummary } from '@tangent/shared';
import { Icon, PoolMeter } from '@tangent/web-shared';
import { Composer } from '../chat/composer';
import { lessonTitle } from '../chat/titles';
import { ModelToggle } from '../chat/model-toggle';
import { AccountStore } from '../state/account-store';
import { LessonStore } from '../state/lesson-store';
import { UiStore } from '../state/ui-store';

/** `/learn/`: start a new lesson and list the existing ones. */
@Component({
  selector: 'app-home-page',
  imports: [Composer, ModelToggle, PoolMeter, RouterLink, Icon, DatePipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="page-body">
      @if (account.needsKey()) {
        <p class="notice" role="status">
          Replies run on your own OpenRouter key, and none is saved in this browser yet.
          <button type="button" class="link-btn" (click)="ui.accessOpen.set(true)">
            Add your key{{ account.payment.builtInCredit() ? ' or use Tangent credit' : '' }}
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
            <button type="submit" class="btn btn-primary" [disabled]="starting()">
              <app-icon name="plus" /> Start lesson
            </button>
          </div>
        </form>
      </section>

      @if (pool(); as status) {
        <section class="card pool-card" aria-labelledby="pool-title">
          <h2 id="pool-title">Community pool</h2>
          <app-pool-meter [status]="status" />
          <p class="muted small">
            @if (status.fundingOpen) {
              Credit anyone can add and any signed-in learner can use, on {{ status.model.label }},
              within daily limits. <a href="/pool" target="_blank" rel="noopener">How it works</a> ·
              <a routerLink="/billing" fragment="fund-pool">Fund the pool</a>
            } @else {
              Credit Tangent adds and any signed-in learner can use, on {{ status.model.label }},
              within daily limits.
              <a href="/pool" target="_blank" rel="noopener">How it works</a>
            }
          </p>
        </section>
      }

      <section class="lessons" aria-labelledby="lessons-title">
        <h2 id="lessons-title">Your lessons</h2>
        @if (!store.treesLoaded()) {
          <p class="muted">Loading…</p>
        } @else if (store.trees().length === 0) {
          <p class="muted">No lessons yet. Start one above.</p>
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
  /** The learner's pick, else the provider's default ("Smart"). */
  protected readonly model = computed(() => this.pickedModel() ?? this.store.defaultModel());
  /** The community pool's meter while the pool is on (never in the demo, where it is off). */
  protected readonly pool = computed(() => {
    const status = this.account.poolStatus();
    return status?.enabled ? status : null;
  });

  protected async start(): Promise<void> {
    if (this.starting()) return;
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
    void this.store.deleteLesson(t.id);
  }
}
