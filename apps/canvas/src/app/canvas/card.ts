import {
  ChangeDetectionStrategy,
  Component,
  computed,
  ElementRef,
  inject,
  input,
  signal,
} from '@angular/core';
import { splitTangents, type ChatNode } from '@tangent/shared';
import {
  Icon,
  MarkdownService,
  RelatedLinks,
  relatedLinks,
  TangentAsk,
  TypesetMath,
  type LinkNoteEdit,
} from '@tangent/web-shared';
import { LayoutStore, type Point } from '../layout/layout-store';
import { CanvasStore, modelLabel } from '../state/canvas-store';
import { UiStore } from '../state/ui-store';
import { laneTitle } from './titles';

/** A press on the link port becomes a drag once it moves this far; until then it is a click. */
const DRAG_SLOP = 5;

/** What pick mode offers on this card: link here, or why not. */
type PickState = 'open' | 'source' | 'linked';

const PICK_LABEL: Record<PickState, string> = {
  open: 'Link here',
  source: 'Linking from here',
  linked: 'Already linked',
};

/** How the lineage view reads one message, for the selected lane. */
export type Lit = 'verbatim' | 'summarized' | 'dropped' | 'outside' | 'off';

/**
 * One message on a lane; `data-node-id` lets the page map a text selection
 * (and a dropped link) to it. Its links to other messages show as compact
 * chips (edit note, remove); the port on its right edge makes a new one: drag it onto another
 * card, or click it to pick one (pick mode puts "Link here" on every card).
 */
