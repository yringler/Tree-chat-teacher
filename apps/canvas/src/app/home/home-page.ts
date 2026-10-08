import { DatePipe } from '@angular/common';
import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  ElementRef,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { providerRouteKey, type TreeSummary } from '@tangent/shared';
import { Icon } from '@tangent/web-shared';
import { treeTitle } from '../canvas/titles';
import { CanvasStore } from '../state/canvas-store';
import { UiStore } from '../state/ui-store';
import { ModelField, routeSuffix } from '../dialogs/model-field';

/** `/canvas/`: start a conversation and open the existing ones (the power account's). */
@Component({
  selector: 'app-home-page',
  imports: [RouterLink, Icon, DatePipe, ModelField],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="page-body">
      <section class="intro">
        <h1>Every branch, side by side.</h1>
        <p class="lead">
          Canvas lays a conversation out as a map: each branch is a lane, lanes hang off the message
          they fork from, and all of them can stream at once. Branch from any message into several
          variants and watch the answers arrive next to each other.
        </p>
      </section>

      <section class="new-tree card" aria-labelledby="new-tree-title">
        <h2 id="new-tree-title">New conversation</h2>
        <form class="form" (submit)="$event.preventDefault(); start()">
          <label class="field">
            <span class="sr-only">First message</span>
            <textarea
              #box
              rows="3"
              placeholder="Ask anything. The first lane opens with your question."
              [value]="text()"
              (input)="text.set(box.value)"
              (keydown)="onKey($event)"
            ></textarea>
          </label>
          <div class="new-tree-actions">
            <div class="field-row">
              <label class="field">
                <span class="field-label">Provider</span>
                <select #ps [value]="route()" (change)="pickProvider(ps.value)">
                  @for (p of store.providers(); track key(p)) {
                    <option
                      [value]="key(p)"
                      [disabled]="!p.available || store.routeLocked(p)"
                      [selected]="key(p) === route()"
                    >
                      {{ p.label }}{{ suffix(p, store.routeLocked(p)) }}
                    </option>
                  }
                </select>
              </label>
              <app-model-field
                [provider]="provider()"
                [model]="model()"
                (modelChange)="pickModel($event)"
              />
            </div>
            <button
              type="submit"
              class="btn btn-primary"
              [disabled]="starting() || !text().trim() || !route()"
            >
              <app-icon name="plus" /> Open on the canvas
            </button>
          </div>
          @if (store.defaultProvider()?.available === false) {
            <p class="notice">
              No provider has a key yet.
              <button type="button" class="link-btn" (click)="ui.keysOpen.set(true)">
                Add your API key
              </button>
            </p>
          }
        </form>
      </section>

      <section class="trees" aria-labelledby="trees-title">
        <h2 id="trees-title">Your conversations</h2>
        <p class="muted small">
          The same ones as in Power mode. Open any of them here to see its whole tree.
        </p>
        @if (!store.treesLoaded()) {
          <p class="muted">Loading…</p>
        } @else if (store.trees().length === 0) {
          <p class="muted">No conversations yet. Start one above.</p>
        }
        <ul class="card-list">
          @for (t of store.trees(); track t.id) {
            <li class="tree-row">
              <a class="card card-link" [routerLink]="['/t', t.id]">
                <strong>{{ treeTitle(t.title) }}</strong>
                <span class="muted small">
                  {{ t.updatedAt | date: 'mediumDate' }} · {{ t.branchCount }}
                  {{ t.branchCount === 1 ? 'lane' : 'lanes' }} · {{ t.messageCount }}
                  {{ t.messageCount === 1 ? 'message' : 'messages' }}
                </span>
              </a>
              <button
                type="button"
                class="icon-btn"
                [attr.aria-label]="'Delete ' + treeTitle(t.title)"
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
  host: { class: 'page home-page' },
})
export class HomePage {
  protected readonly store = inject(CanvasStore);
  protected readonly ui = inject(UiStore);
  protected readonly treeTitle = treeTitle;
  private readonly box = viewChild<ElementRef<HTMLTextAreaElement>>('box');
  protected readonly text = signal('');
  protected readonly starting = signal(false);
  protected readonly key = providerRouteKey;
  protected readonly suffix = routeSuffix;
  /** The picked provider and funding, as a `routeKey`. */
  private readonly pickedRoute = signal<string | null>(null);
  private readonly pickedModel = signal<string | null>(null);

  protected readonly route = computed(() => {
    const fallback = this.store.defaultProvider();
    return this.pickedRoute() ?? (fallback ? providerRouteKey(fallback) : '');
  });
  protected readonly provider = computed(() => this.store.providerMap().get(this.route()) ?? null);
  /** The picked model while the provider offers it (any typed id on an `openModels` one). */
  protected readonly model = computed(() => {
    const picked = this.pickedModel();
    const p = this.provider();
    if (picked !== null && (p?.openModels || p?.models.some((m) => m.id === picked))) return picked;
    return p?.defaultModel ?? '';
  });

  constructor() {
    afterNextRender(() => {
      if (matchMedia('(hover: hover)').matches) this.box()?.nativeElement.focus();
    });
  }

  protected pickProvider(route: string): void {
    this.pickedRoute.set(route);
    this.pickedModel.set(null);
  }

  protected pickModel(id: string): void {
    this.pickedModel.set(id);
  }

  protected onKey(e: KeyboardEvent): void {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      void this.start();
    }
  }

  protected async start(): Promise<void> {
    const content = this.text().trim();
    if (!content || this.starting()) return;
    this.starting.set(true);
    try {
      await this.store.startConversation(
        content,
        this.route() || null,
        this.model().trim() || null,
      );
    } finally {
      this.starting.set(false);
    }
  }

  protected remove(t: TreeSummary): void {
    if (!confirm(`Delete “${treeTitle(t.title)}” with all its lanes?`)) return;
    void this.store.deleteTree(t.id);
  }
}
