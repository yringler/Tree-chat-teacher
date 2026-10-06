import { ChangeDetectionStrategy, Component, input, output, signal } from '@angular/core';
import { Icon } from './icon';

/** Text selected inside one message: the message (`data-node-id`) and the trimmed text. */
export interface MessageQuote {
  nodeId: string;
  quote: string;
}

/** Longest quote offered (the API's anchor quote limit). */
export const MAX_QUOTE = 10_000;

/** How long the action stays after the selection goes: a tap on it may collapse the selection first. */
const HIDE_DELAY_MS = 400;

/**
 * The text selected inside one message under `container`: the nearest
 * element with `data-node-id` around the selection names the message. Null
 * when nothing is selected, or the selection lies outside the container or
 * spans no single message. The caller checks the message itself (finished,
 * branchable).
 */
export function selectedMessageQuote(
  container: Element | null | undefined,
  selection: Selection | null,
): MessageQuote | null {
  if (!container || !selection || selection.isCollapsed || selection.rangeCount === 0) return null;
  const common = selection.getRangeAt(0).commonAncestorContainer;
  if (!container.contains(common)) return null;
  // An element, or the element around a text node.
  const start = common.nodeType === 1 ? (common as Element) : common.parentElement;
  const el = start?.closest('[data-node-id]');
  const nodeId = el && container.contains(el) ? el.getAttribute('data-node-id') : null;
  if (!nodeId) return null;
  const quote = selection.toString().trim().slice(0, MAX_QUOTE);
  return quote ? { nodeId, quote } : null;
}

/**
 * The quote a page offers "Ask about this" for, following the document
 * selection (call `update` on `selectionchange`). It shows at once and hides
 * a moment after the selection goes, so a tap on the action still lands.
 */
export class PendingQuote {
  readonly value = signal<MessageQuote | null>(null);
  private timer: ReturnType<typeof setTimeout> | undefined;

  /** `find`: the quote under the current selection, if the page offers an action for it. */
  constructor(private readonly find: () => MessageQuote | null) {}

  update(): void {
    const found = this.find();
    clearTimeout(this.timer);
    if (found) {
      this.value.set(found);
      return;
    }
    if (this.value()) this.timer = setTimeout(() => this.value.set(null), HIDE_DELAY_MS);
  }

  clear(): void {
    clearTimeout(this.timer);
    this.value.set(null);
  }

  /** For the page's ngOnDestroy. */
  destroy(): void {
    clearTimeout(this.timer);
  }
}

/**
 * "Ask about this": the floating action for text selected in a message. The
 * main button branches at once (the page decides how: Learn and power open
 * a side question quoting it, ready to type); `moreLabel` adds a gear for
 * the full branch dialog with the quote filled in. Mousedown is cancelled
 * on both, so pressing them doesn't drop the selection they act on. Each app
 * positions the host.
 */
@Component({
  selector: 'app-selection-ask',
  imports: [Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="selection-ask" role="group" aria-label="Selected text">
      <button
        type="button"
        class="btn btn-primary selection-ask-main"
        [title]="title()"
        [disabled]="busy()"
        (mousedown)="$event.preventDefault()"
        (click)="ask.emit()"
      >
        <app-icon name="branch" /> {{ label() }}
      </button>
      @if (moreLabel(); as gear) {
        <button
          type="button"
          class="btn selection-ask-more"
          [attr.aria-label]="gear"
          [title]="gear"
          [disabled]="busy()"
          (mousedown)="$event.preventDefault()"
          (click)="more.emit()"
        >
          <app-icon name="gear" [size]="15" />
        </button>
      }
    </div>
  `,
  host: { class: 'selection-ask-host' },
})
export class SelectionAsk {
  readonly label = input('Ask about this');
  /** Tooltip of the main button: what it does. */
  readonly title = input<string | null>(null);
  /** The gear's label (the branch dialog); null for no gear. */
  readonly moreLabel = input<string | null>(null);
  readonly busy = input(false);
  readonly ask = output();
  readonly more = output();
}
