import { ChangeDetectionStrategy, Component, inject, type OnInit, signal } from '@angular/core';
import { ReviewStore } from '../state/review-store';
import { SettingsStore } from '../state/settings-store';
import { TreeStore } from '../state/tree-store';
import { UiStore } from '../state/ui-store';
import { Modal } from '@tangent/web-shared';
import { ModelPicker } from '../ui/model-picker';

/** App-wide preferences, one section per feature. Saved in this browser. */
@Component({
  selector: 'app-settings-dialog',
  imports: [Modal, ModelPicker],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <app-modal heading="Settings" (closed)="close()">
      <form class="form" (submit)="$event.preventDefault(); save()">
        <fieldset class="settings-section">
          <legend>Reviewer</legend>
          <p class="muted small">
            “Review” on an assistant message sends the conversation up to that message to this
            model. It points out mistakes and says whether to continue on a stronger model. Pick a
            more capable model than the one you chat with. You can still choose another model for
            each review.
          </p>
          @if (custom()) {
            <app-model-picker [(providerId)]="providerId" [(modelId)]="modelId" />
            <button type="button" class="btn btn-ghost btn-sm" (click)="custom.set(false)">
              Use the branch's provider default instead
            </button>
          } @else {
            <p class="small">Now: the default model of the branch's own provider.</p>
            <button type="button" class="btn btn-ghost btn-sm" (click)="customize()">
              Choose a model
            </button>
          }
        </fieldset>

        <div class="form-actions">
          <button type="button" class="btn btn-ghost" (click)="close()">Cancel</button>
          <button type="submit" class="btn btn-primary">Save</button>
        </div>
      </form>
    </app-modal>
  `,
})
export class SettingsDialog implements OnInit {
  private readonly settings = inject(SettingsStore);
  private readonly reviews = inject(ReviewStore);
  private readonly store = inject(TreeStore);
  private readonly ui = inject(UiStore);

  protected readonly custom = signal(false);
  protected readonly providerId = signal('');
  protected readonly modelId = signal('');

  ngOnInit(): void {
    const saved = this.settings.settings().reviewer;
    this.custom.set(saved !== null);
    if (saved) {
      this.providerId.set(saved.providerId);
      this.modelId.set(saved.model);
    }
  }

  protected customize(): void {
    if (!this.providerId()) {
      const start = this.reviews.defaultReviewer(this.store.selectedBranch()?.providerId ?? null);
      this.providerId.set(start?.providerId ?? this.store.defaultProvider()?.id ?? '');
      this.modelId.set(start?.model ?? this.store.defaultProvider()?.defaultModel ?? '');
    }
    this.custom.set(true);
  }

  protected close(): void {
    this.ui.settingsOpen.set(false);
  }

  protected save(): void {
    const reviewer =
      this.custom() && this.providerId() && this.modelId()
        ? { providerId: this.providerId(), model: this.modelId() }
        : null;
    this.settings.update({ reviewer });
    this.ui.notify('Settings saved');
    this.close();
  }
}
