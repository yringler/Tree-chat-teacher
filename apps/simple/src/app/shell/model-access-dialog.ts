import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import {
  ANTHROPIC_PROVIDER_ID,
  LEARN_KEY_LABELS,
  OPENROUTER_PROVIDER_ID,
  type LearnKeyProvider,
  type Payer,
} from '@tangent/shared';
import {
  creditFeeText,
  errorMessage,
  formatCents,
  KeyForm,
  type KeySubmission,
  Modal,
  PoolMeter,
  ToastStore,
} from '@tangent/web-shared';
import { LessonStore } from '../state/lesson-store';
import { UiStore } from '../state/ui-store';
import { LearnFunding } from '../state/learn-funding';

/**
 * How replies are paid for: the learner's own key (they pay its provider
 * directly; where the membership is required, it needs one, so a
 * non-member sees it disabled with a link to the billing page), Tangent
 * credit (prepaid, on the built-in provider: the model's list price, bought
 * with a service fee, open to anyone, offered only when the server sells it), or the
 * open pool, while it is on. The own key is OpenRouter's or, where the
 * server offers it, Anthropic's, on which Learn runs a fixed pair of models
 * (the dialog says which, and that power mode is where to choose others).
 * The key is entered through `KeyForm`, which hands it over once: the
 * server seals it into an HttpOnly cookie this code can't read (the same
 * cookie as power mode's keys).
 *
 * Opened by a message refused for want of the own key, it says so; saving a
 * key, or picking Tangent credit or the pool, then sends it (and closes).
 * Closed otherwise, the message stays in the composer.
 */
