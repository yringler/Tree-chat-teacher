import { computed, inject, Injectable } from '@angular/core';
import { Router } from '@angular/router';
import { branchesWithLinks, linkTarget } from '@tangent/core';
import { type BranchFunding } from '@tangent/shared';
import type { Branch, NodeLink, ShareScope } from '@tangent/shared';
import {
  ApiClient,
  ComposerController,
  errorMessage,
  PowerConversationStore,
  ToastStore,
} from '@tangent/web-shared';
import { generationLimits, SettingsStore } from './settings-store';
import { UiStore } from './ui-store';

/**
 * Power's state: the shared conversation engine and account
 * (`PowerConversationStore`), with what power adds: read-only branches, reviews, the Settings limits on every send,
 * and its dialogs and toasts.
 */
@Injectable({ providedIn: 'root' })
export class TreeStore extends PowerConversationStore<ApiClient> {
  private readonly ui = inject(UiStore);
  private readonly composer = inject(ComposerController);
  private readonly toast = inject(ToastStore);
  private readonly appSettings = inject(SettingsStore);

  constructor() {
    super(inject(ApiClient), inject(Router), {
      tree: 'conversation',
      branch: 'branch',
      link: 'link',
      linked: { created: 'Messages linked', existing: 'Already linked' },
    });
  }

  /** How many links touch each branch's messages (outline badges). */
  readonly linkCounts = computed<ReadonlyMap<string, number>>(() => {
    const idx = this.index();
    return idx ? branchesWithLinks(idx, this.linksByNode()) : new Map<string, number>();
  });

  /**
   * The selected branch is read-only: its funding needs the membership the
   * user lacks. Its composer becomes the notice (renew, open in Learn).
   */
  readonly readOnly = computed(() => {
    const b = this.selectedBranch();
    return !!b && this.account.routeLocked(b);
  });

  /** A review of a reply in `branch`: the branch's summaries and the reviewer both need an open route. */
  canReview(branch: { funding?: BranchFunding } | null): boolean {
    return !!branch && !this.account.routeLocked(branch) && this.account.canGenerate();
  }

  // Routing

  override setRoute(
    treeId: string | null,
    branchId: string | null,
    focusNodeId: string | null,
  ): void {
    const branchBefore = this.selectedBranchId();
    super.setRoute(treeId, branchId, focusNodeId);
    // Branch settings edit the branch on screen: going to another (Back, a link) closes them.
    if (this.selectedBranchId() !== branchBefore) this.ui.dialogs.close('branch-settings');
  }

  protected override treeChanged(): void {
    this.ui.clearLinkState();
    // A comparison belongs to a branch of the tree left behind (Back while it was open).
    this.ui.dialogs.close('compare');
  }

  override go(branchId: string, focusNodeId: string | null = null, replace = false): void {
    super.go(branchId, focusNodeId, replace);
    this.ui.drawerOpen.set(false);
  }

  /**
   * Node a share/export of `scope` targets: the focused message when there is
   * one on the path; else the leaf (path) or the branch's first message (subtree).
   */
  targetNodeFor(scope: ShareScope): string | null {
    if (scope === 'tree') return null;
    const focused = this.focusedInPath();
    if (scope === 'path') return (focused ?? this.leaf())?.id ?? null;
    if (focused) return focused.id;
    const b = this.selectedBranch();
    if (!b) return null;
    return this.firstNodeOf(b.id)?.id ?? b.branchPointNodeId;
  }

  // Branches

  protected override branchOpened(branchId: string): void {
    this.composer.focus(branchId);
  }

  /** Whether replies in `branchId` can be checked against web sources (its provider can search). */
  canCheckSources(branchId: string): boolean {
    const branch = this.index()?.branches.get(branchId);
    if (!branch) return false;
    return this.account
      .providers()
      .some(
        (p) =>
          p.id === branch.providerId &&
          (p.funding ?? 'own-key') === branch.funding &&
          p.webSearch === true,
      );
  }

