import { ChangeDetectionStrategy, Component, computed, inject, model } from '@angular/core';
import { TreeStore } from '../state/tree-store';

let uid = 0;

/** Provider + model selects. Providers without an API key are listed but disabled. */
@Component({
  selector: 'app-model-picker',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="field-row">
      <label class="field">
        <span class="field-label">Provider</span>
        <select #ps [id]="id + '-p'" [value]="providerId()" (change)="pickProvider(ps.value)">
          @if (!known()) {
            <option [value]="providerId()">{{ providerId() }} (not configured)</option>
          }
          @for (p of store.providers(); track p.id) {
            <option [value]="p.id" [disabled]="!p.available" [selected]="p.id === providerId()">
              {{ p.label }}{{ p.available ? '' : ' — missing API key' }}
            </option>
          }
        </select>
      </label>
      <label class="field">
        <span class="field-label">Model</span>
        <select #ms [id]="id + '-m'" [value]="modelId()" (change)="modelId.set(ms.value)">
          @if (!modelKnown()) {
            <option [value]="modelId()">{{ modelId() || '—' }}</option>
          }
          @for (m of models(); track m.id) {
            <option [value]="m.id" [selected]="m.id === modelId()">{{ m.label }}</option>
          }
        </select>
      </label>
    </div>
  `,
})
export class ModelPicker {
  protected readonly store = inject(TreeStore);
  readonly providerId = model.required<string>();
  readonly modelId = model.required<string>();
  protected readonly id = `mp${++uid}`;

  private readonly provider = computed(
    () => this.store.providerMap().get(this.providerId()) ?? null,
  );
  protected readonly known = computed(() => this.provider() !== null);
  protected readonly models = computed(() => this.provider()?.models ?? []);
  protected readonly modelKnown = computed(() =>
    this.models().some((m) => m.id === this.modelId()),
  );

  protected pickProvider(id: string): void {
    this.providerId.set(id);
    const p = this.store.providerMap().get(id);
    if (p) this.modelId.set(p.defaultModel);
  }
}
