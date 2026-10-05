import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';

/** What a Learn reply can run on when both are offered. */
export type FundingOption = 'credit' | 'pool';

export const FUNDING_OPTIONS: readonly { id: FundingOption; label: string; hint: string }[] = [
  { id: 'credit', label: 'My credit', hint: 'Pay for replies from your own credit' },
  { id: 'pool', label: 'Community pool', hint: 'Use the community pool, within its daily limits' },
];

/**
 * The composer's funding switch (spec §8): the learner's own credit or the
 * community pool, shown only while both can pay. A radiogroup in the
 * segmented style of the Smart/Simple toggle.
 */
@Component({
  selector: 'app-funding-toggle',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="segmented funding-toggle" role="radiogroup" aria-label="Pay for replies with">
      @for (o of options; track o.id) {
        <button
          type="button"
          role="radio"
          class="segment"
          [class.is-on]="o.id === value()"
          [attr.aria-checked]="o.id === value()"
          [disabled]="disabled()"
          [title]="o.hint"
          (click)="o.id !== value() && changed.emit(o.id)"
        >
          {{ o.label }}
        </button>
      }
    </div>
  `,
})
export class FundingToggle {
  readonly value = input.required<FundingOption>();
  readonly disabled = input(false);
  readonly changed = output<FundingOption>();
  protected readonly options = FUNDING_OPTIONS;
}
