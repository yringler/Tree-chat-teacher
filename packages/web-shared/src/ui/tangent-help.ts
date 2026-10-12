import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import {
  HELP_ANALOGY,
  HELP_DEFAULT,
  HELP_ITEMS,
  HELP_REPLAY,
  HELP_RULE,
  HELP_SHORTCUTS,
  HELP_TEST,
  MAIN_THREAD_LABEL,
  TANGENT_ACTION,
} from '@tangent/shared';

/**
 * "How tangents work": when to reply and when to go on a tangent, short
 * enough to read at a glance. Each app hosts it in its own Modal (titled
 * `HELP_TITLE`); the words come from @tangent/shared, which the landing page
 * and the Flutter app use too. The two actions wear the look of the
 * composer's buttons, so the help names what the learner sees.
 */
@Component({
  selector: 'app-tangent-help',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="tangent-help">
      <p class="tangent-help-rule">{{ rule }}</p>
      <svg
        class="tangent-help-diagram"
        viewBox="0 0 280 78"
        role="img"
        aria-label="A main thread running on, with two tangents hanging off it"
      >
        <path class="tangent-help-main" d="M12 18H268" />
        <path class="tangent-help-side" d="M70 18V50a8 8 0 0 0 8 8H128" />
        <path class="tangent-help-side" d="M174 18V50a8 8 0 0 0 8 8H232" />
        <circle class="tangent-help-dot" cx="12" cy="18" r="4" />
        <circle class="tangent-help-dot" cx="70" cy="18" r="4" />
        <circle class="tangent-help-dot" cx="174" cy="18" r="4" />
        <circle class="tangent-help-dot" cx="268" cy="18" r="4" />
        <circle class="tangent-help-dot is-side" cx="128" cy="58" r="4" />
        <circle class="tangent-help-dot is-side" cx="232" cy="58" r="4" />
        <text x="222" y="10" text-anchor="end">{{ mainThread }}</text>
        <text x="82" y="74">Tangent</text>
        <text x="186" y="74">Tangent</text>
      </svg>
      <dl class="tangent-help-items">
        @for (item of items; track item.label) {
          <div class="tangent-help-item">
            <dt>
              <span class="tangent-help-chip" [class.is-primary]="item.label === tangentLabel">{{
                item.label
              }}</span>
            </dt>
            <dd>{{ item.text }}</dd>
          </div>
        }
        <div class="tangent-help-item">
          <dt>
            <strong>{{ fallback.label }}</strong>
          </dt>
          <dd>{{ fallback.text }}</dd>
        </div>
      </dl>
      <p class="muted">{{ test }}</p>
      <p class="muted">{{ analogy }}</p>
      <div class="tangent-help-foot">
        @if (showReplay()) {
          <button type="button" class="btn" (click)="replay.emit()">{{ replayLabel }}</button>
        }
        <button type="button" class="btn btn-ghost" (click)="shortcuts.emit()">
          {{ shortcutsLabel }}
        </button>
      </div>
    </div>
  `,
})
export class TangentHelp {
  /** Offer "Replay the walkthrough" (the apps that have one). */
  readonly showReplay = input(false);
  readonly replay = output();
  readonly shortcuts = output();

  protected readonly rule = HELP_RULE;
  protected readonly items = HELP_ITEMS;
  protected readonly fallback = HELP_DEFAULT;
  protected readonly test = HELP_TEST;
  protected readonly analogy = HELP_ANALOGY;
  protected readonly replayLabel = HELP_REPLAY;
  protected readonly shortcutsLabel = HELP_SHORTCUTS;
  protected readonly tangentLabel = TANGENT_ACTION.label;
  protected readonly mainThread = MAIN_THREAD_LABEL;
}
