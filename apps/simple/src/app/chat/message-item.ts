import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { splitTangents, type ChatNode } from '@tangent/shared';
import {
  Icon,
  MarkdownService,
  RelatedLinks,
  relatedLinks,
  SourcesList,
  TangentAsk,
  TypesetMath,
  type LinkNoteEdit,
} from '@tangent/web-shared';
import { LessonStore } from '../state/lesson-store';
import { UiStore } from '../state/ui-store';
import { connectedLabel, connectionTitleOf, learnConnections } from './connections';
import { confirmDeleteSideQuestion } from './delete-side-question';
import { branchTitle } from './titles';

/** One message of the lesson; `data-node-id` lets the chat page map a text selection to it. */
@Component({
  selector: 'app-message-item',
  imports: [Icon, RelatedLinks, SourcesList, TangentAsk, TypesetMath],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @let n = node();
    <article
      class="msg msg-{{ n.role }}"
      [class.msg-ancestor]="ancestor()"
      [class.msg-focused]="focused()"
      [class.msg-error]="n.status === 'error'"
      [attr.id]="'msg-' + n.id"
      [attr.data-node-id]="n.id"
    >
      <header class="msg-head">
        <span class="msg-role">{{ n.role === 'user' ? 'You' : 'Tutor' }}</span>
        @if (askable()) {
          <button
            type="button"
            class="btn btn-ghost btn-sm msg-ask"
            title="Start a side question about this message"
            (click)="store.askAbout(n.id, null)"
          >
            <app-icon name="branch" [size]="14" /> Side question
          </button>
          <button
            type="button"
            class="btn btn-ghost btn-sm msg-connect"
            title="Connect this message to another one of the lesson"
            (click)="ui.linkDialog.set(n.id)"
          >
            <app-icon name="link" [size]="14" /> Connect
          </button>
        }
      </header>

      @if (streaming() && liveStatus()) {
        <p class="msg-status muted small">{{ liveStatus() }}</p>
      }
      <div class="msg-body md" [innerHTML]="html()" [appTypesetMath]="html()"></div>
      @if (streaming()) {
        <span class="cursor" aria-hidden="true"></span>
        <span class="sr-only">Writing…</span>
      }
      @if (n.status === 'error') {
        <div class="msg-error-box" role="alert">
          <strong>{{ n.error === 'cancelled' ? 'Stopped.' : 'The reply failed.' }}</strong>
          @if (n.error && n.error !== 'cancelled') {
            <span>{{ n.error }}</span>
          }
          <span class="muted small">To try again, send your message again.</span>
        </div>
      }

      <app-sources-list
        [node]="n"
        [depth]="depth()"
        [canCheck]="canCheck()"
        [checking]="checking()"
        (check)="checkSources()"
      />

      @if (askable()) {
        <nav class="tangents" aria-label="Tangents worth following">
          <span class="tangents-label muted small">Where next?</span>
          @for (t of tangents(); track t.title) {
            <button
              type="button"
              class="tangent"
              [class.is-followed]="followed().has(t.title)"
              [class.is-on]="followedOn().has(t.title)"
              [disabled]="opening() !== null"
              [title]="followed().has(t.title) ? 'Open this side question' : (t.why ?? t.title)"
              (click)="follow(t.title)"
            >
              <app-icon [name]="followed().has(t.title) ? 'chevronRight' : 'branch'" [size]="14" />
              <span class="tangent-title">{{ t.title }}</span>
              @if (t.why) {
                <span class="tangent-why muted">{{ t.why }}</span>
              }
            </button>
          }
          <app-tangent-ask
            [(text)]="askText"
            label="Ask your own question as a side question"
            [busy]="asking()"
            [latest]="latest()"
            (ask)="ask($event)"
          />
        </nav>
      }

      @if (otherChildren().length > 0) {
        <nav class="side-questions" [attr.aria-label]="'Side questions from this message'">
          <span class="muted small">
            <app-icon name="branch" [size]="13" />
            {{ otherChildren().length }}
            {{ otherChildren().length === 1 ? 'side question' : 'side questions' }}
          </span>
          @for (b of otherChildren(); track b.id) {
            <span class="chip-row">
              <button
                type="button"
                class="chip"
                [class.is-on]="chainIds().has(b.id)"
                [title]="b.anchorQuote ?? branchTitle(b)"
                (click)="store.go(b.id)"
              >
                {{ branchTitle(b) }}
              </button>
              <!-- Delete it from here (shown on hover or keyboard focus, always on touch). -->
              <button
                type="button"
                class="icon-btn icon-btn-danger chip-delete"
                [attr.aria-label]="'Delete the side question ' + branchTitle(b)"
                title="Delete this side question"
                (click)="remove(b.id)"
              >
                <app-icon name="trash" [size]="13" />
              </button>
            </span>
          }
        </nav>
      }

      <app-related-links
        class="connections"
        [entries]="connections()"
        [canEdit]="true"
        [collapsible]="false"
        [label]="connectedLabel"
        noun="connection"
        (open)="store.openNode($event, n.id)"
        (remove)="removeConnection($event)"
        (editNote)="editNote($event)"
      />
    </article>
  `,
  host: { class: 'msg-host' },
})
export class MessageItem {
  protected readonly store = inject(LessonStore);
  protected readonly ui = inject(UiStore);
  private readonly md = inject(MarkdownService);
  protected readonly branchTitle = branchTitle;
  protected readonly connectedLabel = connectedLabel;

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
  protected readonly content = computed(() => this.live()?.content ?? this.node().content);
  /** The reply split from its `<tangents>` block (never rendered as text, even half-streamed). */
  private readonly split = computed(() =>
    this.node().role === 'assistant'
      ? splitTangents(this.content())
      : { body: this.content(), tangents: [], partial: false },
  );
  /** Rendered by the shared markdown pipeline; [innerHTML] adds Angular's sanitizer on top. */
  protected readonly html = computed(() => this.md.render(this.split().body, !this.streaming()));
  protected readonly askable = computed(
    () => this.node().role === 'assistant' && this.node().status === 'complete',
  );
  /** The tutor's suggested tangents, offered once the reply is complete. */
  protected readonly tangents = computed(() => (this.askable() ? this.split().tangents : []));
  protected readonly children = computed(() => this.store.childBranchesAt(this.node().id));
  /** Titles of the tangents the learner already followed (a child branch carries the title). */
  protected readonly followed = computed<ReadonlySet<string>>(() => {
    const titles = new Set(this.tangents().map((t) => t.title));
    return new Set(
      this.children()
        .map((b) => b.title)
        .filter((t) => titles.has(t)),
    );
  });
  /** Followed tangents on the current path. */
  protected readonly followedOn = computed<ReadonlySet<string>>(() => {
    const on = this.chainIds();
    return new Set(
      this.children()
        .filter((b) => on.has(b.id))
        .map((b) => b.title),
    );
  });
  /** Side questions that are not followed tangents (those show in the tangents row). */
  protected readonly otherChildren = computed(() => {
    const followed = this.followed();
    return this.children().filter((b) => !followed.has(b.title));
  });
  protected readonly depth = computed(() => this.store.depthOf(this.node().branchId));
  /** A finished reply on a provider that can search, while nothing else is generating. */
  protected readonly canCheck = computed(
    () => this.askable() && this.store.canCheckSources(this.node().branchId),
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

  /** This message's connections to other messages, as chips (titles in Learn's words). */
  protected readonly connections = computed(() => {
    const idx = this.store.index();
    if (!idx) return [];
    return learnConnections(
      relatedLinks(idx, this.store.linksByNode(), this.node().id, connectionTitleOf),
    );
  });

  protected removeConnection(linkId: string): void {
    if (!confirm('Remove this connection? Both messages stay as they are.')) return;
    void this.store.deleteLink(linkId);
  }

  protected editNote(edit: LinkNoteEdit): void {
    void this.store.updateLink(edit.linkId, edit.note);
  }

  /** Title of the tangent whose branch is being created. */
  protected readonly opening = signal<string | null>(null);
  /** "Ask your own": the learner's question, sent in a new side question. */
  protected readonly askText = signal('');
  protected readonly asking = signal(false);
  /** The newest reply of what is open: its "Ask your own" stands out (TangentAsk `latest`). */
  protected readonly latest = computed(() => {
    const n = this.node();
    return (
      this.askable() &&
      n.branchId === this.store.selectedBranchId() &&
      this.store.path().at(-1)?.id === n.id
    );
  });

  protected async ask(text: string): Promise<void> {
    if (this.asking()) return;
    this.asking.set(true);
    try {
      // Kept on failure, to try again.
      if (await this.store.askFrom(this.node().id, text)) this.askText.set('');
    } finally {
      this.asking.set(false);
    }
  }

  protected async remove(branchId: string): Promise<void> {
    await confirmDeleteSideQuestion(this.store, branchId);
  }

  protected async follow(title: string): Promise<void> {
    if (this.opening() !== null) return;
    this.opening.set(title);
    try {
      await this.store.followTangent(this.node().id, title);
    } finally {
      this.opening.set(null);
    }
  }
}
