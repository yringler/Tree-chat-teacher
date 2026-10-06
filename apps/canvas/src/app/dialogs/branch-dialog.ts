import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  type OnInit,
  signal,
} from '@angular/core';
import { plainText } from '@tangent/core';
import {
  CONTEXT_MODES,
  parseRouteKey,
  providerRouteKey,
  routeKey,
  type ContextMode,
} from '@tangent/shared';
import { Icon, Modal } from '@tangent/web-shared';
import { MODE_LABEL } from '../canvas/lane';
import { ModelField } from './model-field';
import { CanvasStore, type BranchVariant } from '../state/canvas-store';
import { UiStore, type BranchDialogState } from '../state/ui-store';

interface VariantRow extends BranchVariant {
  key: number;
}

const MAX_VARIANTS = 6;

/**
 * "Branch from here", the canvas way: one new lane, or several *variants*
 * off the same message at once, each with its own context mode and model.
 * With a first message, every variant is asked in parallel and the lanes
 * stream side by side.
 */
@Component({
  selector: 'app-branch-dialog',
  imports: [Modal, Icon, ModelField],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <app-modal heading="Branch from here" [wide]="true" (closed)="close()">
      <form class="form" (submit)="$event.preventDefault(); create()">
        @if (source(); as n) {
          <div class="excerpt">
            <span class="field-label">{{ n.role === 'user' ? 'Your message' : 'Assistant' }}</span>
            <p>{{ excerpt() }}</p>
          </div>
        }

        <label class="field">
          <span class="field-label"
            >Anchor quote <span class="muted">(optional; focuses the new lanes)</span></span
          >
          <textarea
            rows="2"
            [value]="quote()"
            (input)="quote.set(q.value)"
            #q
            placeholder="Select text in a message before branching to quote it"
          ></textarea>
        </label>

        <fieldset class="variants">
          <legend class="field-label">
            Lanes to open
            <span class="muted">(each gets its own context and model)</span>
          </legend>
          @for (v of variants(); track v.key; let i = $index) {
            <div class="variant-row">
              <label class="field">
                <span class="sr-only">Context of lane {{ i + 1 }}</span>
                <select #ms [value]="v.contextMode" (change)="setMode(v.key, ms.value)">
                  @for (m of modes; track m) {
                    <option [value]="m" [selected]="m === v.contextMode">{{ modeLabel[m] }}</option>
                  }
                </select>
              </label>
              <label class="field">
                <span class="sr-only">Provider of lane {{ i + 1 }}</span>
                <select #ps [value]="routeOf(v)" (change)="setProvider(v.key, ps.value)">
                  @for (p of store.providers(); track providerKey(p)) {
                    <option
                      [value]="providerKey(p)"
                      [disabled]="!p.available"
                      [selected]="providerKey(p) === routeOf(v)"
                    >
                      {{ p.label
                      }}{{ p.available ? '' : p.acceptsUserKey ? ' — no key' : ' — unavailable' }}
                    </option>
                  }
                </select>
              </label>
              <app-model-field
                [provider]="store.providerMap().get(routeOf(v)) ?? null"
                [label]="'Model of lane ' + (i + 1)"
                [compact]="true"
                [model]="v.model"
                (modelChange)="setModel(v.key, $event)"
              />
              <button
                type="button"
                class="icon-btn"
                aria-label="Remove this lane"
                [disabled]="variants().length === 1"
                (click)="remove(v.key)"
              >
                <app-icon name="x" [size]="14" />
              </button>
            </div>
          }
          <div class="variant-actions">
            <button
              type="button"
              class="btn btn-ghost btn-sm"
              [disabled]="variants().length >= max"
              (click)="add()"
            >
              <app-icon name="plus" [size]="14" /> Add a variant
            </button>
            <button
              type="button"
              class="btn btn-ghost btn-sm"
              title="One lane per context mode: see how much context changes the answer"
              [disabled]="variants().length + 2 > max"
              (click)="addEveryMode()"
            >
              Every context mode
            </button>
          </div>
        </fieldset>

        <label class="field">
          <span class="field-label"
            >Ask all of them
            <span class="muted">(optional; sent to every new lane at once)</span></span
          >
          <textarea
            rows="2"
            [value]="firstMessage()"
            (input)="firstMessage.set(fm.value)"
            #fm
            placeholder="Leave empty to open the lanes and write in each yourself"
          ></textarea>
        </label>

        <div class="field-row">
          <label class="field">
            <span class="field-label"
              >Title <span class="muted">(optional; generated after the first reply)</span></span
            >
            <input type="text" maxlength="200" [value]="title()" (input)="title.set(t.value)" #t />
          </label>
          <label class="check">
            <input type="checkbox" [checked]="isPrivate()" (change)="isPrivate.set(!isPrivate())" />
            Private (left out of shares and exports)
          </label>
        </div>

        <div class="form-actions">
          <button type="button" class="btn btn-ghost" (click)="close()">Cancel</button>
          <button type="submit" class="btn btn-primary" [disabled]="saving()">
            @if (saving()) {
              Opening…
            } @else if (variants().length === 1) {
              {{ firstMessage().trim() ? 'Open the lane and ask' : 'Open the lane' }}
            } @else {
              {{
                firstMessage().trim()
                  ? 'Ask in ' + variants().length + ' lanes'
                  : 'Open ' + variants().length + ' lanes'
              }}
            }
          </button>
        </div>
      </form>
    </app-modal>
  `,
})
export class BranchDialog implements OnInit {
  protected readonly store = inject(CanvasStore);
  private readonly ui = inject(UiStore);
  readonly state = input.required<BranchDialogState>();
  protected readonly modes = CONTEXT_MODES;
  protected readonly modeLabel = MODE_LABEL;
  protected readonly max = MAX_VARIANTS;
  private seq = 0;

  protected readonly source = computed(
    () => this.store.index()?.nodes.get(this.state().fromNodeId) ?? null,
  );
  protected readonly excerpt = computed(() => {
    const text = plainText(this.source()?.content ?? '');
    return text.length > 240 ? `${text.slice(0, 240)}…` : text;
  });
  private readonly parent = computed(() => {
    const n = this.source();
    return (n && this.store.index()?.branches.get(n.branchId)) || null;
  });

  protected readonly quote = signal('');
  protected readonly title = signal('');
  protected readonly firstMessage = signal('');
  protected readonly isPrivate = signal(false);
  protected readonly saving = signal(false);
  protected readonly variants = signal<VariantRow[]>([]);

  ngOnInit(): void {
    this.quote.set(this.state().quote ?? '');
    this.variants.set([this.fresh('path')]);
  }

  private fresh(contextMode: ContextMode): VariantRow {
    const p = this.parent();
    const fallback = this.store.defaultProvider();
    return {
      key: ++this.seq,
      contextMode,
      providerId: p?.providerId ?? fallback?.id ?? '',
      funding: p?.funding ?? fallback?.funding ?? 'own-key',
      model: p?.model ?? fallback?.defaultModel ?? '',
    };
  }

  protected add(): void {
    const last = this.variants().at(-1);
    this.variants.update((list) => [...list, { ...(last ?? this.fresh('path')), key: ++this.seq }]);
  }

  /** Adds the two modes not yet present (keeping the rows that are). */
  protected addEveryMode(): void {
    const have = new Set(this.variants().map((v) => v.contextMode));
    const missing = CONTEXT_MODES.filter((m) => !have.has(m));
    this.variants.update((list) => [...list, ...missing.map((m) => this.fresh(m))]);
  }

  protected remove(key: number): void {
    this.variants.update((list) => (list.length > 1 ? list.filter((v) => v.key !== key) : list));
  }

  protected setMode(key: number, value: string): void {
    const mode = CONTEXT_MODES.find((m) => m === value);
    if (mode) this.patch(key, { contextMode: mode });
  }

  protected readonly providerKey = providerRouteKey;
  protected readonly routeOf = routeKey;

  /** `route` is a `routeKey`: the provider and who pays for it. */
  protected setProvider(key: number, route: string): void {
    const p = this.store.providerMap().get(route);
    this.patch(key, { ...parseRouteKey(route), model: p?.defaultModel ?? '' });
  }

  protected setModel(key: number, model: string): void {
    this.patch(key, { model });
  }

  private patch(key: number, patch: Partial<BranchVariant>): void {
    this.variants.update((list) => list.map((v) => (v.key === key ? { ...v, ...patch } : v)));
  }

  protected close(): void {
    this.ui.branchDialog.set(null);
  }

  protected async create(): Promise<void> {
    if (this.saving()) return;
    this.saving.set(true);
    try {
      const created = await this.store.fanOut({
        fromNodeId: this.state().fromNodeId,
        anchorQuote: this.quote().trim() || null,
        title: this.title(),
        isPrivate: this.isPrivate(),
        variants: this.variants().map(({ contextMode, providerId, funding, model }) => ({
          contextMode,
          providerId,
          funding,
          model: model.trim(),
        })),
        firstMessage: this.firstMessage(),
      });
      if (created.length > 0) this.close();
    } finally {
      this.saving.set(false);
    }
  }
}
