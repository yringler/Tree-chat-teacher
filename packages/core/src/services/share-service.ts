import {
  DEFAULT_ACCOUNT_ID,
  createShareRequestSchema,
  updateShareRequestSchema,
  type CreateShareRequest,
  type Share,
  type SharePayload,
  type ShareSummary,
  type UpdateShareRequest,
} from '@tangent/shared';
import { GoneError, NotFoundError, ValidationError } from '../errors.js';
import { shareTexts } from '../moderation/share-texts.js';
import type { Repositories, ShareWithTree } from '../repository.js';
import { projectShare, type ProjectShareResult } from '../share-projection.js';
import { newId as defaultNewId, newShareToken, systemClock, type Clock } from '../util.js';

export interface ShareServiceDeps {
  repos: Repositories;
  /** Account acting through this service instance. Default DEFAULT_ACCOUNT_ID. */
  accountId?: string;
  /** Origin used to build share URLs, e.g. https://tangent.example.com */
  publicBaseUrl: string;
  clock?: Clock;
  newId?: () => string;
  newToken?: () => string;
  /**
   * Screens what a publish would make public before it is stored; rejects
   * (a DomainError) to refuse it. Called on create, republish, and a new
   * title. Without it nothing is screened.
   */
  screen?: (publish: SharePublish) => Promise<void>;
}

/** What a publish would make public, for `ShareServiceDeps.screen`. */
export interface SharePublish {
  /** A new link, a republish, or a new title on an existing link. */
  trigger: 'create' | 'republish' | 'title';
  /** The share as it would be stored; on create its id is not stored yet. */
  share: Share;
  /**
   * What the link would show: the new snapshot, or for a new title the
   * stored one carrying it (null when none is stored).
   */
  payload: SharePayload | null;
  /** The text to screen: the whole snapshot, or only the new title. */
  texts: readonly string[];
}

export type PublicShareResult =
  { ok: true; share: Share; payload: SharePayload } | { ok: false; reason: 'not_found' | 'gone' };

export type PublicShareCheck =
  { ok: true; share: Share } | { ok: false; reason: 'not_found' | 'gone' };

const PROJECTION_ERRORS: Record<Exclude<ProjectShareResult, { ok: true }>['reason'], string> = {
  target_not_found: 'The message to share was not found in this conversation',
  target_private: 'That message is inside a private tangent',
  empty: 'There is nothing to share yet',
};

/**
 * A link taken down after a report stays down until an admin restores it:
 * its owner can't edit or republish it back up, only delete it. The message
 * gives no reason, so it doesn't tell the owner about the report.
 */
function assertNotTakenDown(share: Share): void {
  if (share.takedown) throw new GoneError('This link is unavailable');
}

/**
 * Owner-side share management plus public resolution.
 * Every share stores the projected payload JSON at create and republish
 * time, and views read only that snapshot. Private exclusion happens in
 * `projectShare`, so excluded content never reaches the payload.
 */
export class ShareService {
  private readonly clock: Clock;
  private readonly newId: () => string;
  private readonly newToken: () => string;
  readonly accountId: string;

  constructor(readonly deps: ShareServiceDeps) {
    this.accountId = deps.accountId ?? DEFAULT_ACCOUNT_ID;
    this.clock = deps.clock ?? systemClock;
    this.newId = deps.newId ?? (() => defaultNewId());
    this.newToken = deps.newToken ?? newShareToken;
  }

  private get shares() {
    return this.deps.repos.shares;
  }

  private now(): string {
    return this.clock().toISOString();
  }

  async list(): Promise<ShareSummary[]> {
    const rows = await this.shares.listShares(this.accountId);
    return rows.map((s) => this.summarize(s));
  }

  /** Rejects with ValidationError if the target is missing, private, or the scope is empty. */
  async create(request: CreateShareRequest): Promise<ShareSummary> {
    const req = createShareRequestSchema.parse(request);
    const now = this.now();
    if (req.expiresAt && req.expiresAt <= now)
      throw new ValidationError('Expiry must be in the future');
    const tree = await this.deps.repos.trees.getTree(req.treeId);
    if (!tree || tree.accountId !== this.accountId) throw new NotFoundError('Tree');

    const share: Share = {
      id: this.newId(),
      token: this.newToken(),
      accountId: tree.accountId,
      treeId: tree.id,
      scope: req.scope,
      targetNodeId: req.scope === 'tree' ? null : (req.nodeId ?? null),
      includeAncestors: req.scope === 'subtree' && req.includeAncestors,
      title: req.title?.trim() ? req.title.trim() : null,
      expiresAt: req.expiresAt ?? null,
      revokedAt: null,
      createdAt: now,
      updatedAt: now,
      publishedAt: now,
      version: 1,
      viewCount: 0,
      takedown: null,
    };
    const payload = await this.project(share);
    await this.deps.screen?.({ trigger: 'create', share, payload, texts: shareTexts(payload) });
    await this.shares.createShare(share, JSON.stringify(payload));
    return this.summarize({ ...share, treeTitle: tree.title });
  }

