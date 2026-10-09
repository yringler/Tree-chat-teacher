import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import type { MembershipInfo } from '@tangent/shared';
import { learnLessonHref, readOnlyText, type LearnWay } from './read-only';

let uid = 0;

/**
 * Stands where the composer of a read-only power branch would be (its funding
 * needs a membership the user lacks, see `lockedFundings`): says why, links
 * to the billing page to renew (or become a member), links to the same
 * conversation in Learn when Learn can reply to it (`learn`, see `learnWay`),
 * and, when `credit` is set, offers to carry the branch on with Tangent
 * credit, which anyone can buy (`useCredit`, the app switches the branch).
 * The power app and Canvas (`compact`) show it; styles:
 * `.read-only-composer` in base.css.
 */
@Component({
  selector: 'app-read-only-composer',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'read-only-composer',
    '[class.is-compact]': 'compact()',
  },
  template: `
    <section class="read-only-panel" role="region" [attr.aria-labelledby]="leadId">
      <p class="read-only-text">
        <strong [id]="leadId">{{ text().lead }}</strong> {{ text().body }}
      </p>
      <div class="read-only-actions">
        <a class="btn btn-primary read-only-renew" [href]="billingHref()">{{ text().renew }}</a>
        @if (learn()) {
          <a class="btn read-only-learn" [href]="learnHref()">Open in Learn</a>
        }
        @if (credit()) {
          <button type="button" class="btn btn-ghost read-only-credit" (click)="useCredit.emit()">
            Continue with Tangent credit
          </button>
        }
      </div>
    </section>
  `,
})
export class ReadOnlyComposer {
  readonly membership = input.required<Pick<MembershipInfo, 'subscriptionStatus'>>();
  /** The conversation, and the branch Learn opens it on. */
  readonly treeId = input.required<string>();
  readonly branchId = input<string | null>(null);
  /** The power app's billing page (absolute: Canvas links across apps). */
  readonly billingHref = input('/billing');
  /** Tangent credit is sold here, so the branch can carry on with it: offer it. */
  readonly credit = input(false);
  /**
   * How Learn would reply to this conversation without a membership (the open
   * pool or Tangent credit, `learnWay`); null leaves Learn out, where it could only show it.
   */
  readonly learn = input<LearnWay | null>(null);
  /** Smaller, for a Canvas lane. */
  readonly compact = input(false);
  /** "Continue with Tangent credit": the app moves the branch onto credit. */
  readonly useCredit = output();

  protected readonly leadId = `read-only-lead-${++uid}`;
  protected readonly text = computed(() =>
    readOnlyText(this.membership(), this.credit(), this.learn()),
  );
  protected readonly learnHref = computed(() => learnLessonHref(this.treeId(), this.branchId()));
}
