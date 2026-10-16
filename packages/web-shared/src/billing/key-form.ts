import {
  ChangeDetectionStrategy,
  Component,
  computed,
  type ElementRef,
  input,
  model,
  output,
  viewChild,
} from '@angular/core';

/** A provider the form takes a key for. */
export interface KeyFormProvider {
  readonly id: string;
  readonly label: string;
}

/** What the form hands over on submit: the key, read once and already gone from the field. */
export interface KeySubmission {
  readonly provider: string;
  readonly apiKey: string;
}

/**
 * The form a user saves their own API key with, in power's keys dialog and
 * in Learn's payment dialog. The key is read from the field only at submit
 * time and the field is cleared before anything else runs, so the key lives
 * only in the `saved` event: never in a signal, in storage or anywhere else.
 * The server seals it into an HttpOnly cookie no page script can read, which
 * the paragraph below the field says, the same in both apps.
 *
 * With more than one provider it shows a picker (`provider`, two-way); with
 * one it takes that one's key. Content goes between the field and Save
 * (e.g. where to create a key); buttons marked `keyFormActions` go before
 * Save. The paragraph comes last, so Save stays above the fold on a phone.
 */
@Component({
  selector: 'app-key-form',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <form class="form" (submit)="$event.preventDefault(); submit()">
      <div class="field-row">
        @if (providers().length > 1) {
          <label class="field">
            <span class="field-label">Provider</span>
            <select #ps [value]="provider()" (change)="provider.set(ps.value)">
              @for (p of providers(); track p.id) {
                <option [value]="p.id" [selected]="p.id === provider()">{{ p.label }}</option>
              }
            </select>
          </label>
        }
        <label class="field">
          <span class="field-label">{{ label() }}</span>
          <input
            #keyInput
            type="password"
            name="api-key"
            autocomplete="off"
            autocapitalize="off"
            spellcheck="false"
            required
            maxlength="512"
            [attr.placeholder]="placeholder()"
            [attr.autofocus]="autofocus() ? '' : null"
          />
        </label>
      </div>
      <ng-content />
      <div class="form-actions">
        <ng-content select="[keyFormActions]" />
        <button type="submit" class="btn btn-primary" [disabled]="busy()">
          {{ busy() ? 'Checking…' : 'Save key' }}
        </button>
      </div>
      <p class="muted small">
        Your key is sent once to this server, checked with {{ providerLabel() }}, encrypted with a
        server-side secret and stored only in your browser as a cookie that page scripts can't read.
        It is not saved on the server. Every chat request sends it back to the server, which
        decrypts it in memory to call the provider, so you are trusting this server not to log it.
        It expires after 7 days without use.
      </p>
    </form>
  `,
})
export class KeyForm {
  /** The providers that take a key here. */
  readonly providers = input.required<readonly KeyFormProvider[]>();
  /** The provider the key is for (two-way: the picker sets it). */
  readonly provider = model('');
  /** The field's label. */
  readonly label = input('API key');
  /** What a key looks like, e.g. "sk-or-…". */
  readonly placeholder = input<string | null>(null);
  /** A save is in flight: the button waits. */
  readonly busy = input(false);
  /** The field takes the focus when its dialog opens (Modal focuses `[autofocus]`). */
  readonly autofocus = input(false);
  /** A key was submitted: the field is already empty. */
  readonly saved = output<KeySubmission>();

  private readonly keyInput = viewChild.required<ElementRef<HTMLInputElement>>('keyInput');

  protected readonly providerLabel = computed(
    () => this.providers().find((p) => p.id === this.provider())?.label ?? 'the provider',
  );

  protected submit(): void {
    const el = this.keyInput().nativeElement;
    const apiKey = el.value.trim();
    // Clear the field before anything else: the value lives only in the event.
    el.value = '';
    const provider = this.provider();
    if (!apiKey || !provider) return;
    this.saved.emit({ provider, apiKey });
  }
}
