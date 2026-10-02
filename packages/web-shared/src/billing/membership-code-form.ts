import { ChangeDetectionStrategy, Component, inject, output } from '@angular/core';
import type { MembershipInfo } from '@tangent/shared';
import { ApiClient } from '../core/api-client';
import { WaiverForm } from './membership';

let uid = 0;

/**
 * "Have a code?": redeems the operator's membership code (it waives the
 * yearly fee). Collapsed until asked for, so it doesn't compete with Subscribe.
 */
@Component({
  selector: 'app-membership-code-form',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <details class="membership-code">
      <summary class="link-btn">Have a code?</summary>
      <form
        class="membership-code-form"
        novalidate
        (submit)="$event.preventDefault(); form.submit(code.value)"
      >
        <label class="field">
          <span class="field-label">Membership code</span>
          <input
            #code
            type="text"
            autocomplete="off"
            autocapitalize="off"
            spellcheck="false"
            [attr.aria-invalid]="form.error() ? 'true' : null"
            [attr.aria-describedby]="form.error() ? errorId : null"
            (input)="form.clearError()"
          />
        </label>
        <button type="submit" class="btn" [disabled]="form.busy()">
          {{ form.busy() ? 'Checking…' : 'Use code' }}
        </button>
      </form>
      @if (form.error(); as e) {
        <p [id]="errorId" class="small billing-error" role="alert">{{ e }}</p>
      }
    </details>
  `,
})
export class MembershipCodeForm {
  /** The code worked: the membership is now `waived`. */
  readonly redeemed = output<MembershipInfo>();
  protected readonly errorId = `membership-code-err-${++uid}`;
  private readonly api = inject(ApiClient);
  protected readonly form = new WaiverForm(
    (code) => this.api.redeemMembershipWaiver(code),
    (m) => this.redeemed.emit(m),
  );
}
