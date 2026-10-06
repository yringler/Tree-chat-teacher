import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { TextSizeStore } from '../state/text-size-store';
import { UiStore } from '../state/ui-store';

/**
 * "Aa" in the chat header: a small popover to make the conversation's text
 * smaller or larger (A− / A+, the current size, Reset). Applies at once and
 * is remembered in this browser (TextSizeStore). The steps use aria-disabled
 * rather than disabled, so a button reaching the end of the range keeps focus.
 */
@Component({
  selector: 'app-text-size-menu',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="menu-wrap">
      <button
        #trigger
        type="button"
        class="icon-btn text-size-btn"
        aria-label="Text size"
        title="Text size (- / +)"
        aria-haspopup="true"
        aria-controls="text-size-menu"
        [attr.aria-expanded]="ui.textSizeMenuOpen()"
        (click)="ui.textSizeMenuOpen.set(!ui.textSizeMenuOpen())"
      >
        <span aria-hidden="true">Aa</span>
      </button>
      @if (ui.textSizeMenuOpen()) {
        <div class="menu-scrim" (click)="ui.textSizeMenuOpen.set(false)"></div>
        <div
          class="menu text-size-menu"
          id="text-size-menu"
          role="group"
          aria-labelledby="text-size-heading"
          (keydown.escape)="close($event, trigger)"
        >
          <span id="text-size-heading" class="small muted">Conversation text size</span>
          <div class="text-size-steps">
            <button
              type="button"
              class="btn btn-sm"
              aria-label="Smaller text"
              title="Smaller (-)"
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
              title="Larger (+)"
              [attr.aria-disabled]="!size.canIncrease()"
              (click)="size.increase()"
            >
              <span aria-hidden="true" class="text-size-glyph-lg">A+</span>
            </button>
          </div>
          <button
            type="button"
            class="btn btn-ghost btn-sm"
            title="Reset (0)"
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
  protected readonly ui = inject(UiStore);
  protected readonly size = inject(TextSizeStore);

  /** Escape inside the popover: close it and hand focus back to "Aa". */
  protected close(e: Event, trigger: HTMLElement): void {
    e.preventDefault();
    this.ui.textSizeMenuOpen.set(false);
    trigger.focus();
  }
}
