import { ChangeDetectionStrategy, Component, effect, inject, signal } from '@angular/core';
import type { Tree } from '@tangent/shared';
import { Modal } from '@tangent/web-shared';
import { LessonStore } from '../state/lesson-store';
import { UiStore } from '../state/ui-store';

/**
 * "Your instructions" for the open lesson: its learner instructions, which
 * the server adds after the tutor prompt where the learner pays with their
 * own key or credit, and ignores on the open pool. A blank box saves none.
 * Opened from the lesson's header (`UiStore.dialogs`, kind `instructions`);
 * closes when the lesson does.
 */
@Component({
  selector: 'app-instructions-dialog',
  imports: [Modal],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <app-modal heading="Your instructions" (closed)="close()">
      <form class="form" (submit)="$event.preventDefault(); save()">
        <label class="field">
          <span class="field-label"
            >For this lesson <span class="muted">(added to the tutor’s own)</span></span
          >
          <textarea
            rows="6"
            maxlength="20000"
            placeholder="E.g. Answer in French. I already know calculus."
            [value]="text()"
            (input)="text.set(box.value)"
            #box
          ></textarea>
        </label>
        <p class="muted small">Used while replies are paid with your own key or credit.</p>
        <div class="form-actions">
          <button type="button" class="btn btn-ghost" (click)="close()">Cancel</button>
          <button type="submit" class="btn btn-primary" [disabled]="saving()">
            {{ saving() ? 'Saving…' : 'Save' }}
          </button>
        </div>
      </form>
    </app-modal>
  `,
})
export class InstructionsDialog {
  private readonly store = inject(LessonStore);
  private readonly ui = inject(UiStore);

  /** The lesson the box was opened for, as it was then. */
  private readonly opened: Tree | null = this.store.detail()?.tree ?? null;
  protected readonly text = signal(this.opened?.learnerInstructions ?? '');
  protected readonly saving = signal(false);

  constructor() {
    // Another lesson opened (or none): these instructions were for the one that went away.
    effect(() => {
      const id = this.store.detail()?.tree.id;
      if (id !== this.opened?.id) this.close();
    });
  }

  protected close(): void {
    this.ui.dialogs.close('instructions');
  }

  protected async save(): Promise<void> {
    const tree = this.opened;
    if (!tree) return;
    const learnerInstructions = this.text().trim() ? this.text() : null;
    if (learnerInstructions === tree.learnerInstructions) {
      this.close();
      return;
    }
    this.saving.set(true);
    const ok = await this.store.updateTree(tree.id, { learnerInstructions });
    this.saving.set(false);
    if (ok) this.close();
  }
}
