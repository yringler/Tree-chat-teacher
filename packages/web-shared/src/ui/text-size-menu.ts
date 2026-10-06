import { ChangeDetectionStrategy, Component, inject, input, model } from '@angular/core';
import { TextSizeStore } from '../core/text-size-store';

/**
 * "Aa": a small popover to make the conversation's text smaller or larger
 * (A− / A+, the current size, Reset). Applies at once and is remembered in
 * this browser (TextSizeStore, under the app's own key). The steps use
 * aria-disabled rather than disabled, so a button reaching the end of the
 * range keeps focus. Escape (on the button or in the popover) or a click
 * outside closes it; `open` is two-way for an app that also closes it from
 * its own Escape handling (power's UiStore).
 */
@Component({
  selector: 'app-text-size-menu',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="text-size-wrap" (keydown.escape)="close($event, trigger)">
      <button
        #trigger
        type="button"
        class="icon-btn text-size-btn"
        aria-label="Text size"
        [title]="shortcuts() ? 'Text size (- / +)' : 'Text size'"
        aria-haspopup="true"
        [attr.aria-controls]="menuId()"
        [attr.aria-expanded]="open()"
        (click)="open.set(!open())"
      >
        <span aria-hidden="true">Aa</span>
      </button>
      @if (open()) {
        <div class="text-size-scrim" (click)="open.set(false)"></div>
        <div
          class="text-size-menu"
          [id]="menuId()"
          role="group"
          [attr.aria-labelledby]="menuId() + '-heading'"
        >
          <span [id]="menuId() + '-heading'" class="small muted">{{ heading() }}</span>
          <div class="text-size-steps">
            <button
              type="button"
              class="btn btn-sm"
              aria-label="Smaller text"
              [title]="shortcuts() ? 'Smaller (-)' : 'Smaller'"
              [attr.aria-disabled]="!size.canDecrease()"
              (click)="size.decrease()"
            >
              <span aria-hidden="true" class="text-size-glyph-sm">A−</span>
            </button>
            <output class="text-size-value" aria-live="polite">{{ size.label() }}</output>
            <button
              type="button"
              class="btn btn-sm"
              aria-label="Larger text"
              [title]="shortcuts() ? 'Larger (+)' : 'Larger'"
              [attr.aria-disabled]="!size.canIncrease()"
              (click)="size.increase()"
            >
              <span aria-hidden="true" class="text-size-glyph-lg">A+</span>
            </button>
          </div>
          <button
            type="button"
            class="btn btn-ghost btn-sm"
            [title]="shortcuts() ? 'Reset (0)' : 'Back to the usual size'"
            [attr.aria-disabled]="size.isDefault()"
            (click)="size.reset()"
          >
            Reset to 100%
          </button>
        </div>
      }
    </div>
  `,
})
export class TextSizeMenu {
  protected readonly size = inject(TextSizeStore);
  readonly open = model(false);
  /** The popover's heading: what the size applies to. */
  readonly heading = input('Conversation text size');
  /** The app has `-` / `+` / `0` shortcuts for it: name them in the tooltips. */
  readonly shortcuts = input(false);
  readonly menuId = input('text-size-menu');

  /** Escape: close the popover and hand focus back to "Aa" (handled here, not by the app). */
  protected close(e: Event, trigger: HTMLElement): void {
    if (!this.open()) return;
    e.preventDefault();
    e.stopPropagation();
    this.open.set(false);
    trigger.focus();
  }
}
