import { ChangeDetectionStrategy, Component, computed, inject, input, output } from '@angular/core';
import type { MembershipInfo } from '@tangent/shared';
import { ApiClient } from '../core/api-client';
import { LEAVE_PAGE } from '../core/leave-page';
import { LearnCopy, readOnlyText, type LearnCopyWay } from './read-only';

let uid = 0;

/**
 * Stands where the composer of a read-only power branch would be (its funding
 * needs a membership the user lacks, see `lockedFundings`): says why, links
 * to the billing page to renew (or become a member), copies the conversation
 * into Learn and opens it there when Learn can reply to it (`learn`, see
 * `learnCopyWay`), and, when `credit` is set, offers to carry
 * the branch on with Tangent credit, which anyone can buy (`useCredit`, the
 * app switches the branch). The power app and Canvas (`compact`) show it; styles:
 * `.read-only-composer` in base.css.
 */
@Component({
  selector: 'app-read-only-composer',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'read-only-composer',
    '[class.is-compact]': 'compact()',
    '(window:pageshow)': 'onPageShow($event)',
  },
  template: `
    <section class="read-only-panel" role="region" [attr.aria-labelledby]="leadId">
      <p class="read-only-text">
        <strong [id]="leadId">{{ text().lead }}</strong> {{ text().body }}
      </p>
      <div class="read-only-actions">
        <a class="btn btn-primary read-only-renew" [href]="billingHref()">{{ text().renew }}</a>
        @if (learn()) {
          <button
            type="button"
            class="btn read-only-copy"
            [disabled]="copier.pending()"
            (click)="copier.copy(treeId())"
          >
            {{ copier.pending() ? 'Copying…' : 'Create a copy in Learn' }}
          </button>
        }
        @if (credit()) {
          <button type="button" class="btn btn-ghost read-only-credit" (click)="useCredit.emit()">
            Continue with Tangent credit
          </button>
        }
      </div>
      @if (copier.error(); as e) {
        <p class="notice notice-error" role="alert">{{ e }}</p>
      }
    </section>
  `,
})
export class ReadOnlyComposer {
  readonly membership = input.required<Pick<MembershipInfo, 'subscriptionStatus'>>();
  /** The power tree to copy into Learn. */
  readonly treeId = input.required<string>();
  /** The power app's billing page (absolute: Canvas links across apps). */
  readonly billingHref = input('/billing');
  /** Tangent credit is sold here, so the branch can carry on with it: offer it. */
  readonly credit = input(false);
  /**
   * How a copy in Learn would get replies without a membership (the open pool
   * or Tangent credit, `learnCopyWay`); null offers no copy, which could only be read.
   */
  readonly learn = input<LearnCopyWay | null>(null);
  /** Smaller, for a Canvas lane. */
  readonly compact = input(false);
  /** "Continue with Tangent credit": the app moves the branch onto credit. */
  readonly useCredit = output();

  protected readonly leadId = `read-only-lead-${++uid}`;
  protected readonly text = computed(() =>
    readOnlyText(this.membership(), this.credit(), this.learn()),
  );
  protected readonly copier = new LearnCopy(inject(ApiClient), inject(LEAVE_PAGE));

  protected onPageShow(event: Event): void {
    // Back from Learn through the back/forward cache: the page never reloaded.
    if ((event as PageTransitionEvent).persisted) this.copier.reset();
  }
}
