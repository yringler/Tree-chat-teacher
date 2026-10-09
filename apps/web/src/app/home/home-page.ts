import { DatePipe } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { sameChoice, TierStore, tierOptions } from '../state/tier-store';
import { TreeStore } from '../state/tree-store';
import { Composer, Icon, readOnlyText, Segmented, SidebarToggle } from '@tangent/web-shared';
import {
  maxUsageNote,
  parseRouteKey,
  providerRouteKey,
  routeKey,
  TIERS,
  type ModelTier,
  type TreeSummary,
} from '@tangent/shared';
import { confirmDeleteTree } from '../dialogs/tree-settings';
import { ImportButton } from '../ui/import-button';
import { ModelPicker } from '../ui/model-picker';

/**
 * `/`: start a new conversation (the tree is created on the first send) and
 * list existing ones, each with Delete (also while read-only: it generates nothing).
 */
@Component({
  selector: 'app-home-page',
  imports: [
    Composer,
    ModelPicker,
    RouterLink,
    Icon,
    ImportButton,
    DatePipe,
    Segmented,
    SidebarToggle,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <header class="page-head">
      <app-sidebar-toggle />
      <h1>New conversation</h1>
    </header>
    <div class="home">
      <section class="home-start">
        <p class="lead">
          Ask anything. Later, branch from any message to explore a tangent — with the full path, a
          summary, or a clean slate as context.
        </p>
        @if (readOnly(); as text) {
          <!-- Nothing to generate on: own keys need the membership the user lacks, and no credit is sold. -->
          <div class="read-only-panel home-read-only" role="region" aria-labelledby="home-ro-lead">
            <p class="read-only-text">
              <strong id="home-ro-lead">{{ text.lead }}</strong>
              {{ text.act }} to start new conversations on your own keys. Your conversations below
              stay readable.
            </p>
            <div class="read-only-actions">
              <a class="btn btn-primary" routerLink="/billing">{{ text.renew }}</a>
            </div>
          </div>
        } @else {
          @if (route() !== '') {
            @if (tiers.available(null)) {
              <!-- Normal | Max fills in the picker below; any other model can still be picked there. -->
              <div class="home-tiers">
                <app-segmented
                  label="Model tier"
                  [options]="tierOptions()"
                  [value]="tier()"
                  [disabled]="starting()"
                  (changed)="pickTier($event)"
                />
                @if (tier() === 'max') {
                  <span class="tier-note">{{ maxNote() }}</span>
                }
              </div>
            }
            <app-model-picker [(route)]="route" [(modelId)]="modelId" />
          }
          <app-composer
            sendLabel="Send message"
            placeholder="Start a conversation…"
            [autofocus]="true"
            [disabled]="starting()"
            (send)="start($event)"
          />
        }
      </section>

      <section class="home-list">
        <div class="section-head">
          <h2>Conversations</h2>
          <app-import-button />
        </div>
        @if (store.trees().length === 0 && store.treesLoaded()) {
          <p class="muted">Nothing here yet. Your conversations will appear here.</p>
        }
        <ul class="card-list">
          @for (t of store.trees(); track t.id) {
            <li class="tree-row">
              <a class="card card-link" [routerLink]="['/t', t.id]">
                <strong>{{ t.title }}</strong>
                <span class="muted small">
                  {{ t.branchCount }} {{ t.branchCount === 1 ? 'branch' : 'branches' }} ·
                  {{ t.messageCount }} {{ t.messageCount === 1 ? 'message' : 'messages' }} ·
                  {{ t.updatedAt | date: 'medium' }}
                </span>
              </a>
              <button
                type="button"
                class="icon-btn icon-btn-danger"
                [attr.aria-label]="'Delete ' + t.title"
                title="Delete conversation"
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
  host: { class: 'page' },
})
export class HomePage {
  protected readonly store = inject(TreeStore);
  protected readonly tiers = inject(TierStore);
  /** The picked provider and funding, as a `routeKey`. */
  protected readonly route = signal('');
  protected readonly modelId = signal('');
  protected readonly starting = signal(false);

  /**
   * Power is read-only throughout: every route's funding needs the
   * membership the user lacks and Tangent credit can't pay (not sold, or no
   * top-ups and none left), so a new conversation could never get a reply.
   * The notice's words, or null.
   */
  protected readonly readOnly = computed(() => {
    const m = this.store.account.membership();
    if (
      !m ||
      !this.store.account.providersLoaded() ||
      this.store.account.lockedFundings().size === 0
    )
      return null;
    if (this.store.account.canGenerate()) return null;
    return readOnlyText(m);
  });

  /** The tier the picker is on; null = another model. */
  protected readonly tier = computed<ModelTier | null>(() => {
    const route = this.route();
    if (!route) return null;
    const picked = { ...parseRouteKey(route), model: this.modelId().trim() };
    return (
      TIERS.find((t) => {
        const c = this.tiers.choice(t, null);
        return !!c && sameChoice(c, picked);
      }) ?? null
    );
  });

  protected readonly maxNote = computed(() => maxUsageNote(this.tiers.usageFactor(null)));

  protected readonly tierOptions = computed(() => tierOptions(this.maxNote()));

  constructor() {
    effect(() => {
      const p = this.store.account.defaultProvider();
      if (p && this.route() === '') {
        this.route.set(providerRouteKey(p));
        this.modelId.set(p.defaultModel);
      }
    });
  }

  protected async start(content: string): Promise<void> {
    this.starting.set(true);
    try {
      await this.store.startConversation(
        content,
        this.route() || null,
        this.modelId().trim() || null,
      );
    } finally {
      this.starting.set(false);
    }
  }

  /** Normal | Max: the picker takes that tier's provider and model. */
  protected pickTier(id: string): void {
    const tier = TIERS.find((t) => t === id);
    const c = tier ? this.tiers.choice(tier, null) : null;
    if (!c) return;
    this.route.set(routeKey(c));
    this.modelId.set(c.model);
  }

  protected remove(t: TreeSummary): void {
    if (!confirmDeleteTree(t.title)) return;
    void this.store.deleteTree(t.id);
  }
}
