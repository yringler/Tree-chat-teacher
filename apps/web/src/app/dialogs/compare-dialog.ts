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
  untracked,
} from '@angular/core';
import { compareUsageNote, splitTangents, TIER_LABELS, TIERS } from '@tangent/shared';
import {
  ApiClient,
  ApiError,
  Compare,
  CompareRun,
  MarkdownService,
  Modal,
  ToastStore,
  type CompareCandidate,
  type CompareCandidateState,
  type CompareSpec,
} from '@tangent/web-shared';
import { generationLimits, SettingsStore } from '../state/settings-store';
import { TierStore } from '../state/tier-store';
import { TreeStore } from '../state/tree-store';
import { UiStore } from '../state/ui-store';

/** The commit refusals that mean the comparison no longer fits the branch (moved on, expired, gone). */
const OUT_OF_DATE = new Set([404, 409, 410]);

/**
 * Compare: Normal and Max (TierStore) answer the message as candidate
 * replies at the branch's leaf, side by side (tabs on a phone), and the
 * user keeps one: only that exchange enters the tree, on its model, while
 * the branch stays on its own route. Both answers are paid for. The message
 * stays in the composer until the pick is committed, so closing loses
 * nothing typed.
 */
@Component({
  selector: 'app-compare-dialog',
  imports: [Modal, Compare],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <app-modal heading="Compare answers" [wide]="true" class="compare-sheet" (closed)="close()">
      @if (run(); as r) {
        <app-compare
          [candidates]="candidates()"
          [question]="r.question"
          [note]="note()"
          [busy]="r.committing()"
          (picked)="pick($event)"
        />
        <p class="muted small compare-foot">
          Closing discards both answers; your message stays in the box.
        </p>
      } @else {
        <p class="notice">
          Normal and Max aren't both available for this branch. Choose them in Settings.
        </p>
      }
    </app-modal>
  `,
})
export class CompareDialog implements OnInit {
  private readonly api = inject(ApiClient);
  private readonly store = inject(TreeStore);
  private readonly tiers = inject(TierStore);
  private readonly settings = inject(SettingsStore);
  private readonly ui = inject(UiStore);
  private readonly toast = inject(ToastStore);
  private readonly md = inject(MarkdownService);

  readonly branchId = input.required<string>();
  /** The message, as the composer holds it. */
  readonly content = input.required<string>();

  protected readonly run = signal<CompareRun | null>(null);
  private specs: readonly CompareSpec[] = [];
  /** Both answers run on the user's own keys (no Tangent credit). */
  private readonly ownKeys = signal(false);
  private readonly factor = signal<number | undefined>(undefined);

  /** Rendered answers by candidate id, re-rendered only when their text or state changes. */
  private readonly rendered = new Map<string, { content: string; ended: boolean; html: string }>();

  protected readonly candidates = computed<CompareCandidate[]>(
    () =>
      this.run()
        ?.candidates()
        .map((c) => this.toView(c)) ?? [],
  );

  protected readonly note = computed(
    () => compareUsageNote(this.factor()) + (this.ownKeys() ? ' Both run on your own keys.' : ''),
  );

  constructor() {
    inject(DestroyRef).onDestroy(() => this.run()?.abort());
    // Every answer refused (no key, no credit, …): close and say why, as a send would.
    effect(() => {
      const list = this.run()?.candidates() ?? [];
      if (list.length === 0 || list.some((c) => c.state !== 'error')) return;
      const refusal = list.find((c) => c.refusal)?.refusal;
      if (refusal) untracked(() => this.refused(refusal));
    });
  }

  ngOnInit(): void {
    const branch = this.store.index()?.branches.get(this.branchId()) ?? null;
    if (!branch || !this.tiers.available(branch)) return;
    const specs: CompareSpec[] = [];
    const limits = generationLimits(this.settings.settings());
    for (const tier of TIERS) {
      const choice = this.tiers.choice(tier, branch);
      if (!choice) return;
      specs.push({
        id: tier,
        label: TIER_LABELS[tier],
        sublabel: this.tiers.modelLabel(choice),
        request: {
          content: this.content(),
          providerId: choice.providerId,
          funding: choice.funding ?? 'own-key',
          model: choice.model,
          // The reply length and input limit, as a send carries them.
          ...limits,
        },
      });
    }
    this.ownKeys.set(specs.every((s) => s.request.funding !== 'credit'));
    this.factor.set(this.tiers.usageFactor(branch));
    this.specs = specs;
    const run = new CompareRun(this.api, branch.id, this.content(), specs);
    this.run.set(run);
    void run.start();
  }

  /** Keeps answer `id`: it and the question join the branch, and the composer lets the text go. */
  protected async pick(id: string): Promise<void> {
    const run = this.run();
    if (!run) return;
    try {
      const result = await run.commit(id);
      this.store.applyCommitted(result);
      this.ui.markSent(run.question);
      this.close();
    } catch (err) {
      if (err instanceof ApiError && OUT_OF_DATE.has(err.status)) {
        this.toast.notify('That comparison is out of date. Your message is still in the box.');
        this.close();
        return;
      }
      // A network failure, say: the answer is still held, so the pick can be tried again.
      this.store.fail(err);
    }
  }

  private refused(err: ApiError): void {
    this.close();
    if (err.code === 'key_required' && !this.ui.dialogs.get('keys')) {
      // Ask for the key of the answer that needed it.
      const id = this.run()
        ?.candidates()
        .find((c) => c.refusal === err)?.id;
      const spec = this.specs.find((s) => s.id === id);
      this.ui.dialogs.open({ kind: 'keys', provider: spec?.request.providerId ?? null });
    }
    this.store.fail(err);
  }

  protected close(): void {
    this.ui.dialogs.close('compare');
  }

  /** Rendered as a reply is (message-item.ts): Markdown, without the `<tangents>` block. */
  private toView(c: CompareCandidateState): CompareCandidate {
    const ended = c.state === 'done' || c.state === 'error';
    let cached = this.rendered.get(c.id);
    if (!cached || cached.content !== c.content || cached.ended !== ended) {
      cached = {
        content: c.content,
        ended,
        html: this.md.render(splitTangents(c.content).body, ended),
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