  async update(shareId: string, request: UpdateShareRequest): Promise<ShareSummary> {
    const req = updateShareRequestSchema.parse(request);
    const share = await this.requireOwnedShare(shareId);
    assertNotTakenDown(share);
    const patch: Parameters<Repositories['shares']['updateShare']>[1] = { updatedAt: this.now() };
    if (req.title !== undefined) patch.title = req.title?.trim() ? req.title.trim() : null;
    if (patch.title && patch.title !== share.title && this.deps.screen) {
      const stored = await this.shares.getSnapshot(shareId);
      await this.deps.screen({
        trigger: 'title',
        share: { ...share, title: patch.title },
        payload: stored ? { ...(JSON.parse(stored) as SharePayload), title: patch.title } : null,
        texts: [patch.title],
      });
    }
    if (req.expiresAt !== undefined) patch.expiresAt = req.expiresAt;
    const updated = await this.shares.updateShare(shareId, patch);
    if (!updated) throw new NotFoundError('Share');
    return this.summarize(updated);
  }

  /** Re-projects the tree, replaces the stored payload and bumps the version. */
  async republish(shareId: string): Promise<ShareSummary> {
    const share = await this.requireOwnedShare(shareId);
    if (share.revokedAt) throw new GoneError('This share has been revoked');
    assertNotTakenDown(share);
    const now = this.now();
    const payload = await this.project(share);
    await this.deps.screen?.({ trigger: 'republish', share, payload, texts: shareTexts(payload) });
    const updated = await this.shares.updateShare(
      shareId,
      { updatedAt: now, version: share.version + 1, publishedAt: now },
      JSON.stringify(payload),
    );
    if (!updated) throw new NotFoundError('Share');
    return this.summarize(updated);
  }

  /** One of the account's shares. */
  async get(shareId: string): Promise<ShareSummary> {
    return this.summarize(await this.requireOwnedShare(shareId));
  }

  /** Sets revokedAt and deletes the stored snapshot. Idempotent. */
  async revoke(shareId: string): Promise<ShareSummary> {
    const share = await this.requireOwnedShare(shareId);
    if (share.revokedAt) return this.summarize(share);
    const now = this.now();
    const updated = await this.shares.updateShare(
      shareId,
      { revokedAt: now, updatedAt: now, version: share.version + 1 },
      null,
    );
    if (!updated) throw new NotFoundError('Share');
    return this.summarize(updated);
  }

  /**
   * Removes the share and its snapshot for good: the link stops resolving (404,
   * as for a token that never existed) and the share leaves the list. Works in
   * any state, so an active link can be taken down and removed in one step.
   * Returns the share as it was, so the caller can purge its cached copies.
   */
  async delete(shareId: string): Promise<ShareSummary> {
    const share = await this.requireOwnedShare(shareId);
    if (!(await this.shares.deleteShare(shareId))) throw new NotFoundError('Share');
    return this.summarize(share);
  }

  /**
   * Cheap validity check (no payload) used before serving an edge-cached copy.
   * Returns the share when active; a taken-down, revoked or expired one is gone.
   */
  async checkPublic(token: string): Promise<PublicShareCheck> {
    if (!token || token.length > 128) return { ok: false, reason: 'not_found' };
    const share = await this.shares.getShareByToken(token);
    if (!share) return { ok: false, reason: 'not_found' };
    if (this.stateOf(share) !== 'active') return { ok: false, reason: 'gone' };
    return { ok: true, share };
  }

  /**
   * Validates token state (revoked/expired → gone) and returns the stored
   * snapshot. A share without one is gone: the tree is never projected for a
   * viewer, so nothing is public that wasn't published.
   */
  async resolvePublic(token: string): Promise<PublicShareResult> {
    const check = await this.checkPublic(token);
    if (!check.ok) return check;
    const { share } = check;
    const json = await this.shares.getSnapshot(share.id);
    if (!json) return { ok: false, reason: 'gone' };
    return { ok: true, share, payload: JSON.parse(json) as SharePayload };
  }

  /** A share owned by another account is reported as not found. */
  private async requireOwnedShare(shareId: string): Promise<ShareWithTree> {
    const share = await this.shares.getShare(shareId);
    if (!share || share.accountId !== this.accountId) throw new NotFoundError('Share');
    return share;
  }

  recordView(shareId: string): Promise<void> {
    return this.shares.incrementViewCount(shareId);
  }

  private async project(share: Share): Promise<SharePayload> {
    const trees = this.deps.repos.trees;
    const tree = await trees.getTree(share.treeId);
    if (!tree) throw new NotFoundError('Tree');
    const [branches, nodes] = await Promise.all([
      trees.listBranches(share.treeId),
      trees.listNodes(share.treeId),
    ]);
    const result = projectShare({
      tree,
      branches,
      nodes,
      scope: share.scope,
      targetNodeId: share.targetNodeId,
      includeAncestors: share.includeAncestors,
      title: share.title,
      now: this.now(),
    });
    if (!result.ok) throw new ValidationError(PROJECTION_ERRORS[result.reason]);
    return result.payload;
  }

  private stateOf(share: Share): ShareSummary['state'] {
    if (share.takedown) return 'unavailable';
    if (share.revokedAt) return 'revoked';
    if (share.expiresAt && share.expiresAt <= this.now()) return 'expired';
    return 'active';
  }

  private summarize(share: ShareWithTree): ShareSummary {
    const base = this.deps.publicBaseUrl.replace(/\/+$/, '');
    const { takedown: _takedown, ...shown } = share;
    return { ...shown, url: `${base}/s/${share.token}`, state: this.stateOf(share) };
  }
}
