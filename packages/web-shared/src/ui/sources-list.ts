import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { citationDomain, type ChatNode } from '@tangent/shared';
import { Icon } from './icon';

/** Branch depth from which an unchecked reply's line is shown at full strength. */
export const DEEP_BRANCH_DEPTH = 2;

/**
 * Under a finished assistant reply: the sources a web search found
 * ("Checked against N sources" + chips), or that it answered from the
 * tutor's own knowledge, with a "Check sources" button when the branch's
 * provider can search. Both apps.
 */
@Component({
  selector: 'app-sources-list',
  imports: [Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @let n = node();
    @if (n.role === 'assistant' && n.status === 'complete') {
      @let list = n.sources ?? null;
      @if (list !== null && list.length > 0) {
        <section class="sources" aria-label="Sources">
          <span class="sources-label small">
            <app-icon name="search" [size]="13" />
            Checked against {{ list.length }} {{ list.length === 1 ? 'source' : 'sources' }}
          </span>
          <ul class="sources-chips">
            @for (s of list; track s.url) {
              <li>
                <a
                  class="source-chip"
                  [href]="s.url"
                  target="_blank"
                  rel="noopener noreferrer nofollow"
                  [title]="tooltip(s.title, s.excerpt)"
                  >{{ domain(s.url) }}</a
                >
              </li>
            }
          </ul>
        </section>
      } @else {
        <p class="sources-none small" [class.is-deep]="deep()">
          @if (list !== null) {
            Searched the web; no sources cited.
          } @else {
            From the tutor's own knowledge.
          }
          @if (canCheck()) {
            <button
              type="button"
              class="btn btn-ghost btn-sm sources-check"
              [disabled]="checking()"
              [title]="checkTitle()"
              (click)="check.emit(n.id)"
            >
              <app-icon name="search" [size]="13" /> Check sources
            </button>
          }
        </p>
      }
    }
  `,
})
export class SourcesList {
  readonly node = input.required<ChatNode>();
  /** Depth of the node's branch (0 = main thread). */
  readonly depth = input(0);
  /** The branch's provider can search, and the reply may be checked. */
  readonly canCheck = input(false);
  readonly checking = input(false);
  /** Tooltip of the button (e.g. what a check costs). */
  readonly checkTitle = input('Search the web to check this answer');
  /** "Check sources" clicked; carries the node id. */
  readonly check = output<string>();

  protected readonly deep = computed(() => this.depth() >= DEEP_BRANCH_DEPTH);
  protected readonly domain = citationDomain;

  protected tooltip(title: string | null, excerpt: string | null): string {
    return [title, excerpt].filter((x): x is string => !!x).join('\n\n');
  }
}
