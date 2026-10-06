import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { TreeStore } from '../state/tree-store';
import { UiStore } from '../state/ui-store';
import { AccountDialog } from './account-dialog';
import { ApiKeys } from './api-keys';
import { BranchDialog } from './branch-dialog';
import { BranchSettings } from './branch-settings';
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
    ApiKeys,
    BranchDialog,
    BranchSettings,
    LinkDialog,
    TreeSettings,
    ShareDialog,
    ShortcutsHelp,
    SettingsDialog,
    ReviewDialog,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (ui.branchDialog(); as state) {
      <app-branch-dialog [state]="state" />
    }
    @if (store.index()) {
      @if (ui.branchSettingsOpen() && store.selectedBranch(); as branch) {
        <app-branch-settings [branch]="branch" />
      }
      @if (ui.treeSettingsOpen() && store.detail(); as detail) {
        <app-tree-settings [tree]="detail.tree" />
      }
      @if (ui.shareDialogOpen()) {
        <app-share-dialog />
      }
      @if (ui.reviewDialog(); as review) {
        <app-review-dialog [nodeId]="review.nodeId" />
      }
      @if (ui.linkDialog(); as link) {
        <app-link-dialog [state]="link" />
      }
    }
    @if (ui.settingsOpen()) {
      <app-settings-dialog />
    }
    @if (ui.accountOpen()) {
      <app-account-dialog />
    }
    @if (ui.shortcutsOpen()) {
      <app-shortcuts-help />
    }
    @if (ui.keysDialog(); as keys) {
      <app-api-keys [initialProvider]="keys.provider" />
    }
  `,
})
export class DialogHost {
  protected readonly ui = inject(UiStore);
  protected readonly store = inject(TreeStore);
}
