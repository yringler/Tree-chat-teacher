import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  effect,
  ElementRef,
  input,
  model,
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { enterSends, pointerHovers } from './composer';
import { Icon } from './icon';

/**
 * "Ask your own": the last item of a reply's "Suggested tangents" group,
 * outside its fold, styled like the suggested tangents but with a field for
 * the user's own question, sent as the first message of a new branch. The
 * parent owns the text (`text`, cleared once the branch is created) and the
 * branching (`ask`).
 *
 * `expandable` (Canvas): a one-line field that grows into a few lines on
 * focus, with Ask and, given `options`, a caret joined to it as on the
 * composer's actions (`openOptions`: the branch dialog, carrying the text).
 * Otherwise a plain one-line input. Enter sends; Shift+Enter is a newline in
 * the expanded field, and as in the composer, so is a plain Enter on a touch
 * screen, where only Ask (or Ctrl or Cmd+Enter) sends; Escape folds it.
 *
 * `latest` marks the newest reply's item, the natural place to ask next: it
 * is drawn a little stronger, and an expandable one starts grown (without
 * taking focus or scrolling), so its few lines invite typing. It stays open
 * when left empty; folding it (Escape, or its fold button) keeps it folded
 * until `latest` goes false and true again (the user moved elsewhere).
 */
@Component({
  selector: 'app-tangent-ask',
  imports: [Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <form
      class="tangent tangent-ask"
      [class.is-expanded]="expanded()"
      [class.is-latest]="latest()"
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
          [attr.enterkeyhint]="touch ? 'enter' : 'send'"
          [placeholder]="placeholder()"
          [attr.aria-label]="label()"
          [value]="text()"
          [disabled]="disabled() || busy()"
          (focus)="onFocus()"
          (click)="expand()"
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
          <button
            type="button"
            class="icon-btn tangent-ask-fold"
            aria-label="Fold"
            title="Fold (Esc)"
            (click)="fold()"
          >
            <app-icon name="chevronUp" [size]="15" />
          </button>
          <button
            type="submit"
            class="btn btn-primary btn-sm"
            [disabled]="disabled() || busy() || !text().trim()"
          >
            <app-icon name="send" [size]="14" /> {{ busy() ? 'Starting…' : 'Ask' }}
          </button>
          @if (options(); as tip) {
            <button
              type="button"
              class="btn btn-primary btn-sm tangent-ask-caret"
              aria-haspopup="dialog"
              aria-label="Ask with options…"
              [title]="tip"
              [attr.aria-description]="tip"
              [disabled]="disabled() || busy()"
              (click)="openOptions.emit(text().trim())"
            >
              <app-icon name="chevronDown" [size]="14" />
            </button>
          }
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
  /** Grows into a few lines with Ask (and its caret) when focused (Canvas). */
  readonly expandable = input(false);
  /** What Ask's options are, as its caret's tooltip ("Ask with options: …"); null for no caret. */
  readonly options = input<string | null>(null);
  readonly disabled = input(false);
  /** Why it is disabled, as a tooltip. */
  readonly disabledTitle = input<string | null>(null);
  /** The branch is being created: the field waits, keeping the text. */
  readonly busy = input(false);
  /** The newest reply's item: stronger, and (expandable) open from the start. */
  readonly latest = input(false);
  /** Takes the focus when it first renders (shown because the user asked to type a question). */
  readonly focusOnOpen = input(false);
  /** Send: the trimmed, non-empty question. */
  readonly ask = output<string>();
  /** The caret: the trimmed question (possibly empty), for the branch dialog to send. */
  readonly openOptions = output<string>();

  protected readonly expanded = signal(false);
  /** No pointer hovers: a plain Enter in the grown field is a newline, and the keyboard's key says so. */
  protected readonly touch = !pointerHovers();
  /** Open because it is the newest reply's, not because the user opened it: leaving it keeps it open. */
  private readonly pinned = signal(false);
  /** The next focus is the fold button handing focus back: it doesn't re-open the field. */
  private refocusing = false;
  private readonly field = viewChild<ElementRef<HTMLTextAreaElement | HTMLInputElement>>('field');

  constructor() {
    afterNextRender(() => {
      if (this.focusOnOpen()) this.field()?.nativeElement.focus({ preventScroll: true });
    });
    // The newest reply's item opens by itself (no focus, no scroll); once it
    // isn't the newest, it folds unless it is in use.
    effect(() => {
      const open = this.latest() && this.expandable() && !this.disabled();
      untracked(() => {
        this.pinned.set(open);
        if (open) this.expanded.set(true);
        else if (!this.inUse()) this.collapse();
      });
    });
    // Emptied from outside (the branch was created) while the field isn't in use: fold it.
    effect(() => {
      const el = this.field()?.nativeElement;
      if (!this.text() && !this.busy() && !this.pinned() && el && document.activeElement !== el) {
        this.collapse();
      }
    });
  }

  protected onFocus(): void {
    if (this.refocusing) this.refocusing = false;
    else this.expand();
  }

  /** The fold button: folds it for good (until it is the newest reply's again) and keeps focus on the field. */
  protected fold(): void {
    this.pinned.set(false);
    this.collapse();
    const el = this.field()?.nativeElement;
    if (el) {
      this.refocusing = true;
      el.focus({ preventScroll: true });
      this.refocusing = false;
    }
  }

  protected expand(): void {
    if (this.expandable()) this.expanded.set(true);
  }

  protected onInput(el: HTMLTextAreaElement): void {
    this.text.set(el.value);
    // Typing into a folded field (focus kept after folding it) grows it again.
    if (!this.expanded()) this.expand();
    this.autosize(el);
  }

  protected onKey(e: KeyboardEvent): void {
    if (e.isComposing) return;
    // The one-line input has no newline to insert, so its Enter always sends.
    if (enterSends(e, this.touch && this.expandable())) {
      e.preventDefault();
      this.submit();
    } else if (e.key === 'Escape') {
      // Handled here, so the global Escape (closing panels) leaves the page alone.
      e.preventDefault();
      this.pinned.set(false);
      this.collapse();
      (e.target as HTMLElement).blur();
    }
  }

  /** Leaving the item with nothing typed folds it back (not when moving to its own buttons). */
  protected onFocusOut(e: FocusEvent): void {
    const to = e.relatedTarget;
    if (to instanceof Node && (e.currentTarget as HTMLElement).contains(to)) return;
    if (!this.text().trim() && !this.pinned()) this.collapse();
  }

  protected submit(): void {
    const text = this.text().trim();
    if (!text || this.disabled() || this.busy()) return;
    this.ask.emit(text);
  }

  /** Something typed, or the field has focus. */
  private inUse(): boolean {
    const el = this.field()?.nativeElement;
    return !!this.text().trim() || (!!el && document.activeElement === el);
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
