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

/** Renders whichever dialog UiStore says is open. */
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
    @if (ui.dialogs.get('branch'); as state) {
      <app-branch-dialog [state]="state" />
    }
    @if (store.index()) {
      @if (ui.dialogs.isOpen('branch-settings') && store.selectedBranch(); as branch) {
        <app-branch-settings [branch]="branch" />
      }
      @if (ui.dialogs.isOpen('tree-settings') && store.detail(); as detail) {
        <app-tree-settings [tree]="detail.tree" />
      }
      @if (ui.dialogs.isOpen('share')) {
        <app-share-dialog />
      }
      @if (ui.dialogs.get('review'); as review) {
        <app-review-dialog [nodeId]="review.nodeId" />
      }
      @if (ui.dialogs.get('compare'); as compare) {
        <app-compare-dialog [branchId]="compare.branchId" [content]="compare.content" />
      }
      @if (ui.dialogs.get('link'); as link) {
        <app-link-dialog [state]="link" />
      }
    }
    @if (ui.dialogs.isOpen('settings')) {
      <app-settings-dialog />
    }
    @if (ui.dialogs.isOpen('account')) {
      <app-account-dialog />
    }
    @if (ui.dialogs.isOpen('shortcuts')) {
      <app-shortcuts-help />
    }
    @if (ui.dialogs.get('keys'); as keys) {
      <app-keys-dialog [initialProvider]="keys.provider" (closed)="ui.dialogs.close('keys')" />
    }
  `,
})
export class DialogHost {
  protected readonly ui = inject(UiStore);
  protected readonly store = inject(TreeStore);
}