@Component({
  selector: 'app-model-access-dialog',
  imports: [Modal, KeyForm, PoolMeter, RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <app-modal heading="How replies are paid for" (closed)="close()">
      @if (waiting()) {
        <p class="notice" role="status">
          Your message wasn’t sent: replies run on your own {{ keyLabel() }} key, and none is saved
          in this browser. Save your key below, or pick another way to pay, and it is sent.
        </p>
      }
      @if (funding.creditOffered() || funding.poolOn()) {
        <fieldset class="access-choice">
          <legend class="sr-only">Pay with</legend>
          <label class="access-option">
            <input
              type="radio"
              name="payment"
              value="own-key"
              [checked]="payment() === 'own-key'"
              [disabled]="ownKeyLocked()"
              (change)="choose('own-key')"
            />
            <span>
              <strong>Use my own API key</strong>
              <span class="muted small">
                @if (ownKeyLocked()) {
                  Needs a membership ({{ price() }}/year): covers Tangent while
                  {{ keyLabel() }} bills you directly.
                  <a routerLink="/billing" (click)="close()">Become a member</a>
                } @else if (membershipRequired()) {
                  You pay {{ keyLabel() }} directly; your membership covers Tangent.
                } @else {
                  Free here: you pay {{ keyLabel() }} directly.
                }
              </span>
            </span>
          </label>
          @if (funding.creditOffered()) {
            <label class="access-option">
              <input
                type="radio"
                name="payment"
                value="credit"
                [checked]="payment() === 'credit'"
                [disabled]="!funding.creditUsable()"
                (change)="choose('credit')"
              />
              <span>
                <strong>Use Tangent credit</strong>
                <span class="muted small">
                  @if (!funding.creditUsable()) {
                    No credit left, and top-ups aren't available right now.
                  } @else if (feeText(); as fee) {
                    Prepaid credit: each reply costs {{ fee }}.
                  } @else {
                    Prepaid credit, paid per reply.
                  }
                </span>
              </span>
            </label>
          }
          @if (funding.poolOn()) {
            <label class="access-option">
              <input
                type="radio"
                name="payment"
                value="pool"
                [checked]="payment() === 'pool'"
                (change)="choose('pool')"
              />
              <span>
                <strong>Use the open pool</strong>
                <span class="muted small">
                  Free to you, within daily limits, on
                  {{ funding.poolStatus()?.model?.label ?? 'one economical model' }}. Free credit
                  Tangent provides.
                </span>
              </span>
            </label>
          }
        </fieldset>
      } @else {
        <p class="muted small">
          @if (ownKeyLocked()) {
            Replies run on your own {{ keyLabel() }} key, which needs a membership ({{
              price()
            }}/year): it covers Tangent while {{ keyLabel() }} bills you directly.
            <a routerLink="/billing" (click)="close()">Become a member</a>
          } @else if (membershipRequired()) {
            Replies run on your own {{ keyLabel() }} key: you pay {{ keyLabel() }} directly, and
            your membership covers Tangent.
          } @else {
            Replies run on your own {{ keyLabel() }} key: you pay {{ keyLabel() }} directly, and
            Tangent charges nothing.
          }
        </p>
      }

      @if (payment() === 'pool') {
        @if (funding.poolStatus(); as status) {
          <app-pool-meter [status]="status" />
        }
        <p class="small">
          @if (poolUse(); as use) {
            <span>{{ use }} · </span>
          }
          <a href="/pool" target="_blank" rel="noopener">How the pool works</a>
        </p>
      } @else if (payment() === 'credit') {
        @if (funding.creditWaiting()) {
          <p class="notice" role="status">
            Your credit is used up, so replies use the open pool until you add credit.
          </p>
        }
        <p class="small">
          @if (funding.balanceText(); as balance) {
            <span>{{ balance }} available · </span>
          }
          <a routerLink="/billing" (click)="close()">Add credit</a>
        </p>
      } @else {
        @if (funding.keyStatus(); as status) {
          @if (!status.enabled) {
            <p class="notice">
              This server can't store your own key (KEY_ENCRYPTION_SECRET is not set).
            </p>
          } @else {
            @if (funding.ownKeyOptions().length > 1) {
              <fieldset class="access-choice key-choice">
                <legend class="field-label">Which key</legend>
                @for (k of funding.ownKeyOptions(); track k) {
                  <label class="access-option">
                    <input
                      type="radio"
                      name="own-key"
                      [value]="k"
                      [checked]="funding.ownKey() === k"
                      (change)="chooseKey(k)"
                    />
                    <span>
                      <strong>{{ labels[k] }}</strong>
                      <span class="muted small">{{ keyHints[k] }}</span>
                    </span>
                  </label>
                }
              </fieldset>
            }
            <div class="key-row">
              <span class="key-name">{{ keyLabel() }} key</span>
              @if (funding.hasOwnKey()) {
                <span class="badge badge-ok">saved</span>
                <button
                  type="button"
                  class="btn btn-ghost btn-sm"
                  [disabled]="busy()"
                  (click)="forget()"
                >
                  Forget
                </button>
              } @else {
                <span class="badge badge-warn">not set</span>
              }
            </div>
            <app-key-form
              [providers]="[{ id: funding.ownKey(), label: keyLabel() }]"
              [provider]="funding.ownKey()"
              [label]="funding.hasOwnKey() ? 'Replace your key' : 'Your ' + keyLabel() + ' API key'"
              [placeholder]="keyPlaceholders[funding.ownKey()]"
              [busy]="busy()"
              (saved)="save($event)"
            >
              <p class="muted small">
                Create one at
                <a [href]="keyPages[funding.ownKey()].href" target="_blank" rel="noopener">{{
                  keyPages[funding.ownKey()].name
                }}</a
                >. Power mode's {{ keyLabel() }} provider uses it too.
              </p>
            </app-key-form>
          }
        } @else {
          <p class="muted small">Loading…</p>
        }
      }
      @if (error(); as e) {
        <p class="notice notice-error" role="alert">{{ e }}</p>
      }
    </app-modal>
  `,
})
export class ModelAccessDialog {
  protected readonly funding = inject(LearnFunding);
  private readonly lessons = inject(LessonStore);
  private readonly ui = inject(UiStore);
  private readonly toast = inject(ToastStore);
  /** A message refused for want of the own key waits for a way to pay. */
  protected readonly waiting = computed(() => this.lessons.unsentDraft()?.needsKey ?? false);

  protected readonly labels = LEARN_KEY_LABELS;
  /** What each own key gets Learn, so the learner picks knowing it. */
  protected readonly keyHints: Readonly<Record<LearnKeyProvider, string>> = {
    [OPENROUTER_PROVIDER_ID]: 'Replies use the model Learn picks for tutoring.',
    [ANTHROPIC_PROVIDER_ID]:
      'Replies use Claude Sonnet; titles and summaries use Claude Haiku. To pick other models, use power mode.',
  };
  protected readonly keyPlaceholders: Readonly<Record<LearnKeyProvider, string>> = {
    [OPENROUTER_PROVIDER_ID]: 'sk-or-…',
    [ANTHROPIC_PROVIDER_ID]: 'sk-ant-…',
  };
  /** Where to create each key. */
  protected readonly keyPages: Readonly<Record<LearnKeyProvider, { href: string; name: string }>> =
    {
      [OPENROUTER_PROVIDER_ID]: {
        href: 'https://openrouter.ai/settings/keys',
        name: 'openrouter.ai',
      },
      [ANTHROPIC_PROVIDER_ID]: {
        href: 'https://console.anthropic.com/settings/keys',
        name: 'console.anthropic.com',
      },
    };
  protected readonly keyLabel = this.funding.ownKeyLabel;

  /** The way to pay the radios show: the learner's pick (credit that can't pay stays picked). */
  protected readonly payment = this.funding.picked;
  /** The membership is required here (the fee is on). */
  protected readonly membershipRequired = computed(
    () => this.funding.membership()?.required ?? false,
  );
  /** The own key needs a membership the learner lacks: the option is disabled. */
  protected readonly ownKeyLocked = computed(() => !this.funding.member());
  /** The membership's yearly price, e.g. "$10". */
  protected readonly price = computed(() =>
    formatCents(this.funding.membership()?.priceCents ?? 0),
  );
  /** "the model's OpenRouter list price (each top-up adds a 20% + 50¢ service fee)", once billing is loaded. */
  protected readonly feeText = computed(() => {
    const b = this.funding.billing();
    return b ? creditFeeText(b.serviceFee) : null;
  });
  /** "3 of 30 replies used today", once the learner's pool caps are loaded. */
  protected readonly poolUse = computed(() => {
    const caps = this.funding.poolMe()?.caps;
    return caps ? `${caps.usedRequests} of ${caps.requestsPerDay} replies used today` : null;
  });
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);

  protected close(): void {
    this.ui.dialogs.close('access');
  }

  protected choose(payment: Payer): void {
    this.error.set(null);
    // A way that needs no key sends the refused message: done here.
    if (this.funding.switchTo(payment)) this.close();
  }

  /** Replies run on the learner's own `key` from now on; a message waiting for it is sent once it is saved. */
  protected chooseKey(key: LearnKeyProvider): void {
    this.error.set(null);
    this.funding.chooseKey(key);
    if (this.funding.hasOwnKey() && this.lessons.resumeUnsent()) this.close();
  }

  protected async save({ apiKey }: KeySubmission): Promise<void> {
    const key = this.funding.ownKey();
    await this.run(async () => {
      await this.funding.saveKey(key, apiKey);
      this.toast.notify(`Your ${LEARN_KEY_LABELS[key]} key is saved`);
      if (this.payment() === 'own-key' && this.lessons.resumeUnsent()) this.close();
    });
  }

  protected async forget(): Promise<void> {
    await this.run(() => this.funding.forgetKey(this.funding.ownKey()));
  }

  private async run(fn: () => Promise<void>): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    try {
      await fn();
    } catch (err) {
      this.error.set(errorMessage(err));
    } finally {
      this.busy.set(false);
    }
  }
}
