import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { maxUsageNote, type ModelInfo } from '@tangent/shared';

let uid = 0;

/**
 * Segmented Normal/Max switch over the provider's models (the tiers come
 * from `ModelInfo.tier`). `lockedHint` disables it and says why (on the open
 * pool, which uses one model). When that model is none of the listed ones
 * (the pool's "Lite"), no segment could be on, so the hint shows as text in
 * the switch's place: a title alone never reaches touch screens.
 */
@Component({
  selector: 'app-model-toggle',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (unlisted(); as hint) {
      <span class="model-locked muted small">{{ hint }}</span>
    } @else {
      <div
        class="segmented"
        role="radiogroup"
        [attr.aria-label]="label()"
        [attr.aria-describedby]="lockedHint() ? hintId : null"
      >
        @for (m of models(); track m.id) {
          <button
            type="button"
            role="radio"
            class="segment"
            [class.is-on]="m.id === value()"
            [attr.aria-checked]="m.id === value()"
            [disabled]="disabled() || lockedHint() !== null"
            [title]="lockedHint() ?? hintFor(m)"
            (click)="m.id !== value() && changed.emit(m.id)"
          >
            {{ m.label }}
          </button>
        }
      </div>
      @if (lockedHint(); as hint) {
        <span class="sr-only" [id]="hintId">{{ hint }}</span>
      }
    }
  `,
})
export class ModelToggle {
  readonly models = input.required<readonly ModelInfo[]>();
  readonly value = input<string | null>(null);
  readonly disabled = input(false);
  readonly label = input('Tutor');
  /** Disables the switch, saying why (e.g. "The open pool uses Lite."). */
  readonly lockedHint = input<string | null>(null);
  protected readonly hintId = `model-toggle-hint-${++uid}`;
  readonly changed = output<string>();

  /** The locked hint, when the locked model is none of the listed ones. */
  protected readonly unlisted = computed(() => {
    const hint = this.lockedHint();
    return hint !== null && !this.models().some((m) => m.id === this.value()) ? hint : null;
  });

  protected hintFor(m: ModelInfo): string {
    switch (m.tier) {
      case 'normal':
        return 'Normal: clear, thorough answers';
      case 'max':
        return `Max: our strongest model. ${maxUsageNote(m.usageFactor)}`;
      default:
        return m.label;
    }
  }
}
