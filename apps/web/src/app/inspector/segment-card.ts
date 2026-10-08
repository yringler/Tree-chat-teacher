import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';
import type { ContextSegment, InclusionReason } from '@tangent/shared';

const REASONS: Record<InclusionReason, string> = {
  'tree-system-prompt': 'system prompt',
  'system-node': 'system message',
  'path-ancestor': 'inherited (path)',
  'branch-point-message': 'parent message',
  'branch-message': 'this branch',
  'branch-summary': 'branch summary',
  'budget-compaction': 'compaction',
  'anchor-quote': 'anchor quote',
};

/** One context segment: kind, reason, explanation, sources, tokens, collapsible text. */
@Component({
  selector: 'app-segment-card',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @let s = segment();
    <div class="seg seg-{{ s.kind }}">
      <div class="seg-head">
        <span class="badge seg-kind">{{ s.kind }}{{ role() ? ' · ' + role() : '' }}</span>
        <span class="small">{{ reason() }}</span>
        @if (s.kind === 'summary') {
          <span class="badge status-{{ s.status }}">{{ s.status }}</span>
        }
        <span class="seg-tokens small muted">~{{ s.tokens.toLocaleString() }} tok</span>
      </div>
      <p class="small">{{ s.explanation }}</p>
      @if (s.sourceNodeIds.length > 0) {
        <p class="seg-sources small">
          <span class="muted">Sources:</span>
          @for (id of shownSources(); track id) {
            <button
              type="button"
              class="link-btn seg-source"
              (click)="focusNode.emit(id)"
              [attr.title]="'Go to this message'"
            >
              {{ labels().get(id) ?? id.slice(-6) }}
            </button>
          }
          @if (s.sourceNodeIds.length > shownSources().length) {
            <button type="button" class="link-btn" (click)="allSources.set(true)">
              +{{ s.sourceNodeIds.length - shownSources().length }} more
            </button>
          }
        </p>
      }
      @if (text() !== null) {
        <button
          type="button"
          class="link-btn small"
          [attr.aria-expanded]="open()"
          (click)="open.set(!open())"
        >
          {{ open() ? 'Hide text' : 'Show text' }}
        </button>
        @if (open()) {
          <pre class="seg-text">{{ text() }}</pre>
        }
      } @else {
        <p class="muted small">
          {{
            s.kind === 'summary' && s.status === 'failed'
              ? 'Summary generation failed.'
              : 'Summary not generated yet.'
          }}
        </p>
      }
    </div>
  `,
})
export class SegmentCard {
  readonly segment = input.required<ContextSegment>();
  /** Display names of the source messages by node id (the inspector numbers the path). */
  readonly labels = input<ReadonlyMap<string, string>>(new Map());
  readonly focusNode = output<string>();
  protected readonly open = signal(false);
  protected readonly allSources = signal(false);

  protected readonly reason = computed(() => REASONS[this.segment().reason]);
  protected readonly text = computed<string | null>(() => this.segment().text);
  protected readonly role = computed(() => {
    const s = this.segment();
    return s.kind === 'ancestor' || s.kind === 'branch' ? s.role : null;
  });
  protected readonly shownSources = computed(() => {
    const ids = this.segment().sourceNodeIds;
    return this.allSources() ? ids : ids.slice(0, 8);
  });
}
