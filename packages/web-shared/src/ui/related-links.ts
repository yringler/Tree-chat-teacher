import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  ElementRef,
  inject,
  Injector,
  input,
  model,
  output,
  signal,
} from '@angular/core';
import { MAX_LINK_NOTE_CHARS } from '@tangent/shared';
import { Icon } from './icon';
import { relatedLabel, type RelatedLink } from './links-view';

let uid = 0;

/** A note edited on a link chip: trimmed, null when cleared. */
export interface LinkNoteEdit {
  linkId: string;
  note: string | null;
}

/**
 * Under a message: its links to other messages ("2 related"), one chip per
 * link, showing the other end (breadcrumb + snippet, or "Tangent: ‹title›")
 * and the link's note. All three apps.
 *
 * Inputs:
 * - `entries` (required): the message's links resolved to their other ends:
 *   `relatedLinks(index, linksByNode, nodeId, titleOf)` from ./links-view,
 *   with the app's own `titleOf`. Renders nothing while empty.
 * - `canEdit` (false): show "Edit note" and "Remove" on each chip.
 * - `collapsible` (true): a toggle shows the chips (like the power app's
 *   "N branches"); false lists them under a label (Learn's side questions).
 * - `expanded` (false, two-way `[(expanded)]`): the toggle's state.
 * - `compact` (false): title only, no breadcrumb or note (Canvas cards);
 *   both stay in the chip's tooltip.
 * - `label` (`relatedLabel`, "N related"): the toggle/label text for a count,
 *   e.g. `n => 'Connected to ' + n` in Learn.
 * - `noun` ('link'): what a link is called in the chips' button labels
 *   ("Remove the link to …"); Learn says 'connection'.
 *
 * Outputs:
 * - `open`: a chip was clicked; carries the other end's node id (the app
 *   navigates, e.g. `store.openNode(id)`).
 * - `remove`: carries the link id; the app confirms and deletes.
 * - `editNote`: a note was edited inline and saved changed; carries
 *   `{ linkId, note }` (null when cleared).
 *
 * Clicks don't bubble out (the message under it may react to clicks), and
 * Escape while editing a note only cancels the edit.
 *
 * Styles (base.css) theme through custom properties on the host:
 * `--related-accent`, `--related-chip-bg`, `--related-chip-border`,
 * `--related-note`, `--related-max-width`.
 */
