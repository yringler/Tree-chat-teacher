import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { TreeStore } from '../state/tree-store';
import { KeysDialog } from '@tangent/web-shared';
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
          @if (store.index() && store.selectedBranch(); as branch) {
            <app-branch-settings [branch]="branch" />
          }
        }
        @case ('tree-settings') {
          @if (store.index() && store.detail(); as detail) {
            <app-tree-settings [tree]="detail.tree" />
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
          <app-settings-dialog />
        }
        @case ('account') {
          <app-account-dialog />
        }
        @case ('shortcuts') {
          <app-shortcuts-help />
        }
        @case ('keys') {
          <app-keys-dialog [initialProvider]="d.provider" (closed)="ui.dialogs.close('keys')" />
        }
      }
    }
  `,
})
export class DialogHost {
  protected readonly ui = inject(UiStore);
  protected readonly store = inject(TreeStore);
}
