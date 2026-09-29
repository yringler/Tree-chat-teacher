import type {
  CreateShareRequest,
  Share,
  SharePayload,
  ShareSummary,
  UpdateShareRequest,
} from '@tangent/shared';
import type { Repositories } from '../repository.js';
import type { Clock } from '../util.js';

export interface ShareServiceDeps {
  repos: Repositories;
  /** Origin used to build share URLs, e.g. https://tangent.example.com */
  publicBaseUrl: string;
  clock?: Clock;
  newId?: () => string;
  newToken?: () => string;
}

export type PublicShareResult =
  | { ok: true; share: Share; payload: SharePayload }
  | { ok: false; reason: 'not_found' | 'gone' };

/**
 * Owner-side share management plus public resolution.
 * Snapshot shares store the projected payload JSON at create/republish time;
 * live shares project on every view. Private exclusion happens in
 * `projectShare`, so excluded content never reaches the payload.
 */
export class ShareService {
  constructor(readonly deps: ShareServiceDeps) {}

  list(): Promise<ShareSummary[]> {
    throw new Error('not implemented');
  }
  /** Rejects with ValidationError if the target is missing, private, or the scope is empty. */
  create(request: CreateShareRequest): Promise<ShareSummary> {
    void request;
    throw new Error('not implemented');
  }
  update(shareId: string, request: UpdateShareRequest): Promise<ShareSummary> {
    void shareId;
    void request;
    throw new Error('not implemented');
  }
  /** Snapshot: re-project and replace the stored payload, bump version. Live: bump version only. */
  republish(shareId: string): Promise<ShareSummary> {
    void shareId;
    throw new Error('not implemented');
  }
  /** Sets revokedAt and deletes the stored snapshot. Idempotent. */
  revoke(shareId: string): Promise<ShareSummary> {
    void shareId;
    throw new Error('not implemented');
  }
  /** Validates token state (revoked/expired → gone) and returns the payload. */
  resolvePublic(token: string): Promise<PublicShareResult> {
    void token;
    throw new Error('not implemented');
  }
  /**
   * Cheap validity check (no payload) used before serving an edge-cached copy.
   * Returns the share when active.
   */
  checkPublic(token: string): Promise<{ ok: true; share: Share } | { ok: false; reason: 'not_found' | 'gone' }> {
    void token;
    throw new Error('not implemented');
  }
  recordView(shareId: string): Promise<void> {
    void shareId;
    throw new Error('not implemented');
  }
}
