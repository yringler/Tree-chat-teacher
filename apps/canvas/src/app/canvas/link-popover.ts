import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  ElementRef,
  inject,
  Injector,
  input,
  linkedSignal,
  type OnDestroy,
  signal,
} from '@angular/core';
import { describeEndpoint } from '@tangent/core/links';
import { MAX_LINK_NOTE_CHARS } from '@tangent/shared';
import { endpointCrumbs, endpointTitle, Icon } from '@tangent/web-shared';
import type { CrossLinkEnd } from '../layout/cross-links';
import { LayoutStore } from '../layout/layout-store';
import { CanvasStore } from '../state/canvas-store';
import { UiStore } from '../state/ui-store';
import { laneTitle } from './titles';

/** Width of the popover (CSS `.xlink-popover`), to keep it inside the viewport. */
const WIDTH = 300;
const MARGIN = 8;
/** Gap between the glyph and the popover. */
const OFFSET = 16;

interface PopoverEnd {
  nodeId: string;
  /** The other end: where "Back to ‘…’" returns after going to this one. */
  otherId: string;
  title: string;
  crumbs: string;
  folded: boolean;
}

/**
 * A link's popover, opened from its glyph: both ends (where they live, what
 * they say) with "Go to", the note (edited in place) and Remove. Drawn in
 * the viewport's coordinates over the canvas, next to the glyph, so it reads
 * the same at any zoom. Escape (UiStore.closeTop) or a click elsewhere closes it.
 */
