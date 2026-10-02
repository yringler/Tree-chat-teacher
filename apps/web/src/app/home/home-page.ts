import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, effect, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Composer } from '../chat/composer';
import { TreeStore } from '../state/tree-store';
import { UiStore } from '../state/ui-store';
import { Icon } from '@tangent/web-shared';
import { ImportButton } from '../ui/import-button';
import { ModelPicker } from '../ui/model-picker';

/** `/`: start a new conversation (the tree is created on the first send) and list existing ones. */
@Component({
  selector: 'app-home-page',
  imports: [Composer, ModelPicker, RouterLink, Icon, ImportButton, DatePipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <header class="page-head">
      <button
        type="button"
        class="icon-btn only-narrow"
        aria-label="Open menu"
        aria-controls="sidebar"
        [attr.aria-expanded]="ui.drawerOpen()"
        (click)="ui.drawerOpen.set(true)"
      >
        <app-icon name="menu" />
      </button>
      <h1>New conversation</h1>
    </header>
    <div class="home">
      <section class="home-start">
        <p class="lead">
          Ask anything. Later, branch from any message to explore a tangent — with the full path, a
          summary, or a clean slate as context.
        </p>
        @if (providerId() !== '') {
          <app-model-picker [(providerId)]="providerId" [(modelId)]="modelId" />
        }
        <app-composer
          placeholder="Start a conversation…"
          [autofocus]="true"
          [disabled]="starting()"
          (send)="start($event)"
        />
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
            <li>
              <a class="card card-link" [routerLink]="['/t', t.id]">
                <strong>{{ t.title }}</strong>
                <span class="muted small">
                  {{ t.branchCount }} {{ t.branchCount === 1 ? 'branch' : 'branches' }} ·
                  {{ t.messageCount }} {{ t.messageCount === 1 ? 'message' : 'messages' }} ·
                  {{ t.updatedAt | date: 'medium' }}
                </span>
              </a>
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
  protected readonly ui = inject(UiStore);
  protected readonly providerId = signal('');
  protected readonly modelId = signal('');
  protected readonly starting = signal(false);

  constructor() {
    effect(() => {
      const p = this.store.defaultProvider();
      if (p && this.providerId() === '') {
        this.providerId.set(p.id);
        this.modelId.set(p.defaultModel);
      }
    });
  }

  protected async start(content: string): Promise<void> {
    this.starting.set(true);
    try {
      await this.store.startConversation(
        content,
        this.providerId() || null,
        this.modelId().trim() || null,
      );
    } finally {
      this.starting.set(false);
    }
  }
}
