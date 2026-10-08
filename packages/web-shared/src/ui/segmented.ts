import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';

/** One choice of a Segmented control. `hint` is its tooltip. */
export interface SegmentedOption {
  id: string;
  label: string;
  hint?: string;
}

/**
 * A pill of mutually exclusive buttons (`.segmented` / `.segment` in
 * base.css). `kind: 'radio'` is a radiogroup for a setting (e.g. Normal |
 * Max); `kind: 'tab'` is a tablist over panels whose ids are
 * `${controls}-${option.id}`. Left/Right arrows move between options.
 */
@Component({
  selector: 'app-segmented',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div
      class="segmented"
      [attr.role]="kind() === 'tab' ? 'tablist' : 'radiogroup'"
      [attr.aria-label]="label()"
    >
      @for (o of options(); track o.id) {
        <button
          type="button"
          class="segment"
          [class.is-on]="o.id === value()"
          [attr.role]="kind()"
          [attr.aria-checked]="kind() === 'radio' ? o.id === value() : null"
          [attr.aria-selected]="kind() === 'tab' ? o.id === value() : null"
          [attr.aria-controls]="kind() === 'tab' && controls() ? controls() + '-' + o.id : null"
          [attr.id]="kind() === 'tab' && controls() ? controls() + '-tab-' + o.id : null"
          [attr.tabindex]="o.id === value() || value() === null ? 0 : -1"
          [disabled]="disabled()"
          [title]="o.hint ?? o.label"
          (click)="pick(o.id)"
          (keydown.arrowLeft)="step($event, -1)"
          (keydown.arrowRight)="step($event, 1)"
        >
          {{ o.label }}
        </button>
      }
    </div>
  `,
})
export class Segmented {
  readonly options = input.required<readonly SegmentedOption[]>();
  readonly value = input<string | null>(null);
  readonly disabled = input(false);
  /** The group's accessible name. */
  readonly label = input.required<string>();
  readonly kind = input<'radio' | 'tab'>('radio');
  /** Tab kind: the panel id prefix (`${controls}-${option.id}`). */
  readonly controls = input<string | null>(null);
  /** The option picked; only when it differs from `value`. */
  readonly changed = output<string>();

  protected pick(id: string): void {
    if (id !== this.value()) this.changed.emit(id);
  }

  /** Arrow keys pick the previous/next option (wrapping) and move focus with it. */
  protected step(event: Event, delta: -1 | 1): void {
    const options = this.options();
    if (this.disabled() || options.length === 0) return;
    event.preventDefault();
    const at = options.findIndex((o) => o.id === this.value());
    const index = at < 0 ? (delta > 0 ? 0 : options.length - 1) : at + delta;
    const next = (index + options.length) % options.length;
    this.pick(options[next]!.id);
    const group = (event.target as HTMLElement | null)?.parentElement;
    group?.querySelectorAll<HTMLElement>('.segment')[next]?.focus();
  }
}
