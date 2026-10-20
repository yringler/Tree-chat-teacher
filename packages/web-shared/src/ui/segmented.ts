import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';

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
      return (at - 1 + count) % count;
    case 'ArrowRight':
    case 'ArrowDown':
      return (at + 1) % count;
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
 * base.css), with one tab stop: a roving tabindex on the option the focus
 * is on, else the current one, else the first.
 * - `kind: 'toggle'`, for a setting (e.g. Normal | Max): a toolbar of toggle
 *   buttons, the current one pressed. The arrow keys, Home and End only move
 *   the focus, and Enter, Space or a click picks, as ARIA's toolbar pattern
 *   has it: a pick can move a thread onto a model that costs more, or change
 *   who pays, so passing over an option must not pick it.
 * - `kind: 'tab'`: a tablist over panels whose ids are
 *   `${controls}-${option.id}`. The arrow keys pick as they move, as ARIA's
 *   tabs pattern allows where showing a panel costs nothing.
 */
@Component({
  selector: 'app-segmented',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div
      class="segmented"
      [attr.role]="kind() === 'tab' ? 'tablist' : 'toolbar'"
      [attr.aria-label]="label()"
      [attr.aria-describedby]="description() ? descriptionId : null"
      (focusout)="focusOut($event)"
    >
      @for (o of options(); track o.id; let i = $index) {
        <button
          type="button"
          class="segment"
          [class.is-on]="o.id === value()"
          [attr.role]="kind() === 'tab' ? 'tab' : null"
          [attr.aria-pressed]="kind() === 'toggle' ? o.id === value() : null"
          [attr.aria-selected]="kind() === 'tab' ? o.id === value() : null"
          [attr.aria-controls]="kind() === 'tab' && controls() ? controls() + '-' + o.id : null"
          [attr.id]="kind() === 'tab' && controls() ? controls() + '-tab-' + o.id : null"
          [attr.tabindex]="i === tabStop() ? 0 : -1"
          [disabled]="disabled()"
          [title]="o.hint ?? o.label"
          (focus)="focused.set(i)"
          (click)="pick(o.id)"
          (keydown)="onKey($event, i)"
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
  readonly kind = input<'toggle' | 'tab'>('toggle');
  /** Tab kind: the panel id prefix (`${controls}-${option.id}`). */
  readonly controls = input<string | null>(null);
  /** The option picked; only when it differs from `value`. */
  readonly changed = output<string>();

  protected readonly descriptionId = `segmented-description-${++uid}`;
  private readonly current = computed(() => this.options().findIndex((o) => o.id === this.value()));
  /** The option the focus is on, while it is in the group. */
  protected readonly focused = signal<number | null>(null);
  /** The one option Tab reaches: the focused one, else the current one, else the first. */
  protected readonly tabStop = computed(() => this.focused() ?? Math.max(0, this.current()));

  protected pick(id: string): void {
    if (id !== this.value()) this.changed.emit(id);
  }

  protected onKey(event: KeyboardEvent, at: number): void {
    const options = this.options();
    if (this.disabled() || options.length === 0) return;
    const next = segmentStep(event.key, at, options.length);
    if (next === null) return;
    event.preventDefault();
    if (this.kind() === 'tab') this.pick(options[next]!.id);
    const group = (event.target as HTMLElement | null)?.parentElement;
    group?.querySelectorAll<HTMLElement>('.segment')[next]?.focus();
  }

  /** The focus left the group: Tab comes back to the current option. */
  protected focusOut(event: FocusEvent): void {
    const group = event.currentTarget;
    const to = event.relatedTarget;
    if (!(group instanceof Node && to instanceof Node && group.contains(to)))
      this.focused.set(null);
  }
}
