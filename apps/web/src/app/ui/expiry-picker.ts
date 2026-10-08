import { ChangeDetectionStrategy, Component, model, type OnInit, signal } from '@angular/core';

type Choice = 'none' | '1' | '7' | '30' | 'custom';

const DAY = 24 * 60 * 60 * 1000;

function localDateInput(d: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Expiry select (none / 1 / 7 / 30 days / custom date) producing an ISO timestamp or null. */
@Component({
  selector: 'app-expiry-picker',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="field-row">
      <label class="field">
        <span class="field-label">Expires</span>
        <select #c [value]="choice()" (change)="pick(asChoice(c.value))">
          <option value="none">Never</option>
          <option value="1">In 1 day</option>
          <option value="7">In 7 days</option>
          <option value="30">In 30 days</option>
          <option value="custom">On a date…</option>
        </select>
      </label>
      @if (choice() === 'custom') {
        <label class="field">
          <span class="field-label">Date</span>
          <input #d type="date" [min]="today" [value]="date()" (input)="pickDate(d.value)" />
        </label>
      }
    </div>
  `,
})
export class ExpiryPicker implements OnInit {
  /** ISO timestamp or null (never). */
  readonly expiresAt = model<string | null>(null);
  protected readonly choice = signal<Choice>('none');
  protected readonly today = localDateInput(new Date());
  protected readonly date = signal(localDateInput(new Date(Date.now() + 7 * DAY)));

  /** The expiry the choice and date stand for. */
  private value(): string | null {
    const c = this.choice();
    if (c === 'none') return null;
    if (c === 'custom') {
      const d = this.date();
      if (!d) return null;
      // End of the chosen local day.
      const end = new Date(`${d}T23:59:59`);
      return Number.isNaN(end.getTime()) ? null : end.toISOString();
    }
    return new Date(Date.now() + Number(c) * DAY).toISOString();
  }

  /**
   * Only the user's changes set the expiry: an existing one shown as its
   * date is kept to the second until then (end of that day could revive a
   * share that expired earlier today).
   */
  protected pick(choice: Choice): void {
    this.choice.set(choice);
    this.expiresAt.set(this.value());
  }

  protected pickDate(date: string): void {
    this.date.set(date);
    this.expiresAt.set(this.value());
  }

  /** Pre-select "custom" when editing an existing expiry. */
  ngOnInit(): void {
    const existing = this.expiresAt();
    if (existing) {
      this.choice.set('custom');
      this.date.set(localDateInput(new Date(existing)));
    }
  }

  protected asChoice(v: string): Choice {
    return v === '1' || v === '7' || v === '30' || v === 'custom' ? v : 'none';
  }
}
