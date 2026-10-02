import {
  ChangeDetectionStrategy,
  Component,
  computed,
  type ElementRef,
  inject,
  input,
  type OnInit,
  signal,
  viewChild,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { LEARN_KEY_PROVIDER, type ProviderInfo } from '@tangent/shared';
import { TreeStore } from '../state/tree-store';
import { UiStore } from '../state/ui-store';
import { formatMicros, Icon, Modal } from '@tangent/web-shared';
import { feeSentence } from '../ui/credit';

/**
 * Keys & credit. Bring-your-own-key: the key is read from the input only at
 * submit time, posted once, and the field is cleared right away: the app
 * never keeps it in a signal, in storage or anywhere else. The server seals
 * it into an HttpOnly cookie this code can't read. Where the server offers
 * the built-in provider, its row shows the user's credit (shared with Learn)
 * and links to `/billing` to add more.
 */
@Component({
  selector: 'app-api-keys',
  imports: [Modal, Icon, RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <app-modal [heading]="credit() ? 'Keys & credit' : 'API keys'" (closed)="close()">
      @if (store.keyStatus(); as status) {
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
            @if (store.billing(); as b) {
              <span class="badge" [class.badge-ok]="b.availableMicros > 0"
                >{{ usd(b.availableMicros) }} available</span
              >
            } @else {
              <span class="muted small">Loading…</span>
            }
            <a routerLink="/billing" class="btn btn-ghost btn-sm" (click)="close()">Add credit</a>
          </li>
        }
      </ul>
      @if (credit() && store.billing(); as b) {
        <p class="muted small">
          {{ fees(b) }} No key needed: pick “Tangent credit” as the provider.
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
            log it. It expires after 7 days.
          </p>
          <div class="form-actions">
            @if (store.keyStatus()?.hasKey) {
              <button
                type="button"
                class="btn btn-danger-ghost btn-left"
                [disabled]="busy()"
                (click)="forget()"
              >
                <app-icon name="trash" /> Forget all keys
              </button>
            }
            <button type="button" class="btn btn-ghost" (click)="close()">Close</button>
            <button type="submit" class="btn btn-primary" [disabled]="busy()">
              {{ busy() ? 'Checking…' : 'Save key' }}
            </button>
          </div>
        </form>
      }
    </app-modal>
  `,
})
export class ApiKeys implements OnInit {
  protected readonly store = inject(TreeStore);
  private readonly ui = inject(UiStore);
  /** Provider to preselect (e.g. the one a failed request needed). */
  readonly initialProvider = input<string | null>(null);

  private readonly keyInput = viewChild<ElementRef<HTMLInputElement>>('keyInput');
  protected readonly provider = signal('');
  protected readonly busy = signal(false);

  protected readonly learnKey = LEARN_KEY_PROVIDER;
  protected readonly usd = formatMicros;
  protected readonly fees = feeSentence;
  /** The server offers the built-in provider on the user's credit. */
  protected readonly credit = computed(() => this.store.me()?.builtInCredit ?? false);

  protected readonly keyProviders = computed<ProviderInfo[]>(() =>
    this.store.providers().filter((p) => p.acceptsUserKey),
  );
  protected readonly enabled = computed(
    () => (this.store.keyStatus()?.enabled ?? false) && this.keyProviders().length > 0,
  );
  protected readonly providerLabel = computed(
    () => this.keyProviders().find((p) => p.id === this.provider())?.label ?? 'the provider',
  );

  ngOnInit(): void {
    if (this.credit()) void this.store.refreshBilling();
    const wanted = this.initialProvider();
    const list = this.keyProviders();
    const pick =
      list.find((p) => p.id === wanted) ?? list.find((p) => !p.available) ?? list[0] ?? null;
    this.provider.set(pick?.id ?? '');
  }

  protected close(): void {
    this.ui.keysDialog.set(null);
  }

  protected async save(): Promise<void> {
    const el = this.keyInput()?.nativeElement;
    if (!el || !this.provider()) return;
    const apiKey = el.value.trim();
    // Clear the field before the request: the value lives only in this call.
    el.value = '';
    if (!apiKey) return;
    this.busy.set(true);
    const ok = await this.store.saveKey(this.provider(), apiKey);
    this.busy.set(false);
    if (ok) this.ui.notify(`${this.providerLabel()} key saved`);
  }

  protected async forget(provider?: string): Promise<void> {
    this.busy.set(true);
    await this.store.forgetKey(provider);
    this.busy.set(false);
    this.ui.notify(provider ? 'Key forgotten' : 'All keys forgotten');
  }
}
