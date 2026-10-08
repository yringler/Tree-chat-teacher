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
import { parseReview, splitTangents, type Branch, type ChatNode } from '@tangent/shared';
import {
  Icon,
  MarkdownView,
  RelatedLinks,
  relatedLinks,
  SourcesList,
  TangentAsk,
  type LinkNoteEdit,
  type RelatedLink,
} from '@tangent/web-shared';
import { copyText, selectionWithin } from '../core/selection';
import { confirmDeleteBranch } from '../dialogs/branch-settings';
import { ReviewStore } from '../state/review-store';
import { TreeStore } from '../state/tree-store';
import { UiStore } from '../state/ui-store';
import { ModeBadge } from '../ui/mode-badge';
import { ReviewVerdict } from '../ui/review-verdict';

/** One message of the linear branch view. */
@Component({
  selector: 'app-message-item',
  imports: [Icon, MarkdownView, ModeBadge, RelatedLinks, ReviewVerdict, SourcesList, TangentAsk],
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
        <span class="msg-actions">
          @if (pickState(); as p) {
            <!-- Pick mode ("Pick on the page instead"): this message can be the other end. -->
            <button
              type="button"
              class="btn btn-primary btn-sm link-here"
              [disabled]="p !== 'open'"
              (click)="linkHere($event)"
            >
              <app-icon name="link" [size]="14" />
              {{ pickLabels[p] }}
            </button>
          } @else {
            <!-- Without a route to generate on (no membership for own keys, no credit), no new branches or reviews. -->
            @if (store.canGenerate()) {
              <button
                type="button"
                class="btn btn-ghost btn-sm"
                (mousedown)="captureSelection()"
                (click)="branch($event)"
                title="Branch from here (b)"
              >
                <app-icon name="branch" [size]="14" /> Branch from here
              </button>
            }
            @if (reviewable() && canReview()) {
              <button
                type="button"
                class="btn btn-ghost btn-sm"
                (click)="openReview($event)"
                title="Have a stronger model check the conversation up to here (v)"
              >
                <app-icon name="review" [size]="14" /> Review
              </button>
            }
            <!-- Not a generating call: links stay available while power is read-only. -->
            <button
              type="button"
              class="btn btn-ghost btn-sm"
              (click)="openLinkDialog($event)"
              title="Link to another message (l)"
            >
              <app-icon name="link" [size]="14" /> Link…
            </button>
            <button
              type="button"
              class="icon-btn"
              [attr.aria-label]="copied() ? 'Copied' : 'Copy message'"
              (click)="copy($event)"
            >
              <app-icon name="copy" [size]="14" />
            </button>
          }
        </span>
      </header>

      @if (streaming() && liveStatus()) {
        <p class="msg-status muted small">{{ liveStatus() }}</p>
      }
      <!-- data-node-id: the chat page maps a text selection in here to this message ("Ask about this"). -->
      <div
        #body
        class="msg-body md"
        [attr.data-node-id]="n.id"
        [appMarkdown]="bodyText()"
        [streaming]="streaming()"
      ></div>
      @if (streaming()) {
        <span class="cursor" aria-hidden="true"></span>
        <span class="sr-only">Generating…</span>
      }
      @if (review(); as r) {
        <button type="button" class="review-chip" (click)="openReview($event)">
          <app-icon name="review" [size]="13" />
          @switch (r.phase) {
            @case ('running') {
              <span>Reviewing…</span>
            }
            @case ('error') {
              <span>Review failed</span>
            }
            @default {
              <span>Reviewed</span>
              <app-review-verdict
                [accuracy]="verdict()?.accuracy ?? null"
                [recommendation]="verdict()?.recommendation ?? null"
              />
            }
          }
        </button>
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

      <app-sources-list
        [node]="n"
        [depth]="depth()"
        [canCheck]="canCheck()"
        [checking]="checking()"
        (check)="checkSources()"
        (click)="$event.stopPropagation()"
      />

      @if (tangents().length > 0 || canAsk()) {
        <nav class="tangents" aria-label="Tangents worth following">
          <span class="tangents-label muted small">Where next?</span>
          @for (t of tangents(); track t.title) {
            <button
              type="button"
              class="tangent"
              [class.is-followed]="followed().has(t.title)"
              [class.is-on]="followedOn().has(t.title)"
              [disabled]="opening() !== null || (locked() && !followed().has(t.title))"
              [title]="
                followed().has(t.title)
                  ? 'Open the branch that follows this'
                  : locked()
                    ? 'Following it needs a membership (this branch is on your own key)'
                    : 'Branch off and ask about this (keeps the conversation so far)'
              "
              (click)="follow($event, t.title)"
            >
              <app-icon [name]="followed().has(t.title) ? 'chevronRight' : 'branch'" [size]="14" />
              <span class="tangent-title">{{ t.title }}</span>
              @if (t.why) {
                <span class="tangent-why muted">{{ t.why }}</span>
              }
            </button>
          }
          @if (canAsk()) {
            <!-- The user's own question, branched off like a tangent. -->
            <app-tangent-ask
              [(text)]="askText"
              label="Ask your own question in a new branch"
              settingsLabel="Branch settings: context, model, quote…"
              [expandable]="true"
              [reveal]="true"
              [busy]="asking()"
              [latest]="latest()"
              [disabled]="locked()"
              disabledTitle="Asking needs a membership (this branch is on your own key)"
              (ask)="ask($event)"
              (settings)="askWithSettings($event)"
              (click)="$event.stopPropagation()"
            />
          }
        </nav>
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
                <li class="fork-row">
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
                  <!-- Delete without going through the outline (shown on hover or keyboard focus). -->
                  <span class="row-actions">
                    <button
                      type="button"
                      class="icon-btn icon-btn-danger"
                      [attr.aria-label]="'Delete ' + b.title"
                      title="Delete branch"
                      (click)="remove($event, b)"
                    >
                      <app-icon name="trash" [size]="13" />
                    </button>
                  </span>
                </li>
              }
            </ul>
          }
        </div>
      }

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
  private readonly reviews = inject(ReviewStore);

  readonly node = input.required<ChatNode>();
  readonly ancestor = input(false);
  readonly focused = input(false);
  readonly chainIds = input<ReadonlySet<string>>(new Set());

  private readonly bodyRef = viewChild.required<string, ElementRef<HTMLElement>>('body', {
    read: ElementRef,
  });
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
  /** The reply split from its `<tangents>` block (never rendered as text, even half-streamed). */
  private readonly split = computed(() =>
    this.node().role === 'assistant'
      ? splitTangents(this.content())
      : { body: this.content(), tangents: [], partial: false },
  );
  protected readonly bodyText = computed(() => this.split().body);
  protected readonly reviewable = computed(
    () => this.node().role === 'assistant' && this.node().status === 'complete',
  );
  /** The assistant's suggested tangents, offered once the reply is complete. */
  protected readonly tangents = computed(() => (this.reviewable() ? this.split().tangents : []));
  /** Titles of the tangents already followed (a child branch carries the title). */
  protected readonly followed = computed<ReadonlySet<string>>(() => {
    const titles = new Set(this.tangents().map((t) => t.title));
    return new Set(
      this.children()
        .map((b) => b.title)
        .filter((t) => titles.has(t)),
    );
  });
  /** Followed tangents on the selected branch's chain. */
  protected readonly followedOn = computed<ReadonlySet<string>>(() => {
    const on = this.chainIds();
    return new Set(
      this.children()
        .filter((b) => on.has(b.id))
        .map((b) => b.title),
    );
  });
  protected readonly depth = computed(() => this.store.depthOf(this.node().branchId));
  protected readonly canCheck = computed(
    () => this.reviewable() && this.store.canCheckSources(this.node().branchId),
  );
  protected readonly checking = signal(false);

  protected async checkSources(): Promise<void> {
    if (this.checking() || this.store.busy()) return;
    this.checking.set(true);
    try {
      await this.store.checkSources(this.node().id);
    } finally {
      this.checking.set(false);
    }
  }

  /** Title of the tangent whose branch is being created. */
  protected readonly opening = signal<string | null>(null);
  protected readonly review = computed(() => this.reviews.reviews().get(this.node().id) ?? null);
  protected readonly verdict = computed(() => {
    const r = this.review();
    return r?.phase === 'done' ? parseReview(r.text) : null;
  });
  protected readonly children = computed(() => this.store.childBranchesAt(this.node().id));
  /** The message's branch can't generate (its funding needs the membership the user lacks). */
  private readonly ownBranch = computed(
    () => this.store.index()?.branches.get(this.node().branchId) ?? null,
  );
  protected readonly locked = computed(() => {
    const b = this.ownBranch();
    return !!b && this.store.routeLocked(b);
  });
  protected readonly canReview = computed(() => this.store.canReview(this.ownBranch()));
  /** The message's links, resolved to their other ends. */
  protected readonly related = computed<RelatedLink[]>(() => {
    const idx = this.store.index();
    return idx ? relatedLinks(idx, this.store.linksByNode(), this.node().id) : [];
  });
  protected readonly relatedOpen = computed(() => this.ui.relatedOpen().has(this.node().id));
  /**
   * In pick mode, what "Link here" does on this message: `open` links it;
   * the message linked from (`source`) and those already linked can't be picked.
   */
  protected readonly pickState = computed<'open' | 'source' | 'linked' | null>(() => {
    const from = this.ui.linkPick()?.fromNodeId;
    if (from === undefined) return null;
    const id = this.node().id;
    if (id === from) return 'source';
    return this.related().some((r) => r.nodeId === from) ? 'linked' : 'open';
  });
  protected readonly pickLabels = {
    open: 'Link here',
    source: 'Linking from here',
    linked: 'Already linked',
  } as const;
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

  protected openReview(e: Event): void {
    e.stopPropagation();
    this.ui.reviewDialog.set({ nodeId: this.node().id });
  }

  protected openLinkDialog(e: Event): void {
    e.stopPropagation();
    this.ui.linkDialog.set({ fromNodeId: this.node().id });
  }

  protected async linkHere(e: Event): Promise<void> {
    e.stopPropagation();
    const pick = this.ui.linkPick();
    if (!pick || this.pickState() !== 'open') return;
    this.ui.linkPick.set(null);
    await this.store.createLink(pick.fromNodeId, this.node().id);
  }

  protected async removeLink(linkId: string): Promise<void> {
    const title = this.related().find((r) => r.link.id === linkId)?.title ?? 'that message';
    if (!confirm(`Remove the link to “${title}”? It goes from both messages.`)) return;
    await this.store.deleteLink(linkId);
  }

  protected editNote(edit: LinkNoteEdit): void {
    void this.store.updateLinkNote(edit.linkId, edit.note);
  }

  protected async follow(e: Event, title: string): Promise<void> {
    e.stopPropagation();
    if (this.opening() !== null || (this.locked() && !this.followed().has(title))) return;
    this.opening.set(title);
    try {
      await this.store.followTangent(this.node().id, title);
    } finally {
      this.opening.set(null);
    }
  }

  /** "Ask your own": offered wherever tangents are, while a branch can be generated on. */
  protected readonly canAsk = computed(() => this.reviewable() && this.store.canGenerate());
  protected readonly askText = signal('');
  protected readonly asking = signal(false);
  /** The open branch's newest reply: its "Ask your own" starts open (TangentAsk `latest`). */
  protected readonly latest = computed(() => {
    const n = this.node();
    return (
      n.role === 'assistant' &&
      n.status === 'complete' &&
      n.branchId === this.store.selectedBranchId() &&
      this.store.path().at(-1)?.id === n.id
    );
  });

  protected async ask(text: string): Promise<void> {
    if (this.asking() || this.locked()) return;
    this.asking.set(true);
    try {
      // Kept on failure, to try again.
      if (await this.store.askFrom(this.node().id, text)) this.askText.set('');
    } finally {
      this.asking.set(false);
    }
  }

  /** The gear: the branch dialog, sending the question once the branch is set up. */
  protected askWithSettings(text: string): void {
    this.ui.branchDialog.set({
      fromNodeId: this.node().id,
      quote: null,
      ...(text ? { message: text, onCreated: () => this.askText.set('') } : {}),
    });
  }

  protected async copy(e: Event): Promise<void> {
    e.stopPropagation();
    if (await copyText(this.split().body)) {
      this.copied.set(true);
      this.ui.notify('Copied to clipboard');
      setTimeout(() => this.copied.set(false), 1500);
    }
  }

  protected async remove(e: Event, b: Branch): Promise<void> {
    e.stopPropagation();
    await confirmDeleteBranch(this.store, b.id);
  }

  protected jump(e: Event, b: Branch): void {
    e.stopPropagation();
    this.store.go(b.id, this.store.firstNodeOf(b.id)?.id ?? null);
  }
}
