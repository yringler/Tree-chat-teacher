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
import { UiStore } from '../state/ui-store';
import { Icon } from '@tangent/web-shared';

/**
 * Message box. Enter sends, Shift+Enter inserts a newline; Compare (when
 * offered) asks Normal and Max instead. The text stays
 * until the message is in the tree (`UiStore.markSent`, on the reply's
 * start), so a send the server refuses (no key, no credit, a network
 * failure…) leaves it where it was typed.
 */
@Component({
  selector: 'app-composer',
  imports: [Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <form class="composer" (submit)="$event.preventDefault(); submit()">
      <label class="sr-only" for="composer-input">Message</label>
      <textarea
        #box
        id="composer-input"
        rows="1"
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
          aria-label="Stop generating"
        >
          <app-icon name="stop" /> Stop
        </button>
      } @else {
        @if (canCompare()) {
          <button
            type="button"
            class="btn btn-ghost"
            [disabled]="disabled() || !text().trim()"
            title="Answer with Normal and Max, then keep one (uses both)"
            aria-label="Compare Normal and Max"
            (click)="compareNow()"
          >
            <app-icon name="compare" /><span class="hide-narrow"> Compare</span>
          </button>
        }
        <button
          type="submit"
          class="btn btn-primary"
          [disabled]="disabled() || !text().trim()"
          aria-label="Send message"
        >
          <app-icon name="send" /> Send
        </button>
      }
    </form>
  `,
  host: { class: 'composer-host' },
})
export class Composer {
  private readonly ui = inject(UiStore);
  readonly placeholder = input('Message…');
  /** Input disabled (e.g. while a reply is streaming). */
  readonly disabled = input(false);
  /** Show the Stop button instead of Send. */
  readonly busy = input(false);
  readonly autofocus = input(false);
  /** Draft to start from when the box is empty (a message that couldn't be sent, `TreeStore.unsentDrafts`). */
  readonly initial = input('');
  /** Offer Compare beside Send (Normal and Max both answer; one is kept). */
  readonly canCompare = input(false);
  readonly send = output<string>();
  readonly stop = output();
  /** Compare the message: the text stays until the picked answer is in the tree. */
  readonly compare = output<string>();

  protected readonly text = signal('');
  private readonly box = viewChild.required<ElementRef<HTMLTextAreaElement>>('box');
  private lastFocusRequest = untracked(() => this.ui.composerFocus());

  constructor() {
    afterNextRender(() => {
      if (this.autofocus()) this.box().nativeElement.focus();
    });
    effect(() => {
      const n = this.ui.composerFocus();
      if (n !== this.lastFocusRequest) {
        this.lastFocusRequest = n;
        queueMicrotask(() => this.box().nativeElement.focus());
      }
    });
    // A message handed back (it couldn't be sent) fills an empty box.
    effect(() => {
      const initial = this.initial();
      if (!initial || untracked(this.text)) return;
      this.setText(initial);
    });
    // The message reached the server: let it go, unless it was edited since.
    let lastSent = untracked(() => this.ui.composerSent())?.seq ?? 0;
    effect(() => {
      const sent = this.ui.composerSent();
      if (!sent || sent.seq === lastSent) return;
      lastSent = sent.seq;
      if (untracked(this.text).trim() === sent.text) this.setText('');
    });
    // Text handed over from elsewhere (e.g. a review's corrections) is appended to the draft.
    let lastInsert = untracked(() => this.ui.composerInsert())?.seq ?? 0;
    effect(() => {
      const insert = this.ui.composerInsert();
      if (!insert || insert.seq === lastInsert) return;
      lastInsert = insert.seq;
      const box = this.box().nativeElement;
      const draft = untracked(this.text).trimEnd();
      const next = draft ? `${draft}\n\n${insert.text}` : insert.text;
      this.text.set(next);
      box.value = next;
      this.autosize(box);
      queueMicrotask(() => {
        box.focus();
        box.setSelectionRange(next.length, next.length);
      });
    });
    // Re-focus when the composer becomes enabled again after a reply.
    effect(() => {
      // Not on touch devices: focusing would pop up the on-screen keyboard.
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
    this.autosize(box);
  }

  protected onKey(e: KeyboardEvent): void {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      this.submit();
    }
  }

  /** Kept until the message is in the tree (see `markSent` above). */
  protected submit(): void {
    const content = this.text().trim();
    if (!content || this.disabled() || this.busy()) return;
    this.send.emit(content);
  }

  protected compareNow(): void {
    const content = this.text().trim();
    if (!content || this.disabled() || this.busy()) return;
    this.compare.emit(content);
  }

  private setText(text: string): void {
    this.text.set(text);
    // After the view exists (an effect's first run can come before it).
    queueMicrotask(() => {
      const box = this.box().nativeElement;
      box.value = text;
      this.autosize(box);
    });
  }

  private autosize(box: HTMLTextAreaElement): void {
    box.style.height = 'auto';
    box.style.height = `${Math.min(box.scrollHeight, 320)}px`;
  }
}
