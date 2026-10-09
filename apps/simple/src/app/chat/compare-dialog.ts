import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  effect,
  inject,
  input,
  type OnInit,
  signal,
} from '@angular/core';
import { compareUsageNote, splitTangents, tierModel } from '@tangent/shared';
import {
  Compare,
  MarkdownService,
  Modal,
  type ApiError,
  type CompareCandidate,
  type CompareCandidateState,
  type CompareRun,
} from '@tangent/web-shared';
import { COMPARE_BLOCKING_STATUSES, LessonStore } from '../state/lesson-store';
import { UiStore } from '../state/ui-store';

/**
 * "Compare answers": the question in the composer, answered by Normal and Max
 * (`UiStore.compare`). Side by side on wide screens, one tab at a time on
 * narrow ones; "Use this answer" keeps that one (`LessonStore.commitCompare`)
 * and only it joins the lesson. Closing (or Escape) stops both and keeps
 * nothing; the question stays in the composer until a pick is kept.
 */
@Component({
  selector: 'app-compare-dialog',
  imports: [Modal, Compare],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (run(); as r) {
      <app-modal heading="Compare answers" [wide]="true" class="compare-sheet" (closed)="close()">
        <app-compare
          [candidates]="view()"
          [question]="content()"
          [note]="note()"
          [busy]="r.committing()"
          (picked)="pick(r, $event)"
        />
        <p class="compare-foot muted small">
          Closing discards both answers; your question stays in the box.
        </p>
      </app-modal>
    }
  `,
})
export class CompareDialog implements OnInit {
  private readonly store = inject(LessonStore);
  private readonly ui = inject(UiStore);
  private readonly md = inject(MarkdownService);

  /** The branch the answers continue. */
  readonly branchId = input.required<string>();
  /** The question, as typed. */
  readonly content = input.required<string>();

  protected readonly run = signal<CompareRun | null>(null);
  /** Rendered answers by candidate id, re-rendered only when their text or state changes. */
  private readonly rendered = new Map<string, { content: string; done: boolean; html: string }>();

  protected readonly view = computed<CompareCandidate[]>(
    () =>
      this.run()
        ?.candidates()
        .map((c) => this.toView(c)) ?? [],
  );

  /** What comparing uses (both models answer), from Max's usage factor. */
  protected readonly note = computed(() =>
    compareUsageNote(tierModel(this.store.models(), 'max')?.usageFactor),
  );

  constructor() {
    inject(DestroyRef).onDestroy(() => {
      this.run()?.abort();
      this.store.comparing.set(false);
    });

    // Refused like a send (no credit, no key, the pool…), or every answer refused:
    // close and report it the way a send's refusal is.
    effect(() => {
      const list = this.run()?.candidates() ?? [];
      const refusals = list.map((c) => c.refusal).filter((r): r is ApiError => r !== null);
      // Reported by `LessonStore.fail` (billing page, key dialog, …) once the sheet is closed.
      const blocking = refusals.find((r) => COMPARE_BLOCKING_STATUSES.has(r.status));
      const allRefused = list.length > 0 && refusals.length === list.length;
      const refusal = blocking ?? (allRefused ? refusals[0] : undefined);
      if (!refusal) return;
      this.close();
      this.store.compareRefused(refusal);
    });

    // The branch went away under the sheet (another lesson opened, side question deleted).
    effect(() => {
      const idx = this.store.index();
      if (this.run() && !idx?.branches.has(this.branchId())) this.close();
    });
  }

  ngOnInit(): void {
    const run = this.store.newCompare(this.branchId(), this.content());
    if (!run) {
      queueMicrotask(() => this.close());
      return;
    }
    this.run.set(run);
    this.store.comparing.set(true);
    void run.start();
  }

  protected async pick(run: CompareRun, id: string): Promise<void> {
    // Kept, out of date or refused, the sheet has done its job (the store says why). A
    // transient failure keeps it open: both answers are still held, so the pick can be retried.
    if ((await this.store.commitCompare(run, id)) !== 'failed') this.close();
  }

  protected close(): void {
    this.ui.dialogs.close('compare');
  }

  /** Rendered as a lesson reply is (message-item.ts): Markdown, without the tangents block. */
  private toView(c: CompareCandidateState): CompareCandidate {
    const done = c.state === 'done';
    let cached = this.rendered.get(c.id);
    if (!cached || cached.content !== c.content || cached.done !== done) {
      cached = {
        content: c.content,
        done,
        html: this.md.render(splitTangents(c.content).body, done),
      };
      this.rendered.set(c.id, cached);
    }
    return {
      id: c.id,
      label: c.label,
      ...(c.sublabel !== undefined ? { sublabel: c.sublabel } : {}),
      state: c.state,
      html: cached.html,
      status: c.status,
      error: c.error,
    };
  }
}
