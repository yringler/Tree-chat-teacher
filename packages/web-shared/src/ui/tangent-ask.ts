import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  effect,
  ElementRef,
  inject,
  Injector,
  input,
  model,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { Icon } from './icon';

/**
 * "Ask your own": the last item of a reply's "Where next?" list, styled like
 * the suggested tangents but with a field for the user's own question, sent
 * as the first message of a new branch. The parent owns the text (`text`,
 * cleared once the branch is created) and the branching (`ask`).
 *
 * `expandable` (power, canvas): a one-line field that grows into a few lines
 * on focus, with Send and a gear (`settings`: the branch dialog, carrying the
 * text). Otherwise (Learn) a plain one-line input. Enter sends; Shift+Enter
 * is a newline in the expanded field (as in the composer); Escape folds it.
 */
@Component({
  selector: 'app-tangent-ask',
  imports: [Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <form
      class="tangent tangent-ask"
      [class.is-expanded]="expanded()"
      [class.is-disabled]="disabled()"
      [attr.title]="disabled() ? disabledTitle() : null"
      (submit)="$event.preventDefault(); submit()"
      (focusout)="onFocusOut($event)"
    >
      <app-icon name="edit" [size]="14" />
      @if (expandable()) {
        <textarea
          #field
          class="tangent-ask-field"
          [rows]="expanded() ? 3 : 1"
          [placeholder]="placeholder()"
          [attr.aria-label]="label()"
          [value]="text()"
          [disabled]="disabled() || busy()"
          (focus)="expand()"
          (input)="onInput(field)"
          (keydown)="onKey($event)"
        ></textarea>
      } @else {
        <input
          #field
          type="text"
          class="tangent-ask-field"
          maxlength="4000"
          enterkeyhint="send"
          [placeholder]="placeholder()"
          [attr.aria-label]="label()"
          [value]="text()"
          [disabled]="disabled() || busy()"
          (input)="text.set(field.value)"
          (keydown)="onKey($event)"
        />
      }
      @if (expanded()) {
        <div class="tangent-ask-actions">
          @if (settingsLabel(); as gear) {
            <button
              type="button"
              class="icon-btn"
              [attr.aria-label]="gear"
              [title]="gear"
              [disabled]="disabled() || busy()"
              (click)="settings.emit(text().trim())"
            >
              <app-icon name="gear" [size]="15" />
            </button>
          }
          <button
            type="submit"
            class="btn btn-primary btn-sm"
            [disabled]="disabled() || busy() || !text().trim()"
          >
            <app-icon name="send" [size]="14" /> {{ busy() ? 'Branching…' : 'Ask' }}
          </button>
        </div>
      } @else if (!expandable() && text().trim()) {
        <button
          type="submit"
          class="icon-btn tangent-ask-send"
          aria-label="Ask"
          title="Ask (Enter)"
          [disabled]="disabled() || busy()"
        >
          <app-icon name="send" [size]="15" />
        </button>
      }
    </form>
  `,
})
export class TangentAsk {
  /** The question being typed. The parent clears it once its branch exists. */
  readonly text = model('');
  readonly placeholder = input('Ask your own question…');
  /** Accessible name of the field (what happens to the question). */
  readonly label = input.required<string>();
  /** Grows into a few lines with Send and a gear when focused (power, canvas). */
  readonly expandable = input(false);
  /**
   * Scroll the grown field into view (in a scrolling list; not on a canvas,
   * which moves by its own transform).
   */
  readonly reveal = input(false);
  /** The gear's label; null for no gear. */
  readonly settingsLabel = input<string | null>(null);
  readonly disabled = input(false);
  /** Why it is disabled, as a tooltip. */
  readonly disabledTitle = input<string | null>(null);
  /** The branch is being created: the field waits, keeping the text. */
  readonly busy = input(false);
  /** Send: the trimmed, non-empty question. */
  readonly ask = output<string>();
  /** The gear: the trimmed question (possibly empty), for the branch dialog to send. */
  readonly settings = output<string>();

  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly injector = inject(Injector);
  protected readonly expanded = signal(false);
  private readonly field = viewChild<ElementRef<HTMLTextAreaElement | HTMLInputElement>>('field');

  constructor() {
    // Emptied from outside (the branch was created) while the field isn't in use: fold it.
    effect(() => {
      const el = this.field()?.nativeElement;
      if (!this.text() && !this.busy() && el && document.activeElement !== el) {
        this.expanded.set(false);
        if (el instanceof HTMLTextAreaElement) el.style.height = '';
      }
    });
  }

  protected expand(): void {
    if (!this.expandable() || this.expanded()) return;
    this.expanded.set(true);
    // Under the last reply the grown field and its buttons would sit below the fold.
    afterNextRender(() => this.revealAll(), { injector: this.injector });
  }

  /**
   * Keeps the whole item, buttons included, in view while it grows. Instant:
   * typing right away would cut a smooth scroll short.
   */
  private revealAll(): void {
    if (this.reveal()) this.host.nativeElement.scrollIntoView?.({ block: 'nearest' });
  }

  protected onInput(el: HTMLTextAreaElement): void {
    this.text.set(el.value);
    const before = el.offsetHeight;
    this.autosize(el);
    if (el.offsetHeight > before) this.revealAll();
  }

  protected onKey(e: KeyboardEvent): void {
    if (e.isComposing) return;
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      this.submit();
    } else if (e.key === 'Escape') {
      // Handled here, so the global Escape (closing panels) leaves the page alone.
      e.preventDefault();
      this.collapse();
      (e.target as HTMLElement).blur();
    }
  }

  /** Leaving the item with nothing typed folds it back (not when moving to its own buttons). */
  protected onFocusOut(e: FocusEvent): void {
    const to = e.relatedTarget;
    if (to instanceof Node && (e.currentTarget as HTMLElement).contains(to)) return;
    if (!this.text().trim()) this.collapse();
  }

  protected submit(): void {
    const text = this.text().trim();
    if (!text || this.disabled() || this.busy()) return;
    this.ask.emit(text);
  }

  private collapse(): void {
    this.expanded.set(false);
    const el = this.field()?.nativeElement;
    if (el instanceof HTMLTextAreaElement) el.style.height = '';
  }

  private autosize(el: HTMLTextAreaElement): void {
    if (!this.expanded()) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
  }
}
