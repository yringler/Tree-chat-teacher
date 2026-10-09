import { ChangeDetectionStrategy, Component, computed, input, model } from '@angular/core';
import type { ProviderInfo } from '@tangent/shared';
import { modelHint, ModelSuggestions } from '@tangent/web-shared';

let uid = 0;

/**
 * The model of one provider. A provider with `openModels` (OpenRouter,
 * Tangent credit) takes any model id it serves: a text field with its listed
 * models as chips under it, all in view and one click away
 * (ModelSuggestions). Others offer a select of their listed models.
 */
@Component({
  selector: 'app-model-field',
  imports: [ModelSuggestions],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (provider()?.openModels) {
      <!-- A div, not a label: the label would name the field after the chips too. -->
      <div class="field">
        <label [class]="compact() ? 'sr-only' : 'field-label'" [for]="id">{{ label() }}</label>
        <input
          #mi
          type="text"
          [id]="id"
          [value]="model()"
          (input)="model.set(mi.value)"
          (change)="model.set(mi.value.trim())"
          autocomplete="off"
          autocapitalize="off"
          spellcheck="false"
          maxlength="200"
          placeholder="vendor/model-name"
          [attr.aria-invalid]="hint() ? 'true' : null"
          [attr.aria-describedby]="hint() ? id + '-h' : null"
        />
        <app-model-suggestions
          [models]="models()"
          [value]="model()"
          [label]="label() + ' suggestions'"
          (picked)="model.set($event)"
        />
        @if (hint(); as h) {
          <span class="field-error small" [id]="id + '-h'">{{ h }}</span>
        }
      </div>
    } @else {
      <label class="field">
        <span [class]="compact() ? 'sr-only' : 'field-label'">{{ label() }}</span>
        <select #ms [value]="model()" (change)="model.set(ms.value)">
          @if (!known()) {
            <option [value]="model()">{{ model() || '—' }}</option>
          }
          @for (m of models(); track m.id) {
            <option [value]="m.id" [selected]="m.id === model()">{{ m.label }}</option>
          }
        </select>
      </label>
    }
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
