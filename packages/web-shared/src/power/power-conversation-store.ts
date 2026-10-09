import { computed, signal } from '@angular/core';
import {
  isModelAllowed,
  parseRouteKey,
  type Branch,
  type CommitCandidateResponse,
  type MeResponse,
} from '@tangent/shared';
import { addBlockedSend, type BlockedSend } from '../billing/key-missing';
import { ApiError } from '../core/api-client';
import {
  ConversationStore,
  type ConversationApi,
  type FailedSend,
} from '../conversation/conversation-store';
import { PowerAccountStore, type PowerAccountApi } from './power-account';

/** The server calls power's stores make. */
export type PowerApi = ConversationApi & PowerAccountApi;

/**
 * The conversation engine with what power and the canvas add to it: the
 * account (`account`: keys, membership, credit) and the messages a missing
 * key held back. Every branch pays its own way (its route), so a send the
 * server refuses for want of the branch's own key waits while the keys
 * dialog asks how to carry on.
 */
export abstract class PowerConversationStore<
  A extends PowerApi = PowerApi,
> extends ConversationStore<A> {
  readonly account = new PowerAccountStore(this.api, (err) => this.fail(err));

  /**
   * Messages the server refused for want of their branch's own API key (401
   * `key_required`, before anything was written; a fan-out can leave
   * several), while the keys dialog asks how to carry on: Tangent credit
   * (`resumeOnCredit`) or the key (`resumeAfterKey`) sends them; closing the
   * dialog just forgets them (`dropBlockedSends`): the text is still in the
   * composer (`unsentDrafts`).
   */
  readonly blockedSends = signal<readonly BlockedSend[]>([]);

  /**
   * Messages that didn't reach the server's tree (any error before the reply
   * started: a missing key, no credit, a network failure…), by branch. The
   * composer of that branch takes the text back when its box is empty, so a
   * message typed elsewhere (a tangent, "Ask your own", the branch dialog, a
   * new conversation) is not lost either. Dropped when the branch sends again.
   */
  readonly unsentDrafts = signal<ReadonlyMap<string, string>>(new Map());

  /** The branch of the latest blocked send, while one waits (the keys dialog's notice). */
  readonly blockedBranch = computed<Branch | null>(() => {
    const s = this.blockedSends().at(-1);
    return (s && this.index()?.branches.get(s.branchId)) || null;
  });

  /** `me`: the signed-in caller, already fetched by the sign-in check (AuthService.requireUser). */
  async init(me: MeResponse): Promise<void> {
    await Promise.all([this.account.init(me), this.loadTrees()]);
  }

  /**
   * New tree from the home page: creates it, opens it, sends the first
   * message. `route` is a `routeKey` (provider and funding), null for the default.
   */
  async startConversation(
    content: string,
    route: string | null,
    model: string | null,
  ): Promise<void> {
    try {
      const detail = await this.openNewTree({
        ...(route ? parseRouteKey(route) : {}),
        ...(model ? { model } : {}),
      });
      void this.send(detail.tree.trunkBranchId, content);
    } catch (err) {
      this.fail(err);
    }
  }

  /** Nothing waits for a key any more: the keys dialog closes. */
  protected abstract keysSettled(): void;

  /** `branch` now replies on Tangent credit, on the model labelled `modelLabel`. */
  protected abstract movedToCredit(branch: Branch, modelLabel: string): void;

  /**
   * "Continue with Tangent credit" on a read-only branch: moves it onto
   * credit, keeping its model where credit offers it (the built-in endpoint
   * on the user's own key), else on credit's default model.
   */
  async switchToCredit(branchId: string): Promise<boolean> {
    const credit = this.account.creditRoute();
    const branch = this.index()?.branches.get(branchId);
    if (!credit || !branch) return false;
    const model =
      branch.providerId === credit.id && isModelAllowed(credit, branch.model)
        ? branch.model
        : credit.defaultModel;
    const ok = await this.updateBranch(branch.id, {
      providerId: credit.id,
      funding: 'credit',
      model,
    });
    if (ok) this.movedToCredit(branch, credit.models.find((m) => m.id === model)?.label ?? model);
    return ok;
  }

  /**
   * "Continue on Tangent credit" in the keys dialog, after sends were refused
   * for want of their branch's own key: moves each waiting branch onto credit
   * (`switchToCredit`), closes the dialog and sends its message there.
   */
  async resumeOnCredit(): Promise<boolean> {
    const waiting = this.blockedSends();
    if (waiting.length === 0) return false;
    let all = true;
    for (const s of waiting) {
      if (!(await this.switchToCredit(s.branchId))) {
        all = false;
        continue;
      }
      this.blockedSends.update((list) => list.filter((w) => w !== s));
      void this.send(s.branchId, s.content, s.ground ? { ground: s.ground } : {});
    }
    if (all) this.keysSettled();
    return all;
  }

  /**
   * A key was saved for `provider`: the waiting messages of branches on it,
   * with the user's own key, are sent; the dialog closes once none waits.
   */
  resumeAfterKey(provider: string): void {
    const branches = this.index()?.branches;
    const ready = this.blockedSends().filter((s) => {
      const b = branches?.get(s.branchId);
      return (
        !!b && b.providerId === provider && b.funding === 'own-key' && !this.account.keyMissing(b)
      );
    });
    if (ready.length === 0) return;
    this.blockedSends.update((list) => list.filter((s) => !ready.includes(s)));
    for (const s of ready)
      void this.send(s.branchId, s.content, s.ground ? { ground: s.ground } : {});
    if (this.blockedSends().length === 0) this.keysSettled();
  }

  /**
   * The keys dialog closed with messages still waiting: nothing is sent. Their
   * text stays in the composer (`unsentDrafts`), to send once the branch's
   * settings are changed.
   */
  dropBlockedSends(): void {
    if (this.blockedSends().length > 0) this.blockedSends.set([]);
  }

  override applyCommitted(result: CommitCandidateResponse): void {
    this.setUnsentDraft(result.branch.id, null);
    super.applyCommitted(result);
  }

  protected override sendStarting(branchId: string): void {
    if (this.blockedSends().some((s) => s.branchId === branchId)) {
      this.blockedSends.update((list) => list.filter((s) => s.branchId !== branchId));
    }
    this.setUnsentDraft(branchId, null);
  }

  protected override sendFailed(err: unknown, s: FailedSend): void {
    if (!s.started) {
      // Refused before anything was written: the text goes back to the branch's
      // composer (not a "Check sources" request, which the user didn't type) and,
      // for want of the key, waits for the keys dialog to carry it on.
      if (!s.options.ground) this.setUnsentDraft(s.branchId, s.content);
      if (err instanceof ApiError && err.code === 'key_required') {
        this.blockedSends.update((list) =>
          addBlockedSend(list, { branchId: s.branchId, content: s.content, ...s.options }),
        );
      }
    }
    this.fail(err);
  }

  protected override branchesRemoved(
    branchIds: ReadonlySet<string>,
    _nodeIds: ReadonlySet<string>,
  ): void {
    if (this.blockedSends().some((s) => branchIds.has(s.branchId))) {
      this.blockedSends.update((list) => list.filter((s) => !branchIds.has(s.branchId)));
    }
    for (const id of branchIds) this.setUnsentDraft(id, null);
  }

  private setUnsentDraft(branchId: string, text: string | null): void {
    const cur = this.unsentDrafts();
    if (text === null ? !cur.has(branchId) : cur.get(branchId) === text) return;
    const next = new Map(cur);
    if (text === null) next.delete(branchId);
    else next.set(branchId, text);
    this.unsentDrafts.set(next);
  }
}
