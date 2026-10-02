import {
  ChangeDetectionStrategy,
  Component,
  computed,
  type ElementRef,
  inject,
  type OnInit,
  signal,
  viewChild,
} from '@angular/core';
import type { ProviderInfo } from '@tangent/shared';
import { Icon, Modal } from '@tangent/web-shared';
import { CanvasStore } from '../state/canvas-store';
import { UiStore } from '../state/ui-store';

/**
 * Bring-your-own-key, as in the power app: the key is read from the input
 * only at submit time, posted once, and the field is cleared right away.
 * The server seals it into an HttpOnly cookie this code can't read; the
 * same cookie serves the power app.
 */
@Component({
  selector: 'app-keys-dialog',
  imports: [Modal, Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <app-modal heading="API keys" (closed)="close()">
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
            <span class="key-name">{{ p.label }}</span>
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
      </ul>

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
            read. It is the same key the power app uses. It expires after 7 days.
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
export class KeysDialog implements OnInit {
  protected readonly store = inject(CanvasStore);
  private readonly ui = inject(UiStore);

  private readonly keyInput = viewChild<ElementRef<HTMLInputElement>>('keyInput');
  protected readonly provider = signal('');
  protected readonly busy = signal(false);

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
    const list = this.keyProviders();
    const wanted = this.store.selectedBranch()?.providerId ?? null;
    const pick =
      list.find((p) => p.id === wanted && !p.available) ??
      list.find((p) => !p.available) ??
      list[0] ??
      null;
    this.provider.set(pick?.id ?? '');
  }

  protected close(): void {
    this.ui.keysOpen.set(false);
  }

  protected async save(): Promise<void> {
    const el = this.keyInput()?.nativeElement;
    if (!el || !this.provider()) return;
    const apiKey = el.value.trim();
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
