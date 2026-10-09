import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { splitTangents, type ChatNode } from '@tangent/shared';
import {
  MarkdownService,
  RelatedLinks,
  relatedLinks,
  SourcesList,
  TypesetMath,
  type LinkNoteEdit,
  type RelatedLink,
} from '@tangent/web-shared';
import { TreeStore } from '../state/tree-store';
import { UiStore } from '../state/ui-store';
import { ForkList } from './fork-list';
import { MessageActions, type PickState } from './message-actions';
import { MessageStatus } from './message-status';
import { ReviewChip } from './review-chip';
import { TangentNav } from './tangent-nav';

/**
 * One message of the linear branch view: its header (role, model, actions),
 * its text, then what hangs off it: the review, why it isn't whole, its
 * sources, where to go next, the branches started from it and its links.
 */
@Component({
  selector: 'app-message-item',
  imports: [
    ForkList,
    MessageActions,
    MessageStatus,
    RelatedLinks,
    ReviewChip,
    SourcesList,
    TangentNav,
    TypesetMath,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @let n = node();
    <article
      class="msg msg-{{ n.role }}"
      [class.msg-ancestor]="ancestor()"
      [class.msg-focused]="focused()"
      [class.msg-error]="n.status === 'error'"
      [class.msg-picking]="pickState() !== null"
      [attr.id]="'msg-' + n.id"
      [attr.data-node-id]="n.id"
      [attr.aria-current]="focused() ? 'true' : null"
      (click)="onClick()"
    >
      <header class="msg-head">
        <span class="msg-role">{{ roleLabel() }}</span>
        @if (n.role === 'assistant' && n.model) {
          <span class="muted small">{{ n.model }}</span>
        }
        <app-message-actions [node]="n" [body]="body" [text]="split().body" [pick]="pickState()" />
      </header>

      @if (streaming() && liveStatus()) {
        <p class="msg-status muted small">{{ liveStatus() }}</p>
      }
      <!-- data-node-id: the chat page maps a text selection in here to this message ("Ask about this"). -->
      <div
        #body
        class="msg-body md"
        [attr.data-node-id]="n.id"
        [innerHTML]="html()"
        [appTypesetMath]="html()"
      ></div>
      @if (streaming()) {
        <span class="cursor" aria-hidden="true"></span>
        <span class="sr-only">Generating…</span>
      }
      <app-review-chip [nodeId]="n.id" />
      <app-message-status [node]="n" />

      <app-sources-list
        [node]="n"
        [depth]="depth()"
        [canCheck]="canCheck()"
        [checking]="checking()"
        (check)="checkSources()"
        (click)="$event.stopPropagation()"
      />

      @if (complete()) {
        <app-tangent-nav
          [node]="n"
          [tangents]="split().tangents"
          [children]="children()"
          [chainIds]="chainIds()"
        />
      }
      <app-fork-list [branches]="children()" [chainIds]="chainIds()" />

      <app-related-links
        [entries]="related()"
        [canEdit]="true"
        [expanded]="relatedOpen()"
        (expandedChange)="ui.setRelatedOpen([n.id], $event)"
        (open)="store.openNode($event, n.id)"
        (remove)="removeLink($event)"
        (editNote)="editNote($event)"
      />
    </article>
  `,
  host: { style: 'display: contents' },
})
export class MessageItem {
  protected readonly store = inject(TreeStore);
  protected readonly ui = inject(UiStore);
  private readonly md = inject(MarkdownService);

  readonly node = input.required<ChatNode>();
  readonly ancestor = input(false);
  readonly focused = input(false);
  readonly chainIds = input<ReadonlySet<string>>(new Set());

  private readonly live = computed(() => this.store.live().get(this.node().id) ?? null);
  protected readonly streaming = computed(() => this.node().status === 'streaming');
  protected readonly liveStatus = computed(() => {
    const l = this.live();
    if (!l) return null;
    return l.reconnecting ? 'Reconnecting…' : l.status;
  });
  private readonly content = computed(() => this.live()?.content ?? this.node().content);
  /** The reply split from its `<tangents>` block (never rendered as text, even half-streamed). */
  protected readonly split = computed(() =>
    this.node().role === 'assistant'
      ? splitTangents(this.content())
      : { body: this.content(), tangents: [], partial: false },
  );
  protected readonly html = computed(() => this.md.render(this.split().body, !this.streaming()));
  /** A finished reply: it can be checked and followed on. */
  protected readonly complete = computed(
    () => this.node().role === 'assistant' && this.node().status === 'complete',
  );
  protected readonly depth = computed(() => this.store.depthOf(this.node().branchId));
  protected readonly canCheck = computed(
    () => this.complete() && this.store.canCheckSources(this.node().branchId),
  );
  protected readonly checking = signal(false);
  protected readonly children = computed(() => this.store.childBranchesAt(this.node().id));
  /** The message's links, resolved to their other ends. */
  protected readonly related = computed<RelatedLink[]>(() => {
    const idx = this.store.index();
    return idx ? relatedLinks(idx, this.store.linksByNode(), this.node().id) : [];
  });
  protected readonly relatedOpen = computed(() => this.ui.relatedOpen().has(this.node().id));
  /** In pick mode, what "Link here" does on this message. */
  protected readonly pickState = computed<PickState | null>(() => {
    const from = this.ui.linkPick()?.fromNodeId;
    if (from === undefined) return null;
    if (this.node().id === from) return 'source';
    return this.related().some((r) => r.nodeId === from) ? 'linked' : 'open';
  });
  protected readonly roleLabel = computed(() => {
    const r = this.node().role;
    return r === 'user' ? 'You' : r === 'assistant' ? 'Assistant' : 'System';
  });

  protected onClick(): void {
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed) return; // selecting text, not focusing
    if (!this.focused()) this.store.focus(this.node().id);
  }

  protected async checkSources(): Promise<void> {
    if (this.checking() || this.store.busy()) return;
    this.checking.set(true);
    try {
      await this.store.checkSources(this.node().id);
    } finally {
      this.checking.set(false);
    }
  }

  protected async removeLink(linkId: string): Promise<void> {
    const title = this.related().find((r) => r.link.id === linkId)?.title ?? 'that message';
    if (!confirm(`Remove the link to “${title}”? It goes from both messages.`)) return;
    await this.store.deleteLink(linkId);
  }

  protected editNote(edit: LinkNoteEdit): void {
    void this.store.updateLinkNote(edit.linkId, edit.note);
  }
}
