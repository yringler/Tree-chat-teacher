import {
  ChangeDetectionStrategy,
  Component,
  computed,
  type ElementRef,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import type { LearnPayment } from '@tangent/shared';
import { creditFeeText, errorMessage, Icon, Modal, PoolMeter } from '@tangent/web-shared';
import { AccountStore } from '../state/account-store';
import { UiStore } from '../state/ui-store';

/**
 * How replies are paid for: the learner's own OpenRouter key (free here; they
 * pay OpenRouter), Tangent credit (prepaid, on the built-in provider), which
 * is only offered when the server sells it, or the community pool, while it
 * is on. The key is read from the input only at submit time, posted once
 * and the field cleared: the server seals it into an HttpOnly cookie this
 * code can't read (the same cookie as power mode's OpenRouter key).
 */
@Component({
  selector: 'app-model-access-dialog',
  imports: [Modal, Icon, PoolMeter, RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <app-modal heading="How replies are paid for" (closed)="close()">
      @if (account.payment.builtInCredit() || account.payment.poolAvailable()) {
        <fieldset class="access-choice">
          <legend class="sr-only">Pay with</legend>
          <label class="access-option">
            <input
              type="radio"
              name="payment"
              value="own-key"
              [checked]="payment() === 'own-key'"
              (change)="choose('own-key')"
            />
            <span>
              <strong>Use my own OpenRouter key</strong>
              <span class="muted small">Free here: you pay OpenRouter directly.</span>
            </span>
          </label>
          @if (account.payment.builtInCredit()) {
            <label class="access-option">
              <input
                type="radio"
                name="payment"
                value="credit"
                [checked]="payment() === 'credit'"
                (change)="choose('credit')"
              />
              <span>
                <strong>Use Tangent credit</strong>
                <span class="muted small">
                  @if (feeText(); as fee) {
                    Prepaid credit: each reply costs {{ fee }}.
                  } @else {
                    Prepaid credit, paid per reply.
                  }
                </span>
              </span>
            </label>
          }
          @if (account.payment.poolAvailable()) {
            <label class="access-option">
              <input
                type="radio"
                name="payment"
                value="pool"
                [checked]="payment() === 'pool'"
                (change)="choose('pool')"
              />
              <span>
                <strong>Use the community pool</strong>
                <span class="muted small">
                  Free to you, within daily limits, on
                  {{ account.poolStatus()?.model?.label ?? 'one economical model' }}. Free credit
                  Tangent provides from its revenue.
                </span>
              </span>
            </label>
          }
        </fieldset>
      } @else {
        <p class="muted small">
          Replies run on your own OpenRouter key: you pay OpenRouter directly, and Tangent charges
          nothing.
        </p>
      }

      @if (payment() === 'pool') {
        @if (account.poolStatus(); as status) {
          <app-pool-meter [status]="status" [compact]="true" />
        }
        <p class="small">
          @if (poolUse(); as use) {
            <span>{{ use }} · </span>
          }
          <a href="/pool" target="_blank" rel="noopener">How the pool works</a>
        </p>
      } @else if (payment() === 'credit') {
        <p class="small">
          @if (account.balanceLabel(); as balance) {
            <span>{{ balance }} available · </span>
          }
          <a routerLink="/billing" (click)="close()">Add credit</a>
        </p>
      } @else {
        @if (account.keyStatus(); as status) {
          @if (!status.enabled) {
            <p class="notice">
              This server can't store your own key (KEY_ENCRYPTION_SECRET is not set).
            </p>
          } @else {
            <div class="key-row">
              <span class="key-name">OpenRouter key</span>
              @if (account.hasOwnKey()) {
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
            <form class="form" (submit)="$event.preventDefault(); save()">
              <label class="field">
                <span class="field-label">
                  {{ account.hasOwnKey() ? 'Replace your key' : 'Your OpenRouter API key' }}
                </span>
                <input
                  #keyInput
                  type="password"
                  autocomplete="off"
                  spellcheck="false"
                  placeholder="sk-or-…"
                  required
                />
              </label>
              <p class="muted small">
                Create one at
                <a href="https://openrouter.ai/settings/keys" target="_blank" rel="noopener"
                  >openrouter.ai</a
                >. It is stored encrypted in this browser only, for 7 days, and power mode's
                OpenRouter provider uses it too.
              </p>
              <div class="form-actions">
                <button type="submit" class="btn btn-primary" [disabled]="busy()">
                  <app-icon name="key" [size]="14" /> Save key
                </button>
              </div>
            </form>
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
  protected readonly account = inject(AccountStore);
  private readonly ui = inject(UiStore);
  private readonly keyInput = viewChild<ElementRef<HTMLInputElement>>('keyInput');

  protected readonly payment = this.account.payment.payment;
  /** "the model's OpenRouter price + 5.5% OpenRouter fee + 10%", once billing is loaded. */
  protected readonly feeText = computed(() => {
    const b = this.account.billing();
    return b ? creditFeeText(b.markupBps, b.openRouterFeeBps) : null;
  });
  /** "3 of 30 replies used today", once the learner's pool caps are loaded. */
  protected readonly poolUse = computed(() => {
    const caps = this.account.poolMe()?.caps;
    return caps ? `${caps.usedRequests} of ${caps.requestsPerDay} replies used today` : null;
  });
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);

  protected close(): void {
    this.ui.accessOpen.set(false);
  }

  protected choose(payment: LearnPayment): void {
    this.error.set(null);
    this.account.payment.choose(payment);
    if (payment === 'credit') void this.account.refreshBalance();
    if (payment === 'pool') void this.account.switchToPool();
  }

  protected async save(): Promise<void> {
    const input = this.keyInput()?.nativeElement;
    const apiKey = input?.value.trim() ?? '';
    if (input) input.value = '';
    if (!apiKey) return;
    await this.run(async () => {
      await this.account.saveKey(apiKey);
      this.ui.notify('Your OpenRouter key is saved');
    });
  }

  protected async forget(): Promise<void> {
    await this.run(() => this.account.forgetKey());
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
