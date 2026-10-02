import { ChangeDetectionStrategy, Component, computed, input, model } from '@angular/core';
import { isModelAllowed, type ProviderInfo } from '@tangent/shared';

let uid = 0;

/**
 * What is wrong with `model` for `provider`, or null when nothing is. Only an
 * `openModels` provider takes typed ids. (A copy of the power app's
 * ModelPicker rule: canvas doesn't import from apps/web.)
 */
export function modelHint(provider: ProviderInfo | null, model: string): string | null {
  if (!provider?.openModels) return null;
  if (model.trim() === '') return 'Enter a model id, or pick one of the suggestions.';
  if (!isModelAllowed(provider, model))
    return 'Not a model id: use letters, digits and . _ - : / (like vendor/model-name).';
  return null;
}

/**
 * The model of one provider. A provider with `openModels` (OpenRouter,
 * Tangent credit) takes any model id it serves: a text field whose datalist
 * keeps the suggestions one click away. Others offer a select of their
 * listed models.
 */
@Component({
  selector: 'app-model-field',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <label class="field">
      <span [class]="compact() ? 'sr-only' : 'field-label'">{{ label() }}</span>
      @if (provider()?.openModels) {
        <input
          #mi
          type="text"
          [attr.list]="id + '-l'"
          [value]="model()"
          (input)="model.set(mi.value)"
          (change)="model.set(mi.value.trim())"
          autocomplete="off"
          autocapitalize="off"
          spellcheck="false"
          maxlength="200"
          placeholder="vendor/model-name"
          [attr.aria-invalid]="hint() ? 'true' : null"
        />
        <datalist [id]="id + '-l'">
          @for (m of models(); track m.id) {
            <option [value]="m.id">{{ m.label }}</option>
          }
        </datalist>
        @if (hint(); as h) {
          <span class="field-error small">{{ h }}</span>
        }
      } @else {
        <select #ms [value]="model()" (change)="model.set(ms.value)">
          @if (!known()) {
            <option [value]="model()">{{ model() || '—' }}</option>
          }
          @for (m of models(); track m.id) {
            <option [value]="m.id" [selected]="m.id === model()">{{ m.label }}</option>
          }
        </select>
      }
    </label>
  `,
  host: { class: 'model-field' },
})
export class ModelField {
  readonly provider = input<ProviderInfo | null>(null);
  readonly label = input('Model');
  /** Visually hidden label (the variant rows of the branch dialog). */
  readonly compact = input(false);
  readonly model = model.required<string>();
  protected readonly id = `mf${++uid}`;

  protected readonly models = computed(() => this.provider()?.models ?? []);
  protected readonly known = computed(() => this.models().some((m) => m.id === this.model()));
  protected readonly hint = computed(() => modelHint(this.provider(), this.model()));
}
