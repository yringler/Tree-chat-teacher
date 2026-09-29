import {
  ChangeDetectionStrategy,
  Component,
  computed,
  ElementRef,
  inject,
  input,
  signal,
  viewChild,
} from '@angular/core';
import type { Branch, ChatNode } from '@tangent/shared';
import { MarkdownService } from '../core/markdown.service';
import { copyText, selectionWithin } from '../core/selection';
import { TreeStore } from '../state/tree-store';
import { UiStore } from '../state/ui-store';
import { Icon } from '../ui/icon';
import { ModeBadge } from '../ui/mode-badge';

/** One message of the linear branch view. */
@Component({
  selector: 'app-message-item',
  imports: [Icon, ModeBadge],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @let n = node();
    <article
      class="msg msg-{{ n.role }}"
      [class.msg-ancestor]="ancestor()"
      [class.msg-focused]="focused()"
      [class.msg-error]="n.status === 'error'"
      [attr.id]="'msg-' + n.id"
      [attr.aria-current]="focused() ? 'true' : null"
      (click)="onClick()"
    >
      <header class="msg-head">
        <span class="msg-role">{{ roleLabel() }}</span>
        @if (n.role === 'assistant' && n.model) {
          <span class="muted small">{{ n.model }}</span>
        }
        <span class="msg-actions">
          <button
            type="button"
            class="btn btn-ghost btn-sm"
            (mousedown)="captureSelection()"
            (click)="branch($event)"
            title="Branch from here (b)"
          >
            <app-icon name="branch" [size]="14" /> Branch from here
          </button>
          <button
            type="button"
            class="icon-btn"
            [attr.aria-label]="copied() ? 'Copied' : 'Copy message'"
            (click)="copy($event)"
          >
            <app-icon name="copy" [size]="14" />
          </button>
        </span>
      </header>

      @if (streaming() && liveStatus()) {
        <p class="msg-status muted small">{{ liveStatus() }}</p>
      }
      <div #body class="msg-body md" [innerHTML]="html()"></div>
      @if (streaming()) {
        <span class="cursor" aria-hidden="true"></span>
        <span class="sr-only">Generating…</span>
      }
      @if (n.status === 'error') {
        <div class="msg-error-box" role="alert">
          <strong>{{ n.error === 'cancelled' ? 'Stopped.' : 'The reply failed.' }}</strong>
          @if (n.error && n.error !== 'cancelled') {
            <span>{{ n.error }}</span>
          }
          <span class="muted small"
            >To retry, send your message again (or branch from the previous message).</span
          >
        </div>
      }

      @if (children().length > 0) {
        <div class="forks">
          <button
            type="button"
            class="fork-toggle"
            [attr.aria-expanded]="forksOpen()"
            (click)="$event.stopPropagation(); forksOpen.set(!forksOpen())"
          >
            <app-icon name="branch" [size]="13" />
            {{ children().length }} {{ children().length === 1 ? 'branch' : 'branches' }}
            <app-icon [name]="forksOpen() ? 'chevronDown' : 'chevronRight'" [size]="13" />
          </button>
          @if (forksOpen()) {
            <ul class="fork-list">
              @for (b of children(); track b.id) {
                <li>
                  <button
                    type="button"
                    class="fork-link"
                    [class.in-chain]="chainIds().has(b.id)"
                    (click)="jump($event, b)"
                  >
                    <span class="outline-title">{{ b.title }}</span>
                    <app-mode-badge [mode]="b.contextMode" />
                    @if (b.isPrivate) {
                      <app-icon name="lock" [size]="12" />
                    }
                    <span class="count">{{ countOf(b.id) }}</span>
                  </button>
                </li>
              }
            </ul>
          }
        </div>
      }
    </article>
  `,
  host: { style: 'display: contents' },
})
export class MessageItem {
  private readonly store = inject(TreeStore);
  private readonly ui = inject(UiStore);
  private readonly md = inject(MarkdownService);

  readonly node = input.required<ChatNode>();
  readonly ancestor = input(false);
  readonly focused = input(false);
  readonly chainIds = input<ReadonlySet<string>>(new Set());

  private readonly bodyRef = viewChild.required<ElementRef<HTMLElement>>('body');
  protected readonly forksOpen = signal(false);
  protected readonly copied = signal(false);
  private pendingQuote: string | null = null;

  private readonly live = computed(() => this.store.live().get(this.node().id) ?? null);
  protected readonly streaming = computed(() => this.node().status === 'streaming');
  protected readonly liveStatus = computed(() => {
    const l = this.live();
    if (!l) return null;
    return l.reconnecting ? 'Reconnecting…' : l.status;
  });
  protected readonly content = computed(() => this.live()?.content ?? this.node().content);
  protected readonly html = computed(() => this.md.render(this.content(), !this.streaming()));
  protected readonly children = computed(() => this.store.childBranchesAt(this.node().id));
  protected readonly roleLabel = computed(() => {
    const r = this.node().role;
    return r === 'user' ? 'You' : r === 'assistant' ? 'Assistant' : 'System';
  });

  protected countOf(branchId: string): number {
    return this.store.index()?.nodesByBranch.get(branchId)?.length ?? 0;
  }

  protected onClick(): void {
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed) return; // selecting text, not focusing
    if (!this.focused()) this.store.focus(this.node().id);
  }

  /** Mousedown runs before the click collapses the selection. */
  protected captureSelection(): void {
    this.pendingQuote = selectionWithin(this.bodyRef().nativeElement);
  }

  protected branch(e: Event): void {
    e.stopPropagation();
    const quote = this.pendingQuote ?? selectionWithin(this.bodyRef().nativeElement);
    this.pendingQuote = null;
    this.ui.branchDialog.set({ fromNodeId: this.node().id, quote });
  }

  protected async copy(e: Event): Promise<void> {
    e.stopPropagation();
    if (await copyText(this.content())) {
      this.copied.set(true);
      this.ui.notify('Copied to clipboard');
      setTimeout(() => this.copied.set(false), 1500);
    }
  }

  protected jump(e: Event, b: Branch): void {
    e.stopPropagation();
    this.store.go(b.id, this.store.firstNodeOf(b.id)?.id ?? null);
  }
}
