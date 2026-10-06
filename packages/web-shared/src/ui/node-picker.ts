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
  output,
  signal,
} from '@angular/core';
import { describeEndpoint, type BranchTitleOf } from '@tangent/core/links';
import type { TreeIndex } from '@tangent/core/tree';
import { MAX_LINK_NOTE_CHARS } from '@tangent/shared';
import { Icon } from './icon';
import {
  endpointCrumbs,
  followActive,
  linkExclusions,
  movePick,
  pickerRows,
  type LinksByNode,
  type PickerRow,
} from './links-view';

let uid = 0;

/** What NodePicker hands back: the message to link to, and the note (trimmed; null when blank). */
export interface LinkPick {
  nodeId: string;
  note: string | null;
}

const ownTitle: BranchTitleOf = (b) => b.title;
const noLinks: LinksByNode = new Map();

/**
 * Picks the other end of a new link: a search box over the tree's messages
 * and tangent titles (`searchNodes`); with an empty query, the whole outline
 * to browse, each branch followed by its messages (a tangent's heading picks
 * its first message). Then an optional note, and "Link". All three apps;
 * the app hosts it (a Modal, a popover) and creates the link.
 *
 * Inputs:
 * - `index` (required): the tree (`indexTree`).
 * - `sourceNodeId` (null): where the link is made from; it and the messages
 *   it is already linked to (`linksByNode`) are never offered.
 * - `linksByNode` (none): the tree's links by node (`indexLinks`).
 * - `titleOf` (`b => b.title`): how the app names a branch.
 * - `withNote` (true): ask for a note after picking; false emits `picked`
 *   on the pick itself (note null).
 * - `placeholder`, `noteLabel`, `notePlaceholder`, `submitLabel`: copy
 *   (Learn: "This connects to…", "Why? (a note for yourself)", "Connect").
 * - `tangentLabel` ('Tangent'): what a branch heading is called, before its
 *   title ("Tangent: ‹title›"; Learn: 'Side question').
 *
 * Outputs:
 * - `picked`: `{ nodeId, note }`; the app creates the link and closes.
 * - `cancelled`: Cancel or Escape. The picker stops Escape from reaching the
 *   app's global handler, so the app closes the picker on `cancelled`.
 *
 * Content projected into it goes into its actions row, before Cancel (the
 * power app's "Pick on the page instead"; class `btn-left` puts it on the left).
 *
 * Keyboard: the search box is a combobox; ↑/↓ move through the results
 * (skipping headings), Enter picks, Escape cancels. In the note, Enter links
 * (Shift+Enter: new line). The search box has `autofocus`, which Modal
 * focuses on open.
 *
 * Styles (base.css) theme through custom properties on the host:
 * `--picker-accent`, `--picker-active-bg`, `--picker-list-height`.
 */
