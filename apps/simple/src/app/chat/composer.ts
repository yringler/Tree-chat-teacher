import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  effect,
  ElementRef,
  inject,
  input,
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { Icon } from '@tangent/web-shared';
import { UiStore } from '../state/ui-store';

/**
 * Message box. Enter sends, Shift+Enter inserts a newline; Stop replaces Send
 * while a reply streams. With `canCompare`, a Compare button beside Send asks
 * Normal and Max both (the host opens the Compare dialog).
 */
@Component({
  selector: 'app-composer',
  imports: [Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <form class="composer" (submit)="$event.preventDefault(); submit()">
      <label class="sr-only" [attr.for]="inputId()">{{ label() }}</label>
      <textarea
        #box
        [id]="inputId()"
        rows="1"
        enterkeyhint="send"
        [placeholder]="placeholder()"
        [value]="text()"
        [disabled]="disabled()"
        (input)="onInput(box)"
        (keydown)="onKey($event)"
      ></textarea>
      @if (busy()) {
        <button
          type="button"
          class="btn btn-danger"
          (click)="stop.emit()"
          aria-label="Stop the reply"
        >
          <app-icon name="stop" /> Stop
        </button>
      } @else if (!hideSend()) {
        @if (canCompare()) {
          <button
            type="button"
            class="btn btn-ghost"
            [disabled]="disabled() || !text().trim()"
            title="Ask Normal and Max, then keep one answer (uses both)"
            aria-label="Compare Normal and Max"
            (click)="compare.emit(text().trim())"
          >
            <app-icon name="compare" /> <span class="hide-narrow">Compare</span>
          </button>
        }
        <button
          type="submit"
          class="btn btn-primary"
          [disabled]="disabled() || !text().trim()"
          aria-label="Send"
        >
          <app-icon name="send" /> <span class="hide-narrow">Send</span>
        </button>
      }
    </form>
  `,
  host: { class: 'composer-host' },
})
export class Composer {
  private readonly ui = inject(UiStore);
  readonly placeholder = input('Ask a question…');
  readonly label = input('Message');
  readonly inputId = input('composer-input');
  /** Input disabled (e.g. while a reply is streaming). */
  readonly disabled = input(false);
  /** Show the Stop button instead of Send. */
  readonly busy = input(false);
  /** No Send button (the host form has its own). */
  readonly hideSend = input(false);
  readonly autofocus = input(false);
  /**
   * True: the text goes once the message is in the lesson (`UiStore.markSent`,
   * on the reply's start), never before, so a refused send keeps it. False:
   * it stays (the host navigates away on success).
   */
  readonly clearOnSend = input(true);
  /** Draft to start from (e.g. a message the server refused). */
  readonly initial = input('');
  /** Offer Compare beside Send (both tiers listed, not on the open pool). */
  readonly canCompare = input(false);
  readonly send = output<string>();
  /**
   * Compare the text on Normal and Max. Like Send, the text stays until the
   * picked answer is in the lesson (`UiStore.markSent`).
   */
  readonly compare = output<string>();
  readonly stop = output();
  /** Every edit, for hosts that read the draft themselves. */
  readonly draft = output<string>();

  protected readonly text = signal('');
  private readonly box = viewChild.required<ElementRef<HTMLTextAreaElement>>('box');
  private lastFocusRequest = untracked(() => this.ui.composerFocus());

  constructor() {
    afterNextRender(() => {
      if (this.autofocus() && matchMedia('(hover: hover)').matches)
        this.box().nativeElement.focus();
    });
    // A draft handed back (e.g. a message refused for lack of credit) fills an empty box.
    effect(() => {
      const initial = this.initial();
      if (!initial || untracked(this.text)) return;
      this.text.set(initial);
      this.draft.emit(initial);
      queueMicrotask(() => this.autosize(this.box().nativeElement));
    });
    // The message reached the server: let it go, unless it was edited since.
    let lastSent = untracked(() => this.ui.composerSent())?.seq ?? 0;
    effect(() => {
      const sent = this.ui.composerSent();
      if (!sent || sent.seq === lastSent) return;
      lastSent = sent.seq;
      if (!untracked(this.clearOnSend) || untracked(this.text).trim() !== sent.text) return;
      this.text.set('');
      this.draft.emit('');
      queueMicrotask(() => {
        const box = this.box().nativeElement;
        box.value = '';
        this.autosize(box);
      });
    });
    effect(() => {
      const n = this.ui.composerFocus();
      if (n !== this.lastFocusRequest) {
        this.lastFocusRequest = n;
        queueMicrotask(() => this.box().nativeElement.focus());
      }
    });
    // Re-focus when the composer is enabled again after a reply (not on touch
    // devices, where focusing pops up the on-screen keyboard).
    effect(() => {
      if (
        !this.disabled() &&
        document.activeElement === document.body &&
        matchMedia('(hover: hover)').matches
      ) {
        queueMicrotask(() => this.box().nativeElement.focus({ preventScroll: true }));
      }
    });
  }

  protected onInput(box: HTMLTextAreaElement): void {
    this.text.set(box.value);
    this.draft.emit(box.value);
    this.autosize(box);
  }

  protected onKey(e: KeyboardEvent): void {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      this.submit();
    }
  }

  protected submit(): void {
    const content = this.text().trim();
    if (!content || this.disabled() || this.busy()) return;
    // Kept until the message is in the lesson (see `markSent` above).
    this.send.emit(content);
  }

  private autosize(box: HTMLTextAreaElement): void {
    box.style.height = 'auto';
    box.style.height = `${Math.min(box.scrollHeight, 280)}px`;
  }
}
