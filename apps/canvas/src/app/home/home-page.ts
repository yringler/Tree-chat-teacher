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
import type { TreeSummary } from '@tangent/shared';
import { Icon } from '@tangent/web-shared';
import { treeTitle } from '../canvas/titles';
import { CanvasStore } from '../state/canvas-store';
import { UiStore } from '../state/ui-store';

/** `/canvas/`: start a conversation and open the existing ones (the power account's). */
@Component({
  selector: 'app-home-page',
  imports: [RouterLink, Icon, DatePipe],
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
                <select #ps [value]="providerId()" (change)="pickProvider(ps.value)">
                  @for (p of store.providers(); track p.id) {
                    <option
                      [value]="p.id"
                      [disabled]="!p.available"
                      [selected]="p.id === providerId()"
                    >
                      {{ p.label }}{{ p.available ? '' : ' — no key' }}
                    </option>
                  }
                </select>
              </label>
              <label class="field">
                <span class="field-label">Model</span>
                <select #ms [value]="model()" (change)="pickModel(ms.value)">
                  @for (m of models(); track m.id) {
                    <option [value]="m.id" [selected]="m.id === model()">{{ m.label }}</option>
                  }
                </select>
              </label>
            </div>
            <button
              type="submit"
              class="btn btn-primary"
              [disabled]="starting() || !text().trim() || !providerId()"
            >
              <app-icon name="plus" /> Open on the canvas
            </button>
          </div>
          @if (store.providers().length > 0 && !store.defaultProvider()?.available) {
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
  private readonly pickedProvider = signal<string | null>(null);
  private readonly pickedModel = signal<string | null>(null);

  protected readonly providerId = computed(
    () => this.pickedProvider() ?? this.store.defaultProvider()?.id ?? '',
  );
  protected readonly models = computed(
    () => this.store.providerMap().get(this.providerId())?.models ?? [],
  );
  protected readonly model = computed(() => {
    const picked = this.pickedModel();
    if (picked && this.models().some((m) => m.id === picked)) return picked;
    return this.store.providerMap().get(this.providerId())?.defaultModel ?? '';
  });

  constructor() {
    afterNextRender(() => {
      if (matchMedia('(hover: hover)').matches) this.box()?.nativeElement.focus();
    });
  }

  protected pickProvider(id: string): void {
    this.pickedProvider.set(id);
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
      await this.store.startConversation(content, this.providerId() || null, this.model() || null);
    } finally {
      this.starting.set(false);
    }
  }

  protected remove(t: TreeSummary): void {
    if (!confirm(`Delete “${treeTitle(t.title)}” with all its lanes?`)) return;
    void this.store.deleteTree(t.id);
  }
}
