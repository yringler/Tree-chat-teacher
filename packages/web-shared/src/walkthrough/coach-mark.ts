import {
  afterRenderEffect,
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  inject,
  viewChild,
} from '@angular/core';
import { arrow, autoUpdate, computePosition, flip, offset, shift } from '@floating-ui/dom';
import { Walkthrough, type CoachStep } from './walkthrough';

/** The ring around the control a coach mark points at (styles/coach-mark.css). */
export const COACH_TARGET_CLASS = 'coach-mark-target';

/**
 * The walkthrough's coach marks: a callout beside the control the current
 * step points at, with "Got it" (or Done) and "Skip tour". Mounted once per
 * app. It never blocks the page: no backdrop and no focus taken, so the
 * learner goes on by clicking the control itself, and the app's own tests
 * click through it. It sits in the top layer (`popover="manual"`), placed by
 * floating-ui, and is written with text bindings only (the Trusted Types
 * CSP allows no innerHTML). While the control is off the page (the reply
 * still streaming, or Stop in place of the composer's actions) it is
 * hidden, however long that takes, and comes back with it. Escape skips the
 * tour while the callout shows and no dialog is open.
 */
@Component({
  selector: 'app-coach-mark',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <p class="sr-only" aria-live="polite">{{ walkthrough.current()?.text ?? '' }}</p>
    <div
      #callout
      class="coach-mark"
      popover="manual"
      role="dialog"
      aria-modal="false"
      aria-labelledby="coach-mark-text"
    >
      <div #arrow class="coach-mark-arrow"></div>
      @if (walkthrough.current(); as c) {
        <p id="coach-mark-text" class="coach-mark-text">{{ c.text }}</p>
        <div class="coach-mark-actions">
          <button type="button" class="btn btn-ghost btn-sm" (click)="walkthrough.skip()">
            {{ c.skipText }}
          </button>
          <button type="button" class="btn btn-primary btn-sm" (click)="walkthrough.next()">
            {{ c.buttonText }}
          </button>
        </div>
      }
    </div>
  `,
  host: { '(document:keydown.escape)': 'onEscape($event)' },
})
export class CoachMark {
  protected readonly walkthrough = inject(Walkthrough);
  private readonly callout = viewChild.required<ElementRef<HTMLElement>>('callout');
  private readonly arrowEl = viewChild.required<ElementRef<HTMLElement>>('arrow');
  /** The callout is on screen, at its control. */
  private attached = false;

  constructor() {
    // Re-run on every step change; the cleanup (also on destroy) takes the last one down.
    afterRenderEffect((onCleanup) => {
      const step = this.walkthrough.current();
      if (step) onCleanup(this.follow(step));
    });
  }

  protected onEscape(e: Event): void {
    if (e.defaultPrevented || !this.attached) return;
    if (document.querySelector('[aria-modal="true"]')) return;
    this.walkthrough.skip();
  }

  /**
   * Shows the callout at `step`'s control while it is on the page, hidden
   * while it isn't; the returned function takes it all down.
   */
  private follow(step: CoachStep): () => void {
    const callout = this.callout().nativeElement;
    let target: HTMLElement | null = null;
    let unplace: (() => void) | null = null;

    const detach = () => {
      unplace?.();
      unplace = null;
      target?.classList.remove(COACH_TARGET_CLASS);
      target = null;
      this.attached = false;
      setOpen(callout, false);
    };
    const attach = (el: HTMLElement) => {
      target = el;
      el.classList.add(COACH_TARGET_CLASS);
      this.attached = true;
      setOpen(callout, true);
      unplace = autoUpdate(el, callout, () => void this.place(el, callout, step.placement));
    };
    const check = () => {
      if (target?.isConnected) return;
      if (target) detach();
      const found = document.querySelector<HTMLElement>(step.target);
      if (found) attach(found);
    };

    // Watches for as long as the step lasts, since the control can go and come
    // back any number of times; while it is there, a check costs one lookup.
    const observer = new MutationObserver(check);
    observer.observe(document.body, { childList: true, subtree: true });
    check();
    return () => {
      observer.disconnect();
      detach();
    };
  }

  private async place(
    target: HTMLElement,
    callout: HTMLElement,
    side: CoachStep['placement'],
  ): Promise<void> {
    const arrowEl = this.arrowEl().nativeElement;
    const { x, y, placement, middlewareData } = await computePosition(target, callout, {
      placement: side,
      strategy: 'fixed',
      middleware: [offset(10), flip(), shift({ padding: 8 }), arrow({ element: arrowEl })],
    });
    callout.style.left = `${x}px`;
    callout.style.top = `${y}px`;
    callout.dataset['placement'] = placement.split('-')[0];
    const a = middlewareData.arrow;
    arrowEl.style.left = a?.x === undefined ? '' : `${a.x}px`;
    arrowEl.style.top = a?.y === undefined ? '' : `${a.y}px`;
  }
}

/** Opens or closes the callout in the top layer (where the browser has popovers). */
function setOpen(el: HTMLElement, open: boolean): void {
  el.classList.toggle('is-open', open);
  if (typeof el.showPopover !== 'function') return;
  const isOpen = el.matches(':popover-open');
  if (open && !isOpen) el.showPopover();
  else if (!open && isOpen) el.hidePopover();
}
