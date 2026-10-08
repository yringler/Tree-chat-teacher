import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';
import { TypesetMath } from './math';
import { Segmented, type SegmentedOption } from './segmented';

/** One answer in a Compare view, as the host renders it. */
export interface CompareCandidate {
  id: string;
  /** e.g. "Normal". */
  label: string;
  /** e.g. the model's name. */
  sublabel?: string;
  state: 'pending' | 'streaming' | 'done' | 'error';
  /** The answer so far, rendered by the host (sanitized by [innerHTML]). */
  html: string;
  /** Latest progress note (e.g. "Searching the web…"). */
  status?: string | null;
  error?: string | null;
}

let uid = 0;

/** Where the answers sit side by side (base.css `.compare*` uses the same width). */
const SIDE_BY_SIDE = '(min-width: 900px)';

function sideBySide(): boolean {
  return typeof matchMedia === 'function' && matchMedia(SIDE_BY_SIDE).matches;
}

/**
 * Two (or more) answers to one question, and a "Use this answer" button for
 * each once it is finished. Below 900px a tab bar shows one answer at a time;
 * wider, the answers sit side by side (base.css `.compare*`). The tab roles
 * (tabpanel, one live region) hold only below 900px: side by side there is
 * no tablist, so each answer is a region labelled by its header, and each is
 * announced. Presentational: the host streams the answers in and commits the
 * one `picked`.
 */
@Component({
  selector: 'app-compare',
  imports: [Segmented, TypesetMath],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (question()) {
      <p class="compare-question" [title]="question()">{{ question() }}</p>
    }
    @if (note()) {
      <p class="compare-note muted small">{{ note() }}</p>
    }
    <div class="compare-tabs">
      <app-segmented
        kind="tab"
        label="Answers"
        [controls]="prefix"
        [options]="tabs()"
        [value]="shown()"
        (changed)="active.set($event)"
      />
    </div>
    <div class="compare-panes">
      @for (c of candidates(); track c.id) {
        <article
          class="compare-pane"
          [attr.role]="wide() ? 'region' : 'tabpanel'"
          [id]="prefix + '-' + c.id"
          [attr.data-active]="c.id === shown()"
          [attr.data-state]="c.state"
          [attr.aria-labelledby]="prefix + '-head-' + c.id"
        >
          <header class="compare-pane-head">
            <h3 [id]="prefix + '-head-' + c.id">{{ c.label }}</h3>
            @if (c.sublabel) {
              <span class="muted small">{{ c.sublabel }}</span>
            }
            @if (c.state === 'error') {
              <span class="compare-error small">{{ c.error || 'Something went wrong' }}</span>
            } @else if (progress(c); as text) {
              <span class="compare-status muted small">{{ text }}</span>
            }
          </header>
          <div
            class="compare-body md"
            [attr.aria-live]="wide() || c.id === shown() ? 'polite' : null"
            [attr.aria-busy]="c.state === 'pending' || c.state === 'streaming'"
            [innerHTML]="c.html"
            [appTypesetMath]="c.html"
          ></div>
          <footer class="compare-pane-foot">
            <button
              type="button"
              class="btn btn-primary"
              [disabled]="c.state !== 'done' || busy()"
              (click)="picked.emit(c.id)"
            >
              {{ pickLabel() }}
            </button>
          </footer>
        </article>
      }
    </div>
  `,
  host: { class: 'compare', '(window:resize)': 'wide.set(sideBySide())' },
})
export class Compare {
  readonly candidates = input.required<readonly CompareCandidate[]>();
  /** The question both answered (shown clamped above the answers). */
  readonly question = input('');
  /** A line under the question (e.g. the usage note). */
  readonly note = input('');
  readonly pickLabel = input('Use this answer');
  /** A pick is being committed: every pick button is disabled. */
  readonly busy = input(false);
  /** The id of the candidate the user kept. */
  readonly picked = output<string>();

  /** The tab shown below 900px; null = the first candidate. */
  protected readonly active = signal<string | null>(null);
  protected readonly prefix = `compare-${++uid}`;
  /** Side by side (at least 900px wide): no tabs, so no tab roles. */
  protected readonly wide = signal(sideBySide());
  protected readonly sideBySide = sideBySide;

  protected readonly shown = computed(() => {
    const list = this.candidates();
    const id = this.active();
    return list.some((c) => c.id === id) ? id : (list[0]?.id ?? null);
  });

  /** Tab labels; a • marks an answer still being written. */
  protected readonly tabs = computed((): SegmentedOption[] =>
    this.candidates().map((c) => ({
      id: c.id,
      label: c.state === 'streaming' || c.state === 'pending' ? `${c.label} •` : c.label,
      ...(c.sublabel ? { hint: c.sublabel } : {}),
    })),
  );

  /** The header's progress text: the latest status, else what the answer is doing. */
  protected progress(c: CompareCandidate): string | null {
    if (c.status) return c.status;
    if (c.state === 'pending') return 'Waiting…';
    if (c.state === 'streaming') return 'Writing…';
    return null;
  }
}
