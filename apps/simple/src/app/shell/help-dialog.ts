import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { HELP_TITLE } from '@tangent/shared';
import { Modal, TangentHelp, Walkthrough } from '@tangent/web-shared';
import { UiStore } from '../state/ui-store';

/**
 * "How tangents work", opened from the header's ? button. It can replay the
 * walkthrough, which needs the lesson in view (the coach marks point at its
 * controls), so the help closes first; "Keyboard shortcuts" takes its place.
 */
@Component({
  selector: 'app-help-dialog',
  imports: [Modal, TangentHelp],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <app-modal [heading]="title" (closed)="ui.dialogs.close('help')">
      <app-tangent-help [showReplay]="true" (replay)="replay()" (shortcuts)="shortcuts()" />
    </app-modal>
  `,
})
export class HelpDialog {
  protected readonly ui = inject(UiStore);
  private readonly walkthrough = inject(Walkthrough);
  protected readonly title = HELP_TITLE;

  protected replay(): void {
    this.ui.dialogs.close('help');
    this.walkthrough.replay();
  }

  protected shortcuts(): void {
    this.ui.dialogs.close('help');
    this.ui.dialogs.open({ kind: 'shortcuts' });
  }
}
