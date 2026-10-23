import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { Icon } from '@tangent/web-shared';
import { ReplySettings } from '../state/reply-settings';
import { UiStore } from '../state/ui-store';

/**
 * Above the composer while an advanced setting isn't the default ("Max ·
 * Very long"), so a learner who changed one sees it each time they write,
 * and nothing while every one is. Muted, with why, while the open pool pays
 * and they don't apply. Opens Advanced settings; it never resets anything
 * itself. Not a live region: it is there to be seen, not announced.
 */
@Component({
  selector: 'app-advanced-chip',
  imports: [Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (replies.indicator(); as chip) {
      <button
        type="button"
        class="advanced-chip"
        [class.is-off]="chip.off"
        [attr.aria-label]="chip.ariaLabel"
        title="Advanced settings"
        (click)="open()"
      >
        <app-icon name="gear" [size]="14" />
        <span>{{ chip.label }}</span>
        @if (chip.note; as note) {
          <span class="advanced-chip-note">· {{ note }}</span>
        }
      </button>
    }
  `,
})
export class AdvancedChip {
  protected readonly replies = inject(ReplySettings);
  private readonly ui = inject(UiStore);

  protected open(): void {
    this.ui.dialogs.open({ kind: 'advanced-settings' });
  }
}
