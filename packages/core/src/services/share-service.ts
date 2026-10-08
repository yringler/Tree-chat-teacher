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
}

export type PublicShareResult =
  { ok: true; share: Share; payload: SharePayload } | { ok: false; reason: 'not_found' | 'gone' };

export type PublicShareCheck =
  { ok: true; share: Share } | { ok: false; reason: 'not_found' | 'gone' };

const PROJECTION_ERRORS: Record<Exclude<ProjectShareResult, { ok: true }>['reason'], string> = {
  target_not_found: 'The message to share was not found in this conversation',
  target_private: 'That message is inside a private branch',
  empty: 'There is nothing to share yet',
};

/**
 * Owner-side share management plus public resolution.
 * Snapshot shares store the projected payload JSON at create/republish time;
 * live shares project on every view. Private exclusion happens in
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
      mode: req.mode,
      title: req.title?.trim() ? req.title.trim() : null,
      expiresAt: req.expiresAt ?? null,
      revokedAt: null,
      createdAt: now,
      updatedAt: now,
      publishedAt: req.mode === 'snapshot' ? now : null,
      version: 1,
      viewCount: 0,
    };
    // Validate for both modes; only snapshots store the payload.
    const payload = await this.project(share);
    await this.shares.createShare(
      share,
      share.mode === 'snapshot' ? JSON.stringify(payload) : null,
    );
    return this.summarize({ ...share, treeTitle: tree.title });
  }

  async update(shareId: string, request: UpdateShareRequest): Promise<ShareSummary> {
    const req = updateShareRequestSchema.parse(request);
    await this.requireOwnedShare(shareId);
    const patch: Parameters<Repositories['shares']['updateShare']>[1] = { updatedAt: this.now() };
    if (req.title !== undefined) patch.title = req.title?.trim() ? req.title.trim() : null;
    if (req.expiresAt !== undefined) patch.expiresAt = req.expiresAt;
    const updated = await this.shares.updateShare(shareId, patch);
    if (!updated) throw new NotFoundError('Share');
    return this.summarize(updated);
  }

  /** Snapshot: re-project and replace the stored payload, bump version. Live: bump version only. */
  async republish(shareId: string): Promise<ShareSummary> {
    const share = await this.requireOwnedShare(shareId);
    if (share.revokedAt) throw new GoneError('This share has been revoked');
    const now = this.now();
    const patch = { updatedAt: now, version: share.version + 1 };
    let updated: ShareWithTree | null;
    if (share.mode === 'snapshot') {
      const payload = await this.project(share);
      updated = await this.shares.updateShare(
        shareId,
        { ...patch, publishedAt: now },
        JSON.stringify(payload),
      );
    } else {
      updated = await this.shares.updateShare(shareId, patch);
    }
    if (!updated) throw new NotFoundError('Share');
    return this.summarize(updated);
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
   * Returns the share when active.
   */
  async checkPublic(token: string): Promise<PublicShareCheck> {
    if (!token || token.length > 128) return { ok: false, reason: 'not_found' };
    const share = await this.shares.getShareByToken(token);
    if (!share) return { ok: false, reason: 'not_found' };
    if (this.stateOf(share) !== 'active') return { ok: false, reason: 'gone' };
    return { ok: true, share };
  }

  /** Validates token state (revoked/expired → gone) and returns the payload. */
  async resolvePublic(token: string): Promise<PublicShareResult> {
    const check = await this.checkPublic(token);
    if (!check.ok) return check;
    const { share } = check;
    if (share.mode === 'snapshot') {
      const json = await this.shares.getSnapshot(share.id);
      if (!json) return { ok: false, reason: 'gone' };
      return { ok: true, share, payload: JSON.parse(json) as SharePayload };
    }
    try {
      return { ok: true, share, payload: await this.project(share) };
    } catch (err) {
      if (err instanceof ValidationError || err instanceof NotFoundError) {
        return { ok: false, reason: 'gone' };
      }
      throw err;
    }
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
    if (share.revokedAt) return 'revoked';
    if (share.expiresAt && share.expiresAt <= this.now()) return 'expired';
    return 'active';
  }

  private summarize(share: ShareWithTree): ShareSummary {
    const base = this.deps.publicBaseUrl.replace(/\/+$/, '');
    return { ...share, url: `${base}/s/${share.token}`, state: this.stateOf(share) };
  }
}
