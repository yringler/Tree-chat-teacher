import {
  ChangeDetectionStrategy,
  Component,
  effect,
  inject,
  type OnInit,
  signal,
} from '@angular/core';
import { customInstructions, type Tree } from '@tangent/shared';
import { ApiClient, Modal } from '@tangent/web-shared';
import { LessonStore } from '../state/lesson-store';
import { UiStore } from '../state/ui-store';

/**
 * "Your instructions" for the open lesson: the lesson's own prompt, which
 * the server adds after the tutor's own where the learner pays with their own
 * key or credit, and ignores on the open pool. The lesson's stored prompt
 * starts as the tutor prompt, so the box shows only what the learner wrote
 * (`customInstructions`); clearing it puts the tutor prompt back, which
 * power then keeps sending. Opened from the lesson's header
 * (`UiStore.dialogs`, kind `instructions`); closes when the lesson does.
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
            [disabled]="tutorPrompt() === undefined"
            [value]="text()"
            (input)="text.set(box.value)"
            #box
          ></textarea>
        </label>
        <p class="muted small">Used while replies are paid with your own key or credit.</p>
        <div class="form-actions">
          <button type="button" class="btn btn-ghost" (click)="close()">Cancel</button>
          <button
            type="submit"
            class="btn btn-primary"
            [disabled]="saving() || tutorPrompt() === undefined"
          >
            {{ saving() ? 'Saving…' : 'Save' }}
          </button>
        </div>
      </form>
    </app-modal>
  `,
})
export class InstructionsDialog implements OnInit {
  private readonly store = inject(LessonStore);
  private readonly ui = inject(UiStore);
  private readonly api = inject(ApiClient);

  /** The lesson the box was opened for, as it was then. */
  private readonly opened: Tree | null = this.store.detail()?.tree ?? null;
  /** The prompt a new lesson gets (from the account's settings); undefined until read. */
  protected readonly tutorPrompt = signal<string | null | undefined>(undefined);
  protected readonly text = signal('');
  protected readonly saving = signal(false);

  constructor() {
    // Another lesson opened (or none): these instructions were for the one that went away.
    effect(() => {
      const id = this.store.detail()?.tree.id;
      if (id !== this.opened?.id) this.close();
    });
  }

  ngOnInit(): void {
    void this.load();
  }

  /** Reads the tutor prompt, then fills the box with what the learner wrote. */
  private async load(): Promise<void> {
    if (!this.opened) return;
    try {
      const tutor = (await this.api.settings()).defaultSystemPrompt || null;
      this.text.set(customInstructions(this.opened.systemPrompt, tutor) ?? '');
      this.tutorPrompt.set(tutor);
    } catch (err) {
      this.store.fail(err);
      this.close();
    }
  }

  protected close(): void {
    this.ui.dialogs.close('instructions');
  }

  protected async save(): Promise<void> {
    const tree = this.opened;
    const tutor = this.tutorPrompt();
    if (!tree || tutor === undefined) return;
    const systemPrompt = this.text().trim() ? this.text() : tutor;
    if (systemPrompt === tree.systemPrompt) {
      this.close();
      return;
    }
    this.saving.set(true);
    const ok = await this.store.updateTree(tree.id, { systemPrompt });
    this.saving.set(false);
    if (ok) this.close();
  }
}
