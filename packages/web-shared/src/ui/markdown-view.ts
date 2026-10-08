import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  effect,
  inject,
  input,
  signal,
  type Signal,
} from '@angular/core';
import { BlockRenderer } from '@tangent/render';
import { MarkdownService } from '../core/markdown.service';
import { TypesetMath } from './math';

/** Runs `callback` before the next repaint; returns a function that cancels it. */
export type FrameScheduler = (callback: () => void) => () => void;

const animationFrame: FrameScheduler = (callback) => {
  const id = requestAnimationFrame(callback);
  return () => cancelAnimationFrame(id);
};

/**
 * A streaming reply as blocks of HTML (BlockRenderer: finished blocks are
 * rendered once, the last block on every update), rendered at most once
 * per animation frame however many deltas arrive in it. A delta in a frame
 * that has rendered nothing yet renders at once (the usual case: one delta
 * per frame, no added latency or change detection); later ones in the same
 * frame wait for the next, which renders only the latest.
 */
export class StreamedMarkdown {
  private readonly blocks: BlockRenderer;
  /** The text last rendered; null until the first push. */
  private readonly shown = signal<string | null>(null);
  private latest = '';
  /** Cancels the end of the frame that has rendered; null when none has. */
  private cancel: (() => void) | null = null;
  /** A push arrived after this frame's render. */
  private waiting = false;

  /** The blocks' HTML, in order. */
  readonly html: Signal<string[]> = computed(() => {
    const text = this.shown();
    return text === null ? [] : this.blocks.update(text);
  });

  constructor(
    render: (markdown: string) => string,
    private readonly frame: FrameScheduler = animationFrame,
  ) {
    this.blocks = new BlockRenderer(render);
  }

  /** The text so far: shown now, or at the next frame if this one has rendered. */
  push(markdown: string): void {
    this.latest = markdown;
    if (this.cancel) this.waiting = true;
    else this.show();
  }

  /** Drops the pending frame and every block (the reply finished or went away). */
  stop(): void {
    this.cancel?.();
    this.cancel = null;
    this.waiting = false;
    this.shown.set(null);
    this.blocks.reset();
  }

  private show(): void {
    this.shown.set(this.latest);
    this.cancel = this.frame(() => {
      this.cancel = null;
      if (!this.waiting) return;
      this.waiting = false;
      this.show();
    });
  }
}

/**
 * Rendered markdown, on the element that shows it: `<div class="md"
 * [appMarkdown]="text" [streaming]="streaming()">`. A finished text is one
 * full render (MarkdownService, cached). While `streaming`, it renders block
 * by block and at most once per frame (StreamedMarkdown): finished blocks
 * keep their DOM (text selection, layout, highlighting and typeset math
 * stay), and only the last block's element changes. Every block is bound
 * with [innerHTML], so Angular's sanitizer checks each one, as it checks a
 * whole reply. The wrappers are `.md-block`, which base.css lays out as if
 * absent.
 */
@Component({
  selector: '[appMarkdown]',
  imports: [TypesetMath],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @for (b of blocks(); track $index) {
      <div class="md-block" [innerHTML]="b" [appTypesetMath]="b"></div>
    }
  `,
})
export class MarkdownView {
  private readonly md = inject(MarkdownService);

  readonly appMarkdown = input.required<string>();
  /** True while the text is still arriving. */
  readonly streaming = input(false);

  private readonly stream = new StreamedMarkdown((markdown) => this.md.render(markdown, false));
  protected readonly blocks = computed(() =>
    this.streaming() ? this.stream.html() : [this.md.render(this.appMarkdown())],
  );

  constructor() {
    effect(() => {
      const text = this.appMarkdown();
      if (this.streaming()) this.stream.push(text);
      else this.stream.stop();
    });
    inject(DestroyRef).onDestroy(() => this.stream.stop());
  }
}
