import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import type { MembershipInfo } from '@tangent/shared';
import { BillingClient, formatCents, MembershipSubscribe } from '@tangent/web-shared';
import { LearnFunding } from '../state/learn-funding';

let uid = 0;

/** The words of the notice that stands where a locked own key's composer would be. */
export interface KeyLockedText {
  /** The first sentence, in bold. */
  lead: string;
  body: string;
  /** The subscribe button: "Renew membership" or "Become a member". */
  subscribe: string;
}

/**
 * What `KeyLockedNotice` says. A learner who had a membership (a subscription
 * on record) is asked to renew it; one who never had one, to become a member.
 * `alternatives`: the open pool or Tangent credit is on offer as a way out.
 */
export function keyLockedText(
  m: Pick<MembershipInfo, 'subscriptionStatus' | 'priceCents'>,
  alternatives: boolean,
): KeyLockedText {
  const ended = m.subscriptionStatus !== null;
  const price = formatCents(m.priceCents);
  return {
    lead: ended ? 'Your membership has ended.' : 'Replies on your own key need a membership.',
    body:
      `The membership is ${price} a year; OpenRouter still bills you for the replies.` +
      (alternatives ? ' Or carry on without one:' : ''),
    subscribe: ended ? 'Renew membership' : 'Become a member',
  };
}

/**
 * Stands where the composer (or the new lesson's Start button) would be while
 * replies run on the learner's own key and it needs a membership they lack
 * (`LearnFunding.membershipBlocked`). The lesson stays readable; one click
 * resolves it: subscribe (the hosted checkout), or carry on on the open pool
 * or Tangent credit (`LearnFunding.switchTo`), which brings the composer
 * back with any message the server refused. Styles: `.read-only-composer` in
 * base.css, as power mode's read-only branches.
 */
@Component({
  selector: 'app-key-locked-notice',
  imports: [RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'read-only-composer key-locked', '(window:pageshow)': 'onPageShow($event)' },
  template: `
    @if (text(); as t) {
      <section class="read-only-panel" role="region" [attr.aria-labelledby]="leadId">
        <p class="read-only-text">
          <strong [id]="leadId">{{ t.lead }}</strong> {{ t.body }}
        </p>
        <div class="read-only-actions">
          <button
            type="button"
            class="btn btn-primary key-locked-subscribe"
            [disabled]="sub.pending()"
            (click)="sub.subscribe()"
          >
            {{ sub.pending() ? 'Opening…' : t.subscribe }}
          </button>
          @if (funding.keyLockedWays().pool) {
            <button type="button" class="btn" (click)="funding.switchTo('pool')">
              Continue on the open pool
            </button>
          }
          @if (funding.keyLockedWays().credit) {
            <button type="button" class="btn" (click)="funding.switchTo('credit')">
              Continue on Tangent credit
            </button>
          }
          <a class="btn btn-ghost" routerLink="/billing">See billing</a>
        </div>
        @if (sub.error(); as e) {
          <p class="notice notice-error" role="alert">{{ e }}</p>
        }
      </section>
    }
  `,
})
export class KeyLockedNotice {
  protected readonly funding = inject(LearnFunding);
  protected readonly sub = new MembershipSubscribe(inject(BillingClient));
  protected readonly leadId = `key-locked-lead-${++uid}`;
  protected readonly text = computed(() => {
    const m = this.funding.membership();
    const ways = this.funding.keyLockedWays();
    return m ? keyLockedText(m, ways.pool || ways.credit) : null;
  });

  protected onPageShow(event: Event): void {
    // Back from the checkout through the back/forward cache: the page never reloaded.
    if ((event as PageTransitionEvent).persisted) this.sub.reset();
  }
}
