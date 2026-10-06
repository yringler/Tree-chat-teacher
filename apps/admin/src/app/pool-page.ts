import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import type { AdminCreditRequest, AdminCreditResponse, AdminPoolResponse } from '@tangent/shared';
import { ApiClient, errorMessage, formatCharge } from '@tangent/web-shared';
import { signedCreditCents } from './credit-amount';

/** What the pool credit form holds. */
export interface PoolCreditForm {
  /** Dollars as typed; a leading `-` debits. */
  amount: string;
  /** The user the adjustment is recorded for (e.g. a shared-access arrangement), or blank. */
  userId: string;
  note: string;
}

/**
 * The `POST /api/admin/credit` request for the pool form, or the reason it
 * can't be sent. `idempotencyKey` is the form's current key: a retried submit
 * of the same form is a no-op on the server.
 */
export function poolCreditRequest(
  form: PoolCreditForm,
  idempotencyKey: string,
): AdminCreditRequest | string {
  const amountCents = signedCreditCents(form.amount);
  if (typeof amountCents === 'string') return amountCents;
  const userId = form.userId.trim();
  const note = form.note.trim();
  return {
    target: 'pool',
    userId: userId === '' ? null : userId,
    amountCents,
    mode: 'adjustment',
    idempotencyKey,
    ...(note ? { note } : {}),
  };
}

function newKey(): string {
  return `pool-${crypto.randomUUID()}`;
}

/**
 * The community pool's ledger (`GET /api/admin/pool`): balance, what pending
 * reservations hold, and the overage breaker (while tripped, the pool refuses
 * every request until the window's overage falls back under the limit or the
 * price table is fixed). Below it, a top-up or correction of the pool
 * (`POST /api/admin/credit`, an adjustment; a negative one is clamped to what
 * is available): how the operator adds credit beyond the automatic revenue
 * share. Nobody buys pool credit, so there is no simulated pool purchase.
 */
@Component({
  selector: 'app-pool-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h2>Community pool</h2>
    @if (error(); as e) {
      <p class="notice notice-error" role="alert">{{ e }}</p>
    }
    @if (pool(); as p) {
      @if (!p.enabled) {
        <p class="notice" role="status">
          <span>The pool is off (POOL_ENABLED, or no usable built-in provider).</span>
        </p>
      }
      @if (p.breaker.tripped) {
        <p class="notice notice-error" role="alert">
          <span>
            <strong>Overage breaker tripped:</strong> the pool refuses every request. Settled
            overage in the last {{ hours(p.breaker.windowMs) }} h is
            {{ money(p.breaker.overageMicros) }}, above the {{ money(p.breaker.maxMicros) }} limit
            (POOL_OVERAGE_MAX_MICROS). Check the model price table.
          </span>
        </p>
      }
      <dl class="admin-facts">
        <dt>Available</dt>
        <dd>{{ money(p.availableMicros) }}</dd>
        <dt>Balance</dt>
        <dd>{{ money(p.balanceMicros) }}</dd>
        <dt>Held</dt>
        <dd>{{ money(p.heldMicros) }} ({{ p.pendingCalls }} pending)</dd>
        <dt>Overage breaker</dt>
        <dd>
          @if (p.breaker.tripped) {
            <span class="badge badge-danger">tripped</span>
          } @else {
            <span class="badge badge-ok">ok</span>
          }
          {{ money(p.breaker.overageMicros) }} of {{ money(p.breaker.maxMicros) }} in
          {{ hours(p.breaker.windowMs) }} h
        </dd>
        <dt>Account</dt>
        <dd>
          <code class="admin-id">{{ p.accountId }}</code>
        </dd>
      </dl>
      <form class="admin-search" (submit)="$event.preventDefault(); credit()">
        <label class="field">
          <span class="field-label">Amount ($, negative to debit)</span>
          <input
            type="text"
            inputmode="decimal"
            [value]="form().amount"
            (input)="patch({ amount: $any($event.target).value })"
          />
        </label>
        <label class="field">
          <span class="field-label">For user id (optional)</span>
          <input
            type="text"
            [value]="form().userId"
            (input)="patch({ userId: $any($event.target).value })"
          />
        </label>
        <label class="field">
          <span class="field-label">Note</span>
          <input
            type="text"
            maxlength="200"
            [value]="form().note"
            (input)="patch({ note: $any($event.target).value })"
          />
        </label>
        <button type="submit" class="btn" [disabled]="busy()">Apply</button>
        <button type="button" class="btn" [disabled]="loading()" (click)="load()">Refresh</button>
      </form>
      @if (result(); as r) {
        <p class="muted small" role="status">
          {{
            r.credited
              ? 'Applied ' +
                money(r.amountMicros) +
                '; pool balance ' +
                money(r.balanceMicros) +
                '.'
              : 'Already applied (same request); nothing changed.'
          }}
        </p>
      }
    } @else if (loading()) {
      <p class="muted small" aria-busy="true">Loading…</p>
    }
  `,
})
export class PoolPage {
  private readonly api = inject(ApiClient);
  protected readonly pool = signal<AdminPoolResponse | null>(null);
  protected readonly form = signal<PoolCreditForm>({
    amount: '',
    userId: '',
    note: '',
  });
  protected readonly result = signal<AdminCreditResponse | null>(null);
  protected readonly loading = signal(false);
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  /** Kept until a submit succeeds or the form changes, so a retried submit is a no-op. */
  private key = newKey();

  constructor() {
    void this.load();
  }

  protected patch(change: Partial<PoolCreditForm>): void {
    this.form.update((f) => ({ ...f, ...change }));
    this.key = newKey();
  }

  protected async load(): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    try {
      this.pool.set(await this.api.adminPool());
    } catch (err) {
      this.error.set(errorMessage(err));
    } finally {
      this.loading.set(false);
    }
  }

  protected async credit(): Promise<void> {
    const form = this.form();
    const req = poolCreditRequest(form, this.key);
    if (typeof req === 'string') {
      this.error.set(req);
      return;
    }
    this.busy.set(true);
    this.error.set(null);
    this.result.set(null);
    try {
      this.result.set(await this.api.adminCredit(req));
      this.key = newKey();
      this.form.set({ amount: '', userId: '', note: '' });
      await this.load();
    } catch (err) {
      this.error.set(errorMessage(err));
    } finally {
      this.busy.set(false);
    }
  }

  protected money(micros: number): string {
    return formatCharge(micros);
  }

  protected hours(ms: number): number {
    return Math.round((ms / 3_600_000) * 10) / 10;
  }
}
