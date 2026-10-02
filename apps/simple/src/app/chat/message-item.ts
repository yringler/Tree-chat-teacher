import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import type { ChatNode } from '@tangent/shared';
import { Icon, MarkdownService } from '@tangent/web-shared';
import { LessonStore } from '../state/lesson-store';
import { branchTitle } from './titles';

/** One message of the lesson; `data-node-id` lets the chat page map a text selection to it. */
@Component({
  selector: 'app-message-item',
  imports: [Icon],
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
        }
      </header>

      @if (streaming() && liveStatus()) {
        <p class="msg-status muted small">{{ liveStatus() }}</p>
      }
      <div class="msg-body md" [innerHTML]="html()"></div>
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

      @if (children().length > 0) {
        <nav class="side-questions" [attr.aria-label]="'Side questions from this message'">
          <span class="muted small">
            <app-icon name="branch" [size]="13" />
            {{ children().length }}
            {{ children().length === 1 ? 'side question' : 'side questions' }}
          </span>
          @for (b of children(); track b.id) {
            <button
              type="button"
              class="chip"
              [class.is-on]="chainIds().has(b.id)"
              [title]="b.anchorQuote ?? branchTitle(b)"
              (click)="store.go(b.id)"
            >
              {{ branchTitle(b) }}
            </button>
          }
        </nav>
      }
    </article>
  `,
  host: { class: 'msg-host' },
})
export class MessageItem {
  protected readonly store = inject(LessonStore);
  private readonly md = inject(MarkdownService);
  protected readonly branchTitle = branchTitle;

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
  /** Rendered by the shared markdown pipeline; [innerHTML] adds Angular's sanitizer on top. */
  protected readonly html = computed(() => this.md.render(this.content(), !this.streaming()));
  protected readonly askable = computed(
    () => this.node().role === 'assistant' && this.node().status === 'complete',
  );
  protected readonly children = computed(() => this.store.childBranchesAt(this.node().id));
}
