import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { clip, THREAD_ENDS } from '@tangent/shared';
import { threadTitle } from '../state/thread-title';
import { TreeStore } from '../state/tree-store';
import { UiStore } from '../state/ui-store';
import { DEMO_MODE, Icon, SidebarToggle, TextSizeMenu, ThreadEnds } from '@tangent/web-shared';
import { confirmDeleteBranch } from '../dialogs/branch-settings';
import { ModeBadge } from '../ui/mode-badge';
import { ExportMenu } from './export-menu';

@Component({
  selector: 'app-chat-header',
  imports: [Icon, ModeBadge, ExportMenu, SidebarToggle, TextSizeMenu],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <header class="chat-head">
      <div class="chat-head-row">
        <app-sidebar-toggle />
        <!-- The title takes the reader back to the start of the thread on screen. -->
        <h1 class="tree-name">
          <button type="button" class="to-start" [title]="toStartTitle" (click)="ends.toStart()">
            {{ store.detail()?.tree?.title }}
          </button>
        </h1>
        <div class="toolbar" role="toolbar" aria-label="Conversation actions">
          <button
            type="button"
            class="btn btn-ghost btn-sm"
            aria-label="Conversation settings"
            title="Conversation settings"
            (click)="ui.dialogs.open({ kind: 'tree-settings' })"
          >
            <app-icon name="settings" /> <span class="hide-narrow">Conversation</span>
          </button>
          <!-- Shares and exports are made by the server; the demo has none. Public links
               only while this user may publish them (MeResponse.sharing); export always. -->
          @if (!demo) {
            @if (store.account.me()?.sharing) {
              <button
                type="button"
                class="btn btn-ghost btn-sm"
                aria-label="Share…"
                title="Share a read-only link"
                (click)="ui.dialogs.open({ kind: 'share' })"
              >
                <app-icon name="share" /> <span class="hide-narrow">Share…</span>
              </button>
            }
            <app-export-menu />
          }
          <app-text-size-menu [(open)]="ui.textSizeMenuOpen" [shortcuts]="true" />
          <button
            type="button"
            class="icon-btn"
            [class.is-on]="ui.inspectorOpen()"
            [attr.aria-pressed]="ui.inspectorOpen()"
            aria-label="Context inspector (i)"
            title="Context inspector (i)"
            (click)="ui.toggleInspector()"
          >
            <app-icon name="panel" />
          </button>
          <button
            type="button"
            class="icon-btn"
            aria-label="Keyboard shortcuts (?)"
            title="Keyboard shortcuts (?)"
            (click)="ui.dialogs.open({ kind: 'shortcuts' })"
          >
            <app-icon name="keyboard" />
          </button>
        </div>
      </div>
      <div class="chat-head-row crumbs-row">
        @if (linkReturn(); as back) {
          <!-- After opening a link: back to the message it was opened from. -->
          <button
            type="button"
            class="link-return"
            [title]="'Back to the linked message in “' + back.label + '”'"
            (click)="goBack()"
          >
            <app-icon name="back" [size]="13" /> Back to ‘{{ clip(back.label, 32) }}’
          </button>
        }
        <nav aria-label="Tangent path" class="crumbs">
          <ol>
            @for (c of store.crumbs(); track c.branch.id; let last = $last) {
              <li>
                @if (c.current) {
                  <button
                    type="button"
                    class="crumb crumb-current"
                    aria-current="page"
                    [title]="inTangent() ? toTangentStartTitle : toStartTitle"
                    (click)="ends.toStart()"
                  >
                    {{ titleOf(c.branch) }}
                  </button>
                } @else {
                  <button
                    type="button"
                    class="crumb"
                    (click)="store.go(c.branch.id, c.focusNodeId)"
                  >
                    {{ titleOf(c.branch) }}
                  </button>
                }
                @if (!last) {
                  <span class="crumb-sep" aria-hidden="true">›</span>
                }
              </li>
            }
          </ol>
        </nav>
        @if (store.selectedBranch(); as b) {
          @if (b.parentBranchId) {
            <app-mode-badge [mode]="b.contextMode" [long]="true" />
          }
          @if (b.isPrivate) {
            <span class="badge" title="Excluded from shares and exports"
              ><app-icon name="lock" [size]="12" /> private</span
            >
          }
          <!-- The open tangent's own settings sit with its other actions; the main
               thread's are the conversation's. -->
          @if (b.parentBranchId) {
            <button
              type="button"
              class="btn btn-ghost btn-sm"
              aria-label="Tangent settings"
              title="Tangent settings"
              (click)="ui.dialogs.open({ kind: 'branch-settings' })"
            >
              <app-icon name="settings" /> <span class="hide-narrow">Tangent</span>
            </button>
          }
          @if (b.parentBranchId && b.branchPointNodeId) {
            <button
              type="button"
              class="btn btn-ghost btn-sm"
              (click)="store.navigate('parent')"
              title="Parent message (Alt+↑ or [)"
            >
              <app-icon name="back" /> Parent message
            </button>
          }
          <button
            type="button"
            class="btn btn-ghost btn-sm"
            [disabled]="!firstNodeId()"
            [title]="
              firstNodeId()
                ? linkLabel() + ' (its first message) to another message'
                : (inTangent() ? 'The tangent' : 'The main thread') + ' has no messages to link yet'
            "
            (click)="linkBranch()"
          >
            <app-icon name="link" /> {{ linkLabel() }}…
          </button>
          @if (b.parentBranchId) {
            <button
              type="button"
              class="icon-btn icon-btn-danger"
              [attr.aria-label]="'Delete ' + b.title"
              title="Delete this tangent"
              (click)="remove(b.id)"
            >
              <app-icon name="trash" [size]="14" />
            </button>
          }
        }
      </div>
    </header>
  `,
})
export class ChatHeader {
  protected readonly store = inject(TreeStore);
  protected readonly ui = inject(UiStore);
  protected readonly demo = inject(DEMO_MODE);
  protected readonly ends = inject(ThreadEnds);
  protected readonly toStartTitle = THREAD_ENDS.toStart;
  protected readonly toTangentStartTitle = THREAD_ENDS.toTangentStart;

  /** The return pill, while the view is still where the link went. */
  protected readonly linkReturn = computed(() => {
    const back = this.ui.linkReturn();
    if (!back || back.toBranchId !== this.store.selectedBranchId()) return null;
    return this.store.focusedNodeId() === back.focusNodeId ? null : back;
  });

  /**
   * The open branch is a tangent: the trunk is the main thread, and its
   * controls say so rather than calling it a tangent.
   */
  protected readonly inTangent = computed(() => !!this.store.selectedBranch()?.parentBranchId);

  protected readonly linkLabel = computed(() =>
    this.inTangent() ? 'Link this tangent' : 'Link the main thread',
  );

  /** "Link this tangent…" links its first message. */
  protected readonly firstNodeId = computed(() => {
    const b = this.store.selectedBranch();
    return b ? (this.store.firstNodeOf(b.id)?.id ?? null) : null;
  });

  protected readonly clip = clip;
  protected readonly titleOf = threadTitle;

  protected goBack(): void {
    const back = this.ui.linkReturn();
    if (!back) return;
    this.ui.linkReturn.set(null);
    this.store.go(back.branchId, back.focusNodeId);
  }

  protected linkBranch(): void {
    const id = this.firstNodeId();
    if (!id) return;
    this.ui.linkPick.set(null);
    this.ui.dialogs.open({ kind: 'link', fromNodeId: id });
  }

  protected async remove(branchId: string): Promise<void> {
    await confirmDeleteBranch(this.store, branchId);
  }
}
