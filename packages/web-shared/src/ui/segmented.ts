import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';

/** One choice of a Segmented control. `hint` is its tooltip. */
export interface SegmentedOption {
  id: string;
  label: string;
  hint?: string;
}

/** The option index a key moves to from `at` among `count` (wrapping), or null for another key. */
export function segmentStep(key: string, at: number, count: number): number | null {
  switch (key) {
    case 'ArrowLeft':
    case 'ArrowUp':
      return at < 0 ? count - 1 : (at - 1 + count) % count;
    case 'ArrowRight':
    case 'ArrowDown':
      return at < 0 ? 0 : (at + 1) % count;
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
    default:
      return null;
  }
}

let uid = 0;

/**
 * A pill of mutually exclusive buttons (`.segmented` / `.segment` in
 * base.css). `kind: 'radio'` is a radiogroup for a setting (e.g. Normal |
 * Max); `kind: 'tab'` is a tablist over panels whose ids are
 * `${controls}-${option.id}`. One tab stop (a roving tabindex: the current
 * option, else the first); the arrow keys, Home and End pick and focus
 * another option, as ARIA's radiogroup and tablist patterns ask.
 */
@Component({
  selector: 'app-segmented',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div
      class="segmented"
      [attr.role]="kind() === 'tab' ? 'tablist' : 'radiogroup'"
      [attr.aria-label]="label()"
      [attr.aria-describedby]="description() ? descriptionId : null"
    >
      @for (o of options(); track o.id; let i = $index) {
        <button
          type="button"
          class="segment"
          [class.is-on]="o.id === value()"
          [attr.role]="kind()"
          [attr.aria-checked]="kind() === 'radio' ? o.id === value() : null"
          [attr.aria-selected]="kind() === 'tab' ? o.id === value() : null"
          [attr.aria-controls]="kind() === 'tab' && controls() ? controls() + '-' + o.id : null"
          [attr.id]="kind() === 'tab' && controls() ? controls() + '-tab-' + o.id : null"
          [attr.tabindex]="i === tabStop() ? 0 : -1"
          [disabled]="disabled()"
          [title]="o.hint ?? o.label"
          (click)="pick(o.id)"
          (keydown)="onKey($event)"
        >
          {{ o.label }}
        </button>
      }
    </div>
    @if (description(); as d) {
      <span class="sr-only" [id]="descriptionId">{{ d }}</span>
    }
  `,
})
export class Segmented {
  readonly options = input.required<readonly SegmentedOption[]>();
  readonly value = input<string | null>(null);
  readonly disabled = input(false);
  /** The group's accessible name. */
  readonly label = input.required<string>();
  /** Read after the name (e.g. why the control is disabled). */
  readonly description = input<string | null>(null);
  readonly kind = input<'radio' | 'tab'>('radio');
  /** Tab kind: the panel id prefix (`${controls}-${option.id}`). */
  readonly controls = input<string | null>(null);
  /** The option picked; only when it differs from `value`. */
  readonly changed = output<string>();

  protected readonly descriptionId = `segmented-description-${++uid}`;
  private readonly current = computed(() => this.options().findIndex((o) => o.id === this.value()));
  /** The one option Tab reaches: the current one, else the first. */
  protected readonly tabStop = computed(() => Math.max(0, this.current()));

  protected pick(id: string): void {
    if (id !== this.value()) this.changed.emit(id);
  }

  protected onKey(event: KeyboardEvent): void {
    const options = this.options();
    if (this.disabled() || options.length === 0) return;
    const next = segmentStep(event.key, this.current(), options.length);
    if (next === null) return;
    event.preventDefault();
    this.pick(options[next]!.id);
    const group = (event.target as HTMLElement | null)?.parentElement;
    group?.querySelectorAll<HTMLElement>('.segment')[next]?.focus();
  }
}