@Component({
  selector: 'app-card',
  imports: [Icon, RelatedLinks, TangentAsk, TypesetMath],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @let n = node();
    <article
      class="card card-{{ n.role }} lit-{{ lit() }}"
      [class.is-focused]="focused()"
      [class.is-error]="n.status === 'error'"
      [class.is-streaming]="streaming()"
      [class.is-link-target]="ui.linkDrag()?.overNodeId === n.id"
      [attr.id]="'card-' + n.id"
      [attr.data-node-id]="n.id"
    >
      <header class="card-head">
        <span class="card-role" [attr.title]="n.model">{{ role() }}</span>
        @switch (lit()) {
          @case ('summarized') {
            <span class="badge mode-summary" title="Reaches the model only through a summary">
              in summary
            </span>
          }
          @case ('dropped') {
            <span class="badge badge-danger" title="Dropped: it did not fit the token budget">
              dropped
            </span>
          }
          @case ('outside') {
            <span class="badge" title="Not sent to the model for the selected lane">
              not sent
            </span>
          }
        }
        <span class="spacer"></span>
        @if (n.status === 'complete') {
          <button
            type="button"
            class="icon-btn card-branch"
            title="Branch from here (one lane, or several variants at once)"
            aria-label="Branch from this message"
            (click)="branch($event)"
          >
            <app-icon name="branch" [size]="15" />
          </button>
        }
      </header>

      @if (streaming() && liveStatus()) {
        <p class="card-status muted small">{{ liveStatus() }}</p>
      }
      <div class="card-body md" [innerHTML]="html()" [appTypesetMath]="html()"></div>
      @if (streaming()) {
        <span class="cursor" aria-hidden="true"></span>
        <span class="sr-only">Writing…</span>
      }
      @if (n.status === 'error') {
        <div class="card-error" role="alert">
          <strong>{{ n.error === 'cancelled' ? 'Stopped.' : 'The reply failed.' }}</strong>
          @if (n.error && n.error !== 'cancelled') {
            <span>{{ n.error }}</span>
          }
        </div>
      }

      @if (complete()) {
        <nav class="tangents" aria-label="Tangents worth following">
          <span class="tangents-label muted small">Where next?</span>
          @for (t of tangents(); track t.title) {
            <button
              type="button"
              class="tangent"
              [class.is-followed]="followed().has(t.title)"
              [disabled]="opening() !== null"
              [title]="followed().has(t.title) ? 'Open this lane' : (t.why ?? t.title)"
              (click)="follow(t.title, $event)"
            >
              <app-icon [name]="followed().has(t.title) ? 'chevronRight' : 'branch'" [size]="14" />
              <span class="tangent-title">{{ t.title }}</span>
              @if (t.why) {
                <span class="tangent-why muted">{{ t.why }}</span>
              }
            </button>
          }
          <!-- The user's own question, in a new lane like a tangent. -->
          <app-tangent-ask
            [(text)]="askText"
            label="Ask your own question in a new lane"
            settingsLabel="Lane settings: context, model, variants…"
            [expandable]="true"
            [busy]="asking()"
            [latest]="latest()"
            [disabled]="locked()"
            disabledTitle="Asking needs a membership (this lane is on your own key)"
            (ask)="ask($event)"
            (settings)="askWithSettings($event)"
          />
        </nav>
      }

      @if (children().length > 0) {
        <nav class="card-forks" aria-label="Lanes branching from this message">
          @for (b of children(); track b.id) {
            <button
              type="button"
              class="chip mode-chip-{{ b.contextMode }}"
              [class.is-on]="store.chainIds().has(b.id)"
              [title]="b.anchorQuote ?? laneTitle(b)"
              (click)="open(b.id, $event)"
            >
              {{ laneTitle(b) }}
            </button>
          }
        </nav>
      }

      <!--
        Editable here too, so a link can be changed from either end while the
        Links toggle hides the lines (and their popovers). Pressing a chip
        doesn't select its lane first: the way back is the view it was in.
      -->
      <app-related-links
        [entries]="related()"
        [collapsible]="false"
        [compact]="true"
        [canEdit]="true"
        (pointerdown)="$event.stopPropagation()"
        (open)="openLinked($event)"
        (remove)="removeLink($event)"
        (editNote)="editNote($event)"
      />

      @if (n.status === 'complete') {
        <button
          type="button"
          class="card-port"
          [class.is-active]="ui.linkDrag()?.fromNodeId === n.id"
          title="Link to another message: drag onto its card, or click and pick one (R)"
          aria-label="Link this message to another"
          (pointerdown)="portDown($event)"
          (pointermove)="portMove($event)"
          (pointerup)="portUp($event)"
          (pointercancel)="portCancel()"
          (click)="portClick($event)"
        >
          <app-icon name="link" [size]="11" />
        </button>
      }

      @if (pick(); as p) {
        <button
          type="button"
          class="card-pick"
          [class.is-open]="p === 'open'"
          [disabled]="p !== 'open'"
          (pointerdown)="$event.stopPropagation()"
          (click)="linkHere($event)"
        >
          <app-icon name="link" [size]="14" /> {{ pickLabel[p] }}
        </button>
      }
    </article>
  `,
  host: { class: 'card-host' },
})
export class Card {
  protected readonly store = inject(CanvasStore);
  protected readonly ui = inject(UiStore);
  private readonly geo = inject(LayoutStore);
  private readonly md = inject(MarkdownService);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  protected readonly laneTitle = laneTitle;
  protected readonly pickLabel = PICK_LABEL;

  readonly node = input.required<ChatNode>();
  readonly focused = input(false);
  readonly lit = input<Lit>('off');

  /** "You", or the model that wrote the reply (its label when the provider is known). */
  protected readonly role = computed(() => {
    const n = this.node();
    if (n.role === 'user') return 'You';
    if (!n.model) return 'Assistant';
    return modelLabel(this.store.providers(), { providerId: n.providerId ?? '' }, n.model);
  });
  private readonly live = computed(() => this.store.live().get(this.node().id) ?? null);
  protected readonly streaming = computed(() => this.node().status === 'streaming');
  protected readonly liveStatus = computed(() => {
    const l = this.live();
    if (!l) return null;
    return l.reconnecting ? 'Reconnecting…' : l.status;
  });
  protected readonly content = computed(() => this.live()?.content ?? this.node().content);
  private readonly split = computed(() =>
    this.node().role === 'assistant'
      ? splitTangents(this.content())
      : { body: this.content(), tangents: [], partial: false },
  );
  protected readonly html = computed(() => this.md.render(this.split().body, !this.streaming()));
  /** A finished reply: offers its tangents and "Ask your own". */
  protected readonly complete = computed(
    () => this.node().role === 'assistant' && this.node().status === 'complete',
  );
  protected readonly tangents = computed(() => (this.complete() ? this.split().tangents : []));
  /** The card's lane can't generate (its funding needs the membership the user lacks). */
  protected readonly locked = computed(() => {
    const b = this.store.index()?.branches.get(this.node().branchId);
    return !!b && this.store.routeLocked(b);
  });
  protected readonly children = computed(() => this.store.childBranchesAt(this.node().id));
  protected readonly followed = computed<ReadonlySet<string>>(
    () => new Set(this.children().map((b) => b.title)),
  );
  protected readonly opening = signal<string | null>(null);

  /** This message's links, resolved to their other ends (the chips). */
  protected readonly related = computed(() => {
    const idx = this.store.index();
    return idx ? relatedLinks(idx, this.store.linksByNode(), this.node().id, laneTitle) : [];
  });

  /** In pick mode: whether this card can be the other end. */
  protected readonly pick = computed<PickState | null>(() => {
    const p = this.ui.linkPick();
    if (!p) return null;
    const id = this.node().id;
    if (p.fromNodeId === id) return 'source';
    const linked = (this.store.linksByNode().get(id) ?? []).some(
      (l) => l.sourceNodeId === p.fromNodeId || l.targetNodeId === p.fromNodeId,
    );
    return linked ? 'linked' : 'open';
  });

  /** A press on the port, until it is let go: a click, or a drag once it moves past the slop. */
  private press: { pointerId: number; x: number; y: number; moved: boolean } | null = null;
  /** The press was a drag: the click that may follow it isn't one. */
  private dragged = false;
  /**
   * The selected lane's last card, a finished reply: its "Ask your own"
   * starts open (TangentAsk `latest`). Only the selected lane's, so the canvas
   * never shows a field open in every lane.
   */
  protected readonly latest = computed(() => {
    const n = this.node();
    if (!this.complete() || n.branchId !== this.store.selectedBranchId()) return false;
    return this.store.index()?.nodesByBranch.get(n.branchId)?.at(-1)?.id === n.id;
  });

  /** "Ask your own": the question being typed under the reply. */
  protected readonly askText = signal('');
  protected readonly asking = signal(false);

  protected async ask(text: string): Promise<void> {
    if (this.asking() || this.locked()) return;
    this.asking.set(true);
    try {
      // Kept on failure, to try again.
      if (await this.store.askFrom(this.node().id, text)) this.askText.set('');
    } finally {
      this.asking.set(false);
    }
  }

  /** The gear: the branch dialog (variants and all), asking the question once the lanes exist. */
  protected askWithSettings(text: string): void {
    this.ui.branchDialog.set({
      fromNodeId: this.node().id,
      quote: null,
      ...(text ? { message: text, onCreated: () => this.askText.set('') } : {}),
    });
  }

  protected branch(e: Event): void {
    e.stopPropagation();
    this.ui.branchDialog.set({ fromNodeId: this.node().id, quote: null });
  }

  protected open(branchId: string, e: Event): void {
    e.stopPropagation();
    this.store.go(branchId);
  }

  protected openLinked(nodeId: string): void {
    this.store.openNode(nodeId, this.node().id);
  }

  protected removeLink(linkId: string): void {
    const title = this.related().find((r) => r.link.id === linkId)?.title ?? 'that message';
    if (!confirm(`Remove the link to “${title}”? It goes from both messages.`)) return;
    void this.store.deleteLink(linkId);
  }

  protected editNote(edit: LinkNoteEdit): void {
    void this.store.updateLinkNote(edit.linkId, edit.note);
  }

  protected linkHere(e: Event): void {
    e.stopPropagation();
    const p = this.ui.linkPick();
    if (!p || this.pick() !== 'open') return;
    this.ui.linkPick.set(null);
    void this.store.createLink(p.fromNodeId, this.node().id);
  }

  // ---- The link port: drag onto another card, or click to pick one

  protected portDown(e: PointerEvent): void {
    // Not a pan, not a lane selection, not a text selection.
    e.stopPropagation();
    e.preventDefault();
    this.dragged = false;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    this.press = { pointerId: e.pointerId, x: e.clientX, y: e.clientY, moved: false };
  }

  protected portMove(e: PointerEvent): void {
    const press = this.press;
    if (!press || press.pointerId !== e.pointerId) return;
    const to = this.toWorld(e.clientX, e.clientY);
    if (!press.moved) {
      if (Math.hypot(e.clientX - press.x, e.clientY - press.y) <= DRAG_SLOP) return;
      press.moved = true;
      const port = (e.currentTarget as HTMLElement).getBoundingClientRect();
      this.ui.linkPopover.set(null);
      this.ui.linkPick.set(null);
      this.ui.linkDrag.set({
        fromNodeId: this.node().id,
        from: this.toWorld(port.left + port.width / 2, port.top + port.height / 2),
        to,
        overNodeId: null,
      });
      return;
    }
    const drag = this.ui.linkDrag();
    // Escape dropped it: the rest of the gesture does nothing.
    if (!drag || drag.fromNodeId !== this.node().id) return;
    const over = cardAt(e.clientX, e.clientY);
    this.ui.linkDrag.set({ ...drag, to, overNodeId: over === this.node().id ? null : over });
  }

  protected portUp(e: PointerEvent): void {
    const press = this.press;
    this.press = null;
    if (!press || press.pointerId !== e.pointerId || !press.moved) return;
    this.dragged = true;
    const drag = this.ui.linkDrag();
    this.ui.linkDrag.set(null);
    const from = this.node().id;
    if (!drag || drag.fromNodeId !== from) return;
    const to = cardAt(e.clientX, e.clientY);
    if (to && to !== from) void this.store.createLink(from, to);
  }

  protected portCancel(): void {
    if (this.press?.moved && this.ui.linkDrag()?.fromNodeId === this.node().id) {
      this.ui.linkDrag.set(null);
    }
    this.press = null;
  }

  protected portClick(e: Event): void {
    e.stopPropagation();
    if (this.dragged) {
      this.dragged = false;
      return;
    }
    this.ui.startLinkPick(this.node().id);
  }

  /** A point on screen in world coordinates (the viewport is the canvas's origin). */
  private toWorld(clientX: number, clientY: number): Point {
    const rect = this.host.nativeElement.closest('.viewport')?.getBoundingClientRect();
    return this.geo.toWorld({ x: clientX - (rect?.left ?? 0), y: clientY - (rect?.top ?? 0) });
  }

  protected async follow(title: string, e: Event): Promise<void> {
    e.stopPropagation();
    if (this.opening() !== null) return;
    this.opening.set(title);
    try {
      await this.store.followTangent(this.node().id, title);
    } finally {
      this.opening.set(null);
    }
  }
}

/** The message whose card is at a point on screen, if any. */
function cardAt(clientX: number, clientY: number): string | null {
  const el = document.elementFromPoint(clientX, clientY);
  return el?.closest<HTMLElement>('.card[data-node-id]')?.dataset['nodeId'] ?? null;
}
