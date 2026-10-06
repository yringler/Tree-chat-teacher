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
 * The message box at the foot of every lane. Enter sends, Shift+Enter
 * inserts a newline; Stop replaces Send while the lane's reply streams.
 * Only the selected lane's box answers the global focus request, or the
 * box of the lane it names (a new lane, also once it first renders).
 */
@Component({
  selector: 'app-lane-composer',
  imports: [Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <form class="composer" (submit)="$event.preventDefault(); submit()">
      <label class="sr-only" [attr.for]="inputId()">Message</label>
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
        (pointerdown)="$event.stopPropagation()"
      ></textarea>
      @if (busy()) {
        <button
          type="button"
          class="btn btn-danger btn-sm"
          (click)="stop.emit()"
          aria-label="Stop the reply"
        >
          <app-icon name="stop" [size]="14" /> Stop
        </button>
      } @else {
        <button
          type="submit"
          class="btn btn-primary btn-sm"
          [disabled]="disabled() || !text().trim()"
          aria-label="Send"
        >
          <app-icon name="send" [size]="14" />
        </button>
      }
    </form>
  `,
  host: { class: 'composer-host' },
})
export class LaneComposer {
  private readonly ui = inject(UiStore);
  readonly inputId = input.required<string>();
  /** The lane this box writes in. */
  readonly laneId = input.required<string>();
  readonly placeholder = input('Continue this lane…');
  readonly disabled = input(false);
  readonly busy = input(false);
  /** True for the selected lane: it takes the global focus request. */
  readonly selected = input(false);
  readonly send = output<string>();
  readonly stop = output();

  protected readonly text = signal('');
  private readonly box = viewChild.required<ElementRef<HTMLTextAreaElement>>('box');
  private lastFocusRequest = untracked(() => this.ui.composerFocus());

  constructor() {
    effect(() => {
      const n = this.ui.composerFocus();
      if (n !== this.lastFocusRequest) {
        this.lastFocusRequest = n;
        const lane = this.ui.composerFocusLane;
        if (lane === untracked(this.laneId) || (lane === null && untracked(this.selected))) {
          this.takeFocus();
        }
      }
    });
    // A lane created with a focus request for it: its box didn't exist when it was asked.
    afterNextRender(() => {
      if (this.ui.composerFocusLane === this.laneId()) this.takeFocus();
    });
  }

  private takeFocus(): void {
    this.ui.composerFocusLane = null;
    queueMicrotask(() => this.box().nativeElement.focus({ preventScroll: true }));
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
    box.style.height = `${Math.min(box.scrollHeight, 220)}px`;
  }
}