@Component({
  selector: 'app-link-popover',
  imports: [Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (geometry(); as x) {
      <section
        class="xlink-popover"
        role="dialog"
        aria-label="Linked messages"
        [class.is-above]="place().above"
        [style.left.px]="place().left"
        [style.top.px]="place().top"
        [attr.data-link-id]="x.id"
      >
        <header class="xlink-pop-head">
          <app-icon name="link" [size]="14" />
          <span class="xlink-pop-heading">Linked messages</span>
          <span class="spacer"></span>
          <button type="button" class="icon-btn" aria-label="Close" (click)="close()">
            <app-icon name="x" [size]="14" />
          </button>
        </header>
        <ul class="xlink-ends">
          @for (e of ends(); track e.nodeId) {
            <li class="xlink-end">
              <span class="xlink-end-text">
                @if (e.crumbs) {
                  <span class="xlink-crumbs">{{ e.crumbs }}</span>
                }
                <span class="xlink-title">{{ e.title }}</span>
                @if (e.folded) {
                  <span class="muted small">In a folded lane</span>
                }
              </span>
              <button
                type="button"
                class="btn btn-sm xlink-go"
                [attr.aria-label]="'Go to ' + e.title"
                (click)="goTo(e)"
              >
                Go to
              </button>
            </li>
          }
        </ul>
        @if (editing()) {
          <form class="xlink-note-form" (submit)="$event.preventDefault(); save()">
            <textarea
              rows="3"
              [maxLength]="maxNote"
              [value]="draft()"
              placeholder="Why do they relate?"
              aria-label="Note on this link"
              (input)="draft.set(note.value)"
              (keydown)="noteKey($event)"
              #note
            ></textarea>
            <div class="xlink-pop-actions">
              <button type="button" class="btn btn-sm" (click)="cancelEdit()">Cancel</button>
              <button type="submit" class="btn btn-sm btn-primary">Save note</button>
            </div>
          </form>
        } @else {
          @if (x.link.note) {
            <p class="xlink-note">{{ x.link.note }}</p>
          } @else {
            <p class="xlink-note muted">No note.</p>
          }
          <div class="xlink-pop-actions">
            <button type="button" class="btn btn-sm btn-ghost" (click)="startEdit()">
              <app-icon name="edit" [size]="13" /> {{ x.link.note ? 'Edit note' : 'Add a note' }}
            </button>
            <button type="button" class="btn btn-sm btn-ghost xlink-remove" (click)="remove()">
              <app-icon name="trash" [size]="13" /> Remove
            </button>
          </div>
        }
      </section>
    }
  `,
  host: {
    class: 'xlink-popover-host',
    '(pointerdown)': '$event.stopPropagation()',
    '(dblclick)': '$event.stopPropagation()',
    '(wheel)': '$event.stopPropagation()',
    '(document:pointerdown)': 'outside($event)',
  },
})
export class LinkPopover implements OnDestroy {
  private readonly store = inject(CanvasStore);
  private readonly ui = inject(UiStore);
  private readonly geo = inject(LayoutStore);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly injector = inject(Injector);

  readonly linkId = input.required<string>();

  protected readonly maxNote = MAX_LINK_NOTE_CHARS;
  /** The note is being edited (not carried over when the popover moves to another link). */
  protected readonly editing = linkedSignal(() => {
    this.linkId();
    return false;
  });
  protected readonly draft = signal('');

  /** The link as drawn; null once it is gone or no longer drawn (Links off). */
  protected readonly geometry = computed(
    () => this.geo.crossLinks().find((x) => x.id === this.linkId()) ?? null,
  );

  protected readonly ends = computed<PopoverEnd[]>(() => {
    const x = this.geometry();
    const idx = this.store.index();
    if (!x || !idx) return [];
    const [a, b] = x.ends;
    const pairs: [CrossLinkEnd, CrossLinkEnd][] = [
      [a, b],
      [b, a],
    ];
    return pairs.flatMap(([e, other]) => {
      const ep = describeEndpoint(idx, e.nodeId, laneTitle);
      if (!ep) return [];
      return [
        {
          nodeId: e.nodeId,
          otherId: other.nodeId,
          title: endpointTitle(ep),
          crumbs: endpointCrumbs(ep),
          folded: e.folded,
        },
      ];
    });
  });

  /** Under the glyph, or above it in the lower part of the viewport; always inside it. */
  protected readonly place = computed(() => {
    const x = this.geometry();
    const v = this.geo.viewport();
    if (!x) return { left: 0, top: 0, above: false };
    const at = this.geo.toScreen(x.mid);
    const above = at.y > v.height * 0.6;
    const maxLeft = Math.max(MARGIN, v.width - WIDTH - MARGIN);
    return {
      left: Math.min(maxLeft, Math.max(MARGIN, at.x - WIDTH / 2)),
      top: above ? at.y - OFFSET : at.y + OFFSET,
      above,
    };
  });

  constructor() {
    this.focus('.xlink-go');
  }

  ngOnDestroy(): void {
    // Focus goes back to the glyph, unless something else has already taken it.
    const active = document.activeElement;
    const lost = !active || active === document.body || this.host.nativeElement.contains(active);
    if (!lost) return;
    const glyphs = document.querySelectorAll<HTMLElement>('.xlink-glyph');
    [...glyphs].find((g) => g.dataset['linkId'] === this.linkId())?.focus();
  }

  protected close(): void {
    this.ui.linkPopover.set(null);
  }

  /** A pointer down anywhere but here (or on a glyph, which toggles) closes it. */
  protected outside(e: Event): void {
    const target = e.target instanceof Element ? e.target : null;
    if (target?.closest('.xlink-glyph')) return;
    this.close();
  }

  protected goTo(e: PopoverEnd): void {
    this.store.openNode(e.nodeId, e.otherId);
  }

  protected startEdit(): void {
    this.draft.set(this.geometry()?.link.note ?? '');
    this.editing.set(true);
    this.focus('textarea');
  }

  protected cancelEdit(): void {
    this.editing.set(false);
    this.focus('.xlink-go');
  }

  protected async save(): Promise<void> {
    const link = this.geometry()?.link;
    const note = this.draft().trim() || null;
    this.cancelEdit();
    if (link && note !== link.note) await this.store.updateLinkNote(link.id, note);
  }

  /** Enter saves (Shift+Enter: new line); Escape cancels the edit, and only the edit. */
  protected noteKey(e: KeyboardEvent): void {
    if (e.isComposing) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      this.cancelEdit();
    } else if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void this.save();
    }
  }

  protected remove(): void {
    if (!confirm('Remove the link between these two messages?')) return;
    void this.store.deleteLink(this.linkId());
  }

  private focus(selector: string): void {
    afterNextRender(() => this.host.nativeElement.querySelector<HTMLElement>(selector)?.focus(), {
      injector: this.injector,
    });
  }
}
