import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { threadTitle } from '../state/thread-title';
import { TreeStore } from '../state/tree-store';
import { HELP_TITLE } from '@tangent/shared';
import { KeysDialog, Modal, TangentHelp } from '@tangent/web-shared';
import { UiStore } from '../state/ui-store';
import { AccountDialog } from './account-dialog';
import { BranchDialog } from './branch-dialog';
import { BranchSettings } from './branch-settings';
import { CompareDialog } from './compare-dialog';
import { LinkDialog } from './link-dialog';
import { ReviewDialog } from './review-dialog';
import { SettingsDialog } from './settings-dialog';
import { ShareDialog } from './share-dialog';
import { ShortcutsHelp } from './shortcuts-help';
import { TreeSettings } from './tree-settings';

/** Renders the dialogs UiStore says are open, the top-most last. */
@Component({
  selector: 'app-dialog-host',
  imports: [
    AccountDialog,
    KeysDialog,
    BranchDialog,
    BranchSettings,
    CompareDialog,
    LinkDialog,
    TreeSettings,
    ShareDialog,
    ShortcutsHelp,
    SettingsDialog,
    ReviewDialog,
    Modal,
    TangentHelp,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <!-- In stack order: the dialog opened last is on top, and Escape closes it. -->
    @for (d of ui.dialogs.list(); track d.kind) {
      @switch (d.kind) {
        @case ('branch') {
          <app-branch-dialog [state]="d" />
        }
        @case ('branch-settings') {
          <!-- Only a tangent has its own; the main thread's are the conversation's. -->
          @if (store.index() && store.selectedBranch(); as branch) {
            @if (branch.parentBranchId) {
              <app-branch-settings [branch]="branch" />
            }
          }
        }
        @case ('tree-settings') {
          @if (store.index(); as index) {
            @if (store.detail(); as detail) {
              <app-tree-settings
                [tree]="detail.tree"
                [trunk]="index.trunk"
                [section]="d.section ?? null"
              />
            }
          }
        }
        @case ('share') {
          @if (store.index()) {
            <app-share-dialog />
          }
        }
        @case ('review') {
          @if (store.index()) {
            <app-review-dialog [nodeId]="d.nodeId" />
          }
        }
        @case ('compare') {
          @if (store.index()) {
            <app-compare-dialog [branchId]="d.branchId" [content]="d.content" />
          }
        }
        @case ('link') {
          @if (store.index()) {
            <app-link-dialog [state]="d" />
          }
        }
        @case ('settings') {
          <app-settings-dialog [section]="d.section ?? null" />
        }
        @case ('account') {
          <app-account-dialog />
        }
        @case ('shortcuts') {
          <app-shortcuts-help />
        }
        @case ('help') {
          <app-modal [heading]="helpTitle" (closed)="ui.dialogs.close('help')">
            <app-tangent-help (shortcuts)="shortcutsFromHelp()" />
          </app-modal>
        }
        @case ('keys') {
          <app-keys-dialog
            [initialProvider]="d.provider"
            [titleOf]="titleOf"
            (closed)="ui.dialogs.close('keys')"
          />
        }
      }
    }
  `,
})
export class DialogHost {
  protected readonly ui = inject(UiStore);
  protected readonly store = inject(TreeStore);
  protected readonly helpTitle = HELP_TITLE;
  protected readonly titleOf = threadTitle;

  /** The help's "Keyboard shortcuts": the shortcuts take its place, one dialog deep. */
  protected shortcutsFromHelp(): void {
    this.ui.dialogs.close('help');
    this.ui.dialogs.open({ kind: 'shortcuts' });
  }
}
