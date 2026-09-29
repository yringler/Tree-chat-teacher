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
import { Icon } from '../ui/icon';

/** Message box. Enter sends, Shift+Enter inserts a newline. */
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
  readonly send = output<string>();
  readonly stop = output();

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

  protected submit(): void {
    const content = this.text().trim();
    if (!content || this.disabled() || this.busy()) return;
    this.send.emit(content);
    this.text.set('');
    const box = this.box().nativeElement;
    box.value = '';
    this.autosize(box);
  }

  private autosize(box: HTMLTextAreaElement): void {
    box.style.height = 'auto';
    box.style.height = `${Math.min(box.scrollHeight, 320)}px`;
  }
}