@Component({
  selector: 'app-node-picker',
  imports: [Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @let c = chosen();
    @if (c === null) {
      <div class="node-picker-search">
        <app-icon name="search" [size]="14" />
        <input
          type="text"
          role="combobox"
          autofocus
          autocomplete="off"
          spellcheck="false"
          aria-autocomplete="list"
          aria-expanded="true"
          [attr.aria-controls]="listId"
          [attr.aria-activedescendant]="activeId()"
          [attr.aria-label]="placeholder()"
          [placeholder]="placeholder()"
          [value]="query()"
          (input)="query.set(q.value)"
          (keydown)="searchKey($event)"
          #q
        />
      </div>
      <ul
        class="node-picker-list"
        role="listbox"
        [id]="listId"
        [attr.aria-label]="query().trim() ? 'Matching messages' : 'All messages'"
      >
        @for (row of rows(); track row.key; let i = $index) {
          @if (row.nodeId === null) {
            <li class="node-picker-heading" role="presentation" [style.--depth]="row.depth">
              <app-icon name="branch" [size]="13" />
              <span class="node-picker-title">{{ row.title }}</span>
            </li>
          } @else {
            <li
              class="node-picker-option"
              role="option"
              [id]="optionId(row)"
              [attr.aria-selected]="i === active()"
              [attr.data-node-id]="row.nodeId"
              [class.is-active]="i === active()"
              [class.is-branch]="row.kind === 'branch'"
              [class.is-user]="row.role === 'user'"
              [style.--depth]="row.depth"
              (mousedown)="$event.preventDefault()"
              (click)="choose(i)"
            >
              @if (row.kind === 'branch') {
                <app-icon name="branch" [size]="13" />
                <span class="node-picker-title"
                  ><span class="sr-only">{{ tangentLabel() }}: </span>{{ row.title }}</span
                >
              } @else {
                @if (row.role === 'user') {
                  <span class="node-picker-role">You:</span>
                }
                <span class="node-picker-title">{{ row.title }}</span>
              }
              @if (row.crumbs) {
                <span class="node-picker-crumbs">{{ row.crumbs }}</span>
              }
            </li>
          }
        } @empty {
          <li class="node-picker-empty muted small" role="presentation">
            @if (query().trim()) {
              No messages match “{{ query().trim() }}”.
            } @else {
              Nothing else to link to yet.
            }
          </li>
        }
      </ul>
    } @else {
      <div class="node-picker-chosen">
        <app-icon [name]="c.kind === 'branch' ? 'branch' : 'link'" [size]="14" />
        <span class="node-picker-text">
          @if (chosenCrumbs(); as crumbs) {
            <span class="node-picker-crumbs">{{ crumbs }}</span>
          }
          <span class="node-picker-title"
            >{{ c.kind === 'branch' ? tangentLabel() + ': ' : '' }}{{ c.title }}</span
          >
        </span>
        <button type="button" class="btn btn-ghost btn-sm" (click)="unchoose()">Change</button>
      </div>
      <label class="field">
        <span class="field-label">{{ noteLabel() }}</span>
        <textarea
          rows="3"
          [maxLength]="maxNote"
          [placeholder]="notePlaceholder()"
          [value]="note()"
          (input)="note.set(n.value)"
          (keydown)="noteKey($event)"
          #n
        ></textarea>
      </label>
    }
    <div class="form-actions node-picker-actions">
      <ng-content />
      <button type="button" class="btn" (click)="cancelled.emit()">Cancel</button>
      @if (c !== null) {
        <button type="button" class="btn btn-primary" (click)="submit()">
          {{ submitLabel() }}
        </button>
      }
    </div>
  `,
  host: { '(keydown.escape)': 'escape($event)' },
})
export class NodePicker {
  readonly index = input.required<TreeIndex>();
  /** Where the link is made from (never offered, nor its linked messages). */
  readonly sourceNodeId = input<string | null>(null);
  readonly linksByNode = input<LinksByNode>(noLinks);
  readonly titleOf = input<BranchTitleOf>(ownTitle);
  /** Ask for a note after the pick (true), or emit on the pick (false). */
  readonly withNote = input(true);
  readonly placeholder = input('Search messages and tangents');
  readonly noteLabel = input('Note (optional)');
  readonly notePlaceholder = input('Why do they relate?');
  readonly submitLabel = input('Link');
  /** What a branch heading is called, before its title. */
  readonly tangentLabel = input('Tangent');

  readonly picked = output<LinkPick>();
  readonly cancelled = output();

  protected readonly maxNote = MAX_LINK_NOTE_CHARS;
  protected readonly listId = `node-picker-${++uid}`;
  protected readonly query = signal('');
  protected readonly note = signal('');
  /** The picked row, while the note is asked for. */
  protected readonly chosen = signal<PickerRow | null>(null);

  private readonly exclude = computed(() =>
    linkExclusions(this.linksByNode(), this.sourceNodeId()),
  );
  protected readonly rows = computed(() =>
    pickerRows(this.index(), this.query(), {
      exclude: this.exclude(),
      titleOf: this.titleOf(),
    }),
  );
  private readonly list = computed(() => ({ rows: this.rows(), query: this.query().trim() }));
  /** The highlighted row (index into rows): see `followActive`. */
  protected readonly active = linkedSignal<{ rows: PickerRow[]; query: string }, number>({
    source: this.list,
    computation: ({ rows, query }, previous) =>
      followActive(previous && { ...previous.source, active: previous.value }, rows, query),
  });
  protected readonly activeId = computed(() => {
    const row = this.rows()[this.active()];
    return row ? this.optionId(row) : null;
  });
  /** Where the chosen message lives (browsed rows carry no breadcrumb). */
  protected readonly chosenCrumbs = computed(() => {
    const c = this.chosen();
    const nodeId = c?.nodeId ?? null;
    const endpoint =
      nodeId === null ? null : describeEndpoint(this.index(), nodeId, this.titleOf());
    return c && endpoint ? endpointCrumbs(endpoint, c.kind === 'branch') : '';
  });

  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly injector = inject(Injector);

  protected optionId(row: PickerRow): string {
    return `${this.listId}-${row.key}`;
  }

  /** Picks row `i`: on to the note, or straight out without one. */
  protected choose(i: number): void {
    const row = this.rows()[i];
    if (!row || row.nodeId === null) return;
    if (!this.withNote()) {
      this.picked.emit({ nodeId: row.nodeId, note: null });
      return;
    }
    this.chosen.set(row);
    this.focusLater('textarea');
  }

  protected unchoose(): void {
    this.chosen.set(null);
    this.focusLater('input');
  }

  protected submit(): void {
    const nodeId = this.chosen()?.nodeId ?? null;
    // The message may have gone meanwhile (a branch deleted elsewhere): pick again.
    if (nodeId === null || !this.index().nodes.has(nodeId)) {
      this.unchoose();
      return;
    }
    this.picked.emit({ nodeId, note: this.note().trim() || null });
  }

  protected searchKey(e: KeyboardEvent): void {
    if (e.isComposing) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const next = movePick(this.rows(), this.active(), e.key === 'ArrowDown' ? 1 : -1);
      this.active.set(next);
      const row = this.rows()[next];
      if (row) document.getElementById(this.optionId(row))?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter') {
      e.preventDefault();
      this.choose(this.active());
    }
  }

  protected noteKey(e: KeyboardEvent): void {
    if (e.isComposing || e.key !== 'Enter' || e.shiftKey) return;
    e.preventDefault();
    this.submit();
  }

  /** Escape cancels, and goes no further: the app closes the picker on `cancelled`. */
  protected escape(e: Event): void {
    e.preventDefault();
    e.stopPropagation();
    this.cancelled.emit();
  }

  private focusLater(selector: string): void {
    afterNextRender(() => this.host.nativeElement.querySelector<HTMLElement>(selector)?.focus(), {
      injector: this.injector,
    });
  }
}