@Component({
  selector: 'app-related-links',
  imports: [Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @let list = entries();
    @if (list.length > 0) {
      <section class="related-links" [class.is-compact]="compact()" [attr.aria-label]="heading()">
        @if (collapsible()) {
          <button
            type="button"
            class="related-toggle"
            [attr.aria-expanded]="expanded()"
            [attr.aria-controls]="listId"
            (click)="$event.stopPropagation(); expanded.set(!expanded())"
          >
            <app-icon name="link" [size]="13" />
            {{ heading() }}
            <app-icon [name]="expanded() ? 'chevronDown' : 'chevronRight'" [size]="13" />
          </button>
        } @else {
          <span class="related-label small">
            <app-icon name="link" [size]="13" />
            {{ heading() }}
          </span>
        }
        @if (!collapsible() || expanded()) {
          <ul class="related-list" [id]="listId">
            @for (e of list; track e.link.id) {
              <li class="related-item" [attr.data-link-id]="e.link.id">
                <button
                  type="button"
                  class="related-chip"
                  [class.is-tangent]="e.endpoint.isTangentHead"
                  [title]="e.tooltip"
                  (click)="$event.stopPropagation(); open.emit(e.nodeId)"
                >
                  <app-icon [name]="e.endpoint.isTangentHead ? 'branch' : 'link'" [size]="13" />
                  <span class="related-text">
                    @if (!compact() && e.crumbs) {
                      <span class="related-crumbs">{{ e.crumbs }}</span>
                    }
                    <span class="related-title">{{ e.title }}</span>
                  </span>
                </button>
                @if (editing() === e.link.id) {
                  <form
                    class="related-note-form"
                    (click)="$event.stopPropagation()"
                    (submit)="$event.preventDefault(); save(e)"
                  >
                    <textarea
                      rows="2"
                      [maxLength]="maxNote"
                      [value]="draft()"
                      placeholder="Why do they relate?"
                      [attr.aria-label]="'Note on this ' + noun()"
                      (input)="draft.set(note.value)"
                      (keydown)="noteKey($event, e)"
                      #note
                    ></textarea>
                    <div class="related-note-actions">
                      <button type="button" class="btn btn-sm" (click)="cancelEdit(e)">
                        Cancel
                      </button>
                      <button type="submit" class="btn btn-sm btn-primary">Save note</button>
                    </div>
                  </form>
                } @else {
                  @if (!compact() && e.link.note) {
                    <p class="related-note">{{ e.link.note }}</p>
                  }
                  @if (canEdit()) {
                    <span class="related-actions">
                      <button
                        type="button"
                        class="icon-btn"
                        title="Edit note"
                        [attr.aria-label]="'Edit the note on the ' + noun() + ' to ' + e.title"
                        (click)="$event.stopPropagation(); startEdit(e)"
                      >
                        <app-icon name="edit" [size]="13" />
                      </button>
                      <button
                        type="button"
                        class="icon-btn"
                        [title]="'Remove ' + noun()"
                        [attr.aria-label]="'Remove the ' + noun() + ' to ' + e.title"
                        (click)="$event.stopPropagation(); remove.emit(e.link.id)"
                      >
                        <app-icon name="trash" [size]="13" />
                      </button>
                    </span>
                  }
                }
              </li>
            }
          </ul>
        }
      </section>
    }
  `,
})
export class RelatedLinks {
  /** The message's links, resolved (`relatedLinks` in ./links-view). */
  readonly entries = input.required<readonly RelatedLink[]>();
  readonly canEdit = input(false);
  /** Behind an "N related" toggle (true) or always listed under a label (false). */
  readonly collapsible = input(true);
  /** The toggle is open. */
  readonly expanded = model(false);
  /** Title-only chips (Canvas cards). */
  readonly compact = input(false);
  /** The toggle's or label's text for a number of links. */
  readonly label = input<(count: number) => string>(relatedLabel);
  /** What a link is called in the buttons' labels. */
  readonly noun = input('link');

  /** A chip was clicked; carries the other end's node id. */
  readonly open = output<string>();
  /** Remove clicked; carries the link id (the app confirms). */
  readonly remove = output<string>();
  /** A note was changed inline. */
  readonly editNote = output<LinkNoteEdit>();

  protected readonly maxNote = MAX_LINK_NOTE_CHARS;
  protected readonly listId = `related-links-${++uid}`;
  protected readonly heading = computed(() => this.label()(this.entries().length));
  /** The link whose note is being edited. */
  protected readonly editing = signal<string | null>(null);
  protected readonly draft = signal('');
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly injector = inject(Injector);

  protected startEdit(e: RelatedLink): void {
    this.draft.set(e.link.note ?? '');
    this.editing.set(e.link.id);
    this.focusLater(e.link.id, 'textarea');
  }

  protected cancelEdit(e: RelatedLink): void {
    this.editing.set(null);
    this.focusLater(e.link.id, '.related-chip');
  }

  protected save(e: RelatedLink): void {
    const note = this.draft().trim() || null;
    this.cancelEdit(e);
    if (note !== e.link.note) this.editNote.emit({ linkId: e.link.id, note });
  }

  /** Enter saves (Shift+Enter: new line); Escape cancels the edit, and only the edit. */
  protected noteKey(event: KeyboardEvent, e: RelatedLink): void {
    if (event.isComposing) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      this.cancelEdit(e);
    } else if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      this.save(e);
    }
  }

  /** Focuses `selector` inside the link's chip once it has rendered (the edit form comes and goes). */
  private focusLater(linkId: string, selector: string): void {
    afterNextRender(
      () => {
        const items = this.host.nativeElement.querySelectorAll<HTMLElement>('.related-item');
        const item = [...items].find((el) => el.dataset['linkId'] === linkId);
        item?.querySelector<HTMLElement>(selector)?.focus();
      },
      { injector: this.injector },
    );
  }
}