  // Links between messages

  /**
   * Links two messages of the open tree (not a generating call: it stays
   * available while power is read-only). Two messages already linked, either
   * way round, keep their link. Opens the "N related" list at both ends.
   */
  override async createLink(
    fromNodeId: string,
    toNodeId: string,
    note: string | null = null,
  ): Promise<NodeLink | null> {
    const link = await super.createLink(fromNodeId, toNodeId, note);
    if (link) this.ui.setRelatedOpen([fromNodeId, toNodeId], true);
    return link;
  }

  /**
   * Opens a link's other end: its branch, focused on the message. Remembers
   * where it was opened from (`fromNodeId`, else the focused message) for
   * the header's "Back to ‘…’" pill; the browser's Back works as well.
   */
  openNode(nodeId: string, fromNodeId: string | null = null): boolean {
    const idx = this.index();
    const target = idx ? linkTarget(idx, nodeId) : null;
    const here = this.selectedBranch();
    if (!target || !here) return false;
    this.ui.linkReturn.set({
      branchId: here.id,
      focusNodeId: fromNodeId ?? this.focusedInPath()?.id ?? null,
      label: here.title,
      toBranchId: target.branchId,
      toNodeId: nodeId,
    });
    this.ui.setRelatedOpen([nodeId], true);
    this.go(target.branchId, target.focusNodeId);
    return true;
  }

  // Messages and streams

  /** The reply length and input limit the user set (Settings), else nothing: the server's defaults. */
  protected override sendExtras(): ReturnType<typeof generationLimits> {
    return generationLimits(this.appSettings.settings());
  }

  protected override sent(branchId: string, content: string): void {
    this.composer.sent(branchId, content);
  }

  protected override branchesRemoved(
    branchIds: ReadonlySet<string>,
    nodeIds: ReadonlySet<string>,
  ): void {
    super.branchesRemoved(branchIds, nodeIds);
    // Linking from a message that is gone, or back to a branch that is.
    const pick = this.ui.linkPick()?.fromNodeId;
    if (pick !== undefined && nodeIds.has(pick)) this.ui.linkPick.set(null);
    const linking = this.ui.dialogs.get('link')?.fromNodeId;
    if (linking !== undefined && nodeIds.has(linking)) this.ui.dialogs.close('link');
    const back = this.ui.linkReturn();
    if (back && (branchIds.has(back.branchId) || branchIds.has(back.toBranchId))) {
      this.ui.linkReturn.set(null);
    }
  }

  protected notify(text: string, kind?: 'info' | 'error'): void {
    this.toast.notify(text, kind);
  }

  protected override keysSettled(): void {
    this.ui.dialogs.close('keys');
  }

  protected override movedToCredit(branch: Branch, modelLabel: string): void {
    this.toast.notify(`“${branch.title}” now uses Tangent credit (${modelLabel})`);
    this.composer.focus();
  }

  fail(err: unknown): void {
    console.error(err);
    const refusal = this.account.absorb(err);
    if (refusal === 'membership_required') {
      // A read-only branch's notice explains it; anything else (a review, say)
      // gets a toast linking to the billing page.
      if (!this.readOnly())
        this.toast.notify(errorMessage(err), 'error', { label: 'Membership', path: '/billing' });
      return;
    }
    if (refusal === 'payment_required') {
      // Power's only metered provider is Tangent credit: this means the credit ran out.
      this.toast.notify(errorMessage(err), 'error', { label: 'Add credit', path: '/billing' });
      return;
    }
    this.toast.notify(errorMessage(err), 'error');
    if (refusal === 'key_required' && !this.ui.dialogs.get('keys')) {
      // Ask for the key of the provider in use (the dialog also offers Tangent
      // credit for a refused send, `blockedSends`).
      const branch = this.blockedBranch() ?? this.selectedBranch();
      this.ui.dialogs.open({ kind: 'keys', provider: branch?.providerId ?? null });
    }
  }
}
