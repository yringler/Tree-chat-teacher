import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import {
  DEFAULT_LEARN_REPLY,
  effectiveLearnTier,
  LEARN_REPLY_FIXED_MODEL_NOTE,
  LEARN_REPLY_LONG_WARNING,
  LEARN_REPLY_MAX_REQUIRED_NOTE,
  LEARN_REPLY_WARNING_MARK,
  LEARN_REPLY_LENGTHS,
  LEARN_TIER_HINTS,
  LENGTH_REQUIRES_MAX,
  REPLY_LENGTH_FOOTNOTE,
  REPLY_LENGTH_HINTS,
  REPLY_LENGTH_LABELS,
  TIER_LABELS,
  TIERS,
  warnsLongOnNormal,
} from '@tangent/shared';
import { Modal } from '@tangent/web-shared';
import { ReplySettings } from '../state/reply-settings';
import { UiStore } from '../state/ui-store';

/**
 * Advanced settings: the model replies run on (Normal or Max) and how long
 * they may run, saved with the account as each is picked. Opened from the
 * account menu and from the composer's chip (`AdvancedChip`). While the open
 * pool pays, neither applies, so both are shown disabled with why; on the
 * learner's own Anthropic key the model is fixed, so its choice is too. The
 * model shows the tier replies run on (`effectiveLearnTier`): while Very
 * long is picked it is Max, locked, saying a shorter length unlocks it; the
 * saved tier comes back with that length.
 */
@Component({
  selector: 'app-advanced-settings-dialog',
  imports: [Modal],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <app-modal heading="Advanced settings" (closed)="close()">
      @if (pool()) {
        <p class="notice">These aren't used while the open pool pays for your replies.</p>
      }
      <fieldset class="access-choice">
        <legend class="field-label">Model</legend>
        @if (fixedModel()) {
          <p class="muted small">{{ fixedModelNote }}</p>
        } @else if (maxRequired()) {
          <p class="muted small">{{ maxRequiredNote }}</p>
        }
        @for (t of tiers; track t) {
          <label class="access-option">
            <input
              type="radio"
              name="learn-tier"
              [value]="t"
              [checked]="tier() === t"
              [disabled]="pool() || fixedModel() || maxRequired()"
              (change)="replies.save({ tier: t })"
            />
            <span>
              <strong>{{ tierLabels[t] }}</strong>
              <span class="muted small">{{ tierHints[t] }}</span>
            </span>
          </label>
        }
      </fieldset>
      <fieldset class="access-choice">
        <legend class="field-label">Reply length</legend>
        @for (l of lengths; track l) {
          <label class="access-option">
            <input
              type="radio"
              name="learn-length"
              [value]="l"
              [checked]="replies.settings().replyLength === l"
              [disabled]="pool()"
              (change)="replies.save({ replyLength: l })"
            />
            <span>
              <strong>{{ lengthLabels[l] }}</strong>
              <span class="muted small">{{ lengthHints[l] }}</span>
            </span>
          </label>
        }
        @if (warnLong()) {
          <p class="reply-warning small">
            <span aria-hidden="true">{{ warningMark }}</span> {{ longWarning }}
          </p>
        }
        <p class="muted small">{{ footnote }}</p>
      </fieldset>
      <div class="form-actions">
        <button
          type="button"
          class="btn btn-ghost"
          [disabled]="pool() || !replies.changed()"
          (click)="replies.save(defaults)"
        >
          Back to defaults
        </button>
        <button type="button" class="btn btn-primary" (click)="close()">Done</button>
      </div>
    </app-modal>
  `,
})
export class AdvancedSettingsDialog {
  protected readonly replies = inject(ReplySettings);
  private readonly ui = inject(UiStore);
  protected readonly tiers = TIERS;
  protected readonly tierLabels = TIER_LABELS;
  protected readonly tierHints = LEARN_TIER_HINTS;
  protected readonly lengths = LEARN_REPLY_LENGTHS;
  protected readonly lengthLabels = REPLY_LENGTH_LABELS;
  protected readonly lengthHints = REPLY_LENGTH_HINTS;
  protected readonly footnote = REPLY_LENGTH_FOOTNOTE;
  protected readonly fixedModelNote = LEARN_REPLY_FIXED_MODEL_NOTE;
  protected readonly maxRequiredNote = LEARN_REPLY_MAX_REQUIRED_NOTE;
  protected readonly warningMark = LEARN_REPLY_WARNING_MARK;
  protected readonly longWarning = LEARN_REPLY_LONG_WARNING;
  protected readonly defaults = DEFAULT_LEARN_REPLY;

  protected readonly pool = computed(() => this.replies.context().pool);
  protected readonly fixedModel = computed(() => this.replies.context().fixedModel);
  /** The tier replies run on, which a length requiring Max overrides. */
  protected readonly tier = computed(() => effectiveLearnTier(this.replies.settings()));
  /** The length picked runs only on Max, so the model choice is locked there. */
  protected readonly maxRequired = computed(
    () => LENGTH_REQUIRES_MAX[this.replies.settings().replyLength],
  );
  protected readonly warnLong = computed(() =>
    warnsLongOnNormal(this.replies.settings(), this.replies.context()),
  );

  protected close(): void {
    this.ui.dialogs.close('advanced-settings');
  }
}
