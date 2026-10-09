import {
  ChangeDetectionStrategy,
  Component,
  computed,
  type ElementRef,
  inject,
  input,
  type OnDestroy,
  type OnInit,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import {
  OPENROUTER_PROVIDER_ID,
  type BillingSummary,
  type Branch,
  type ProviderInfo,
} from '@tangent/shared';
import { formatMicros } from '../billing/format';
import { KeyMissingNotice } from '../billing/key-missing';
import { creditFeeText } from '../billing/membership';
import { Icon } from '../ui/icon';
import { Modal } from '../ui/modal';
import { ToastStore } from '../ui/toasts';
import { PowerConversationStore } from './power-conversation-store';

/** The one line that says what a call on Tangent credit costs. */
export function creditFeeSentence(
  b: Pick<BillingSummary, 'openRouterFeeBps' | 'markupBps'>,
): string {
  return `Each call costs ${creditFeeText(b.markupBps, b.openRouterFeeBps)}, taken from your credit.`;
}

/**
 * Keys & credit, in power and the canvas (the app provides its store as
 * `PowerConversationStore`). Bring-your-own-key: the key is read from the
 * input only at submit time, posted once, and the field is cleared right
 * away: the app never keeps it in a signal, in storage or anywhere else. The
 * server seals it into an HttpOnly cookie this code can't read, which both
 * apps (and Learn, for OpenRouter) use. Where the server offers the built-in
 * provider, its row shows the user's credit and links to the billing page.
 *
 * Opened by a send the server refused for want of the branch's own key
 * (`blockedSends`), it says so on top and offers to carry the branch on
 * with Tangent credit; that, or saving the key, sends the message. Closed
 * without either, nothing is sent and the message stays in the composer.
 */
@Component({
  selector: 'app-keys-dialog',
  imports: [Modal, Icon, KeyMissingNotice, RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <app-modal [heading]="credit() ? 'Keys & credit' : 'API keys'" (closed)="closed.emit()">
      @if (store.blockedBranch(); as b) {
        <app-key-missing-notice
          [branchTitle]="titleOf()(b)"
          [providerLabel]="store.account.providerOf(b)?.label ?? b.providerId"
          [credit]="store.account.creditRoute() !== null"
          [balance]="balance()"
          [keyForm]="enabled()"
          [busy]="switching()"
          (useCredit)="useCredit()"
        />
      }
      @if (store.account.keyStatus(); as status) {
        @if (!status.enabled) {
          <p class="notice">
            This server isn't set up to store your own API keys (KEY_ENCRYPTION_SECRET is not set).
            Only keys configured on the server can be used.
          </p>
        }
      }

      <ul class="key-list">
        @for (p of keyProviders(); track p.id) {
          <li class="key-row">
            <span class="key-name"
              >{{ p.label }}
              @if (p.id === learnKey) {
                <span class="muted small">· also used by Learn</span>
              }
            </span>
            @switch (p.keySource) {
              @case ('user') {
                <span class="badge badge-ok">your key</span>
                <button
                  type="button"
                  class="btn btn-ghost btn-sm"
                  [disabled]="busy()"
                  (click)="forget(p.id)"
                >
                  Forget
                </button>
              }
              @case ('server') {
                <span class="badge">server key</span>
              }
              @default {
                <span class="badge badge-warn">no key</span>
              }
            }
          </li>
        }
        @if (credit()) {
          <li class="key-row credit-row">
            <span class="key-name">Tangent credit</span>
            @if (store.account.billing(); as b) {
              <span class="badge" [class.badge-ok]="b.availableMicros > 0"
                >{{ usd(b.availableMicros) }} available</span
              >
            } @else {
              <span class="muted small">Loading…</span>
            }
            @if (billingHref(); as href) {
              <a [href]="href" class="btn btn-ghost btn-sm">Add credit</a>
            } @else {
              <a routerLink="/billing" class="btn btn-ghost btn-sm" (click)="closed.emit()"
                >Add credit</a
              >
            }
          </li>
        }
      </ul>
      @if (credit() && store.account.billing(); as b) {
        <p class="muted small">
          {{ fees(b) }} No key needed: pick “Tangent credit” as the provider, for a new conversation
          or any {{ noun() }} (its settings, also under the message box).
        </p>
      }

      @if (enabled()) {
        <form class="form" (submit)="$event.preventDefault(); save()">
          <div class="field-row">
            <label class="field">
              <span class="field-label">Provider</span>
              <select #ps [value]="provider()" (change)="provider.set(ps.value)">
                @for (p of keyProviders(); track p.id) {
                  <option [value]="p.id" [selected]="p.id === provider()">{{ p.label }}</option>
                }
              </select>
            </label>
            <label class="field">
              <span class="field-label">API key</span>
              <input
                #keyInput
                type="password"
                name="api-key"
                autocomplete="off"
                autocapitalize="off"
                spellcheck="false"
                required
                maxlength="512"
                autofocus
              />
            </label>
          </div>
          <p class="muted small">
            Your key is sent once to this server, checked with {{ providerLabel() }}, encrypted with
            a server-side secret and stored only in your browser as a cookie that page scripts can't
            read. It is not saved on the server. Every chat request sends it back to the server,
            which decrypts it in memory to call the provider, so you are trusting this server not to
            log it. It expires after 7 days without use.
          </p>
          <div class="form-actions">
            @if (store.account.keyStatus()?.hasKey) {
              <button
                type="button"
                class="btn btn-danger-ghost btn-left"
                [disabled]="busy()"
                (click)="forget()"
              >
                <app-icon name="trash" /> Forget all keys
              </button>
            }
            <button type="button" class="btn btn-ghost" (click)="closed.emit()">Close</button>
            <button type="submit" class="btn btn-primary" [disabled]="busy()">
              {{ busy() ? 'Checking…' : 'Save key' }}
            </button>
          </div>
        </form>
      }
    </app-modal>
  `,
})
export class KeysDialog implements OnInit, OnDestroy {
  protected readonly store = inject(PowerConversationStore);
  private readonly toast = inject(ToastStore);
  /** Provider to preselect (e.g. the one a refused request needed). */
  readonly initialProvider = input<string | null>(null);
  /** What the app calls a branch ("branch", "lane"). */
  readonly noun = input('branch');
  /** A branch's title as the app shows it (the refused send's notice). */
  readonly titleOf = input<(branch: Branch) => string>((b) => b.title);
  /**
   * The billing page as a page load, for an app without its own `/billing`
   * route (the canvas uses power's); null: the app's `/billing` route.
   */
  readonly billingHref = input<string | null>(null);
  /** Close, Escape, the backdrop, or a link away: the app closes the dialog. */
  readonly closed = output();

  private readonly keyInput = viewChild<ElementRef<HTMLInputElement>>('keyInput');
  protected readonly provider = signal('');
  protected readonly busy = signal(false);
  /** "Continue on Tangent credit" is moving the branch. */
  protected readonly switching = signal(false);

  protected readonly learnKey = OPENROUTER_PROVIDER_ID;
  protected readonly usd = formatMicros;
  protected readonly fees = creditFeeSentence;
  /** The server offers the built-in provider on the user's credit. */
  protected readonly credit = computed(() => this.store.account.me()?.builtInCredit ?? false);

  protected readonly keyProviders = computed<ProviderInfo[]>(() =>
    this.store.account.providers().filter((p) => p.acceptsUserKey),
  );
  protected readonly enabled = computed(
    () => (this.store.account.keyStatus()?.enabled ?? false) && this.keyProviders().length > 0,
  );
  protected readonly providerLabel = computed(
    () => this.keyProviders().find((p) => p.id === this.provider())?.label ?? 'the provider',
  );
  /** The credit available, for the refused send's notice. */
  protected readonly balance = computed(() => {
    const b = this.store.account.billing();
    return b ? formatMicros(b.availableMicros) : null;
  });

  ngOnInit(): void {
    if (this.credit()) void this.store.account.refreshBilling();
    const wanted = this.initialProvider();
    const list = this.keyProviders();
    const pick =
      list.find((p) => p.id === wanted) ?? list.find((p) => !p.available) ?? list[0] ?? null;
    this.provider.set(pick?.id ?? '');
  }

  /** However it closes (Close, Escape, a send carried on): nothing waits on it any more. */
  ngOnDestroy(): void {
    this.store.dropBlockedSends();
  }

  protected async useCredit(): Promise<void> {
    if (this.switching()) return;
    this.switching.set(true);
    try {
      await this.store.resumeOnCredit();
    } finally {
      this.switching.set(false);
    }
  }

  protected async save(): Promise<void> {
    const el = this.keyInput()?.nativeElement;
    if (!el || !this.provider()) return;
    const apiKey = el.value.trim();
    // Clear the field before the request: the value lives only in this call.
    el.value = '';
    if (!apiKey) return;
    this.busy.set(true);
    const ok = await this.store.account.saveKey(this.provider(), apiKey);
    this.busy.set(false);
    if (ok) {
      this.toast.notify(`${this.providerLabel()} key saved`);
      this.store.resumeAfterKey(this.provider());
    }
  }

  protected async forget(provider?: string): Promise<void> {
    this.busy.set(true);
    await this.store.account.forgetKey(provider);
    this.busy.set(false);
    this.toast.notify(provider ? 'Key forgotten' : 'All keys forgotten');
  }
}
