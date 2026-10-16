import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { Icon } from './icon';

/**
 * What a message asks about before it is sent: the words "Ask about this"
 * quoted (`quote`), or else a whole message (`excerpt`, its opening words).
 * The tangent is made only when the message is sent, so dropping this (its
 * x) leaves nothing behind. Mousedown on the x is cancelled, so the focus
 * stays in the box it sits in. The parent marks it `composerLead` to put it
 * in a composer.
 */
@Component({
  selector: 'app-composer-quote',
  imports: [Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <span class="composer-pill composer-quote">
      <app-icon name="tangent" [size]="14" />
      <span class="composer-quote-text" [attr.title]="shown()">{{ shown() }}</span>
      <button
        type="button"
        class="icon-btn"
        [attr.aria-label]="dropLabel()"
        [title]="quote() ? 'Don’t ask about these words' : 'Don’t go on this tangent'"
        (mousedown)="$event.preventDefault()"
        (click)="dropped.emit()"
      >
        <app-icon name="x" [size]="13" />
      </button>
    </span>
  `,
  host: { class: 'composer-lead' },
})
export class ComposerQuote {
  /** The selected words asked about; null for a whole message. */
  readonly quote = input<string | null>(null);
  /** The opening words of the whole message, when there is no quote. */
  readonly excerpt = input('');
  readonly dropped = output();

  protected readonly shown = computed(() => {
    const q = this.quote();
    return q ? `“${q}”` : `Tangent from “${this.excerpt()}”`;
  });
  protected readonly dropLabel = computed(() => {
    const q = this.quote();
    return q ? `Don’t ask about “${q}”` : 'Don’t go on this tangent';
  });
}
