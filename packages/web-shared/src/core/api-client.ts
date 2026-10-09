import { inject, Injectable } from '@angular/core';
import {
  API_ROUTES,
  routeUrl,
  type AdminCreditRequest,
  type ApiError as ApiErrorBody,
  type ApiErrorCode,
  type ApiRoute,
  type CandidateRequest,
  type ContextLimitsQuery,
  type CreateBranchRequest,
  type CreateLinkRequest,
  type CreateShareRequest,
  type CreateTreeRequest,
  type NodeLink,
  type PoolBlockDetails,
  type ReviewRequest,
  type RouteInput,
  type RouteReply,
  type RouteSpec,
  type SendMessageRequest,
  type ShareScope,
  type TreeBackupInput,
  type UpdateAdminUserRequest,
  type UpdateBranchRequest,
  type UpdateLinkRequest,
  type UpdateSettingsRequest,
  type UpdateShareRequest,
  type UpdateTreeRequest,
} from '@tangent/shared';
import { API_FETCH, API_HEADERS, defaultApiFetch } from './api-fetch';

/**
 * Thrown for every non-2xx API response (and for network failures, with
 * status 0). `pool` carries what an open pool refusal hit (`pool_*` codes).
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ApiErrorCode | 'network',
    message: string,
    readonly pool: PoolBlockDetails | null = null,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** `POST /api/links`: the link, and whether this call made it (201) or the pair was already linked (200). */
export interface CreateLinkResult {
  link: NodeLink;
  created: boolean;
}

export interface ExportParams {
  treeId: string;
  scope: ShareScope;
  nodeId?: string | null;
  format: 'md' | 'html';
  includeAncestors?: boolean;
  includePrivate?: boolean;
}

function isErrorBody(value: unknown): value is ApiErrorBody {
  if (typeof value !== 'object' || value === null || !('error' in value)) return false;
  const err = value.error;
  return (
    typeof err === 'object' && err !== null && 'message' in err && typeof err.message === 'string'
  );
}

/** What a 401 `unauthorized` (no session, or an expired one) says, whatever the server's text. */
export const SESSION_EXPIRED_MESSAGE =
  'Your session has expired. Reload the page to sign in again.';

/** Error code for a non-2xx response without our JSON error body (e.g. a proxy page). */
function fallbackCode(status: number): ApiErrorCode {
  if (status === 402) return 'payment_required';
  if (status === 404) return 'not_found';
  return status >= 500 ? 'internal' : 'bad_request';
}

type JsonRoute = Extract<ApiRoute, { reply: { kind: 'json' | 'empty' } }>;
type StreamRoute = Extract<ApiRoute, { reply: { kind: 'stream' } }>;
/** A call's input argument, optional for a route that takes none. */
type InputArgs<R extends RouteSpec> =
  Record<never, never> extends RouteInput<R> ? [input?: RouteInput<R>] : [input: RouteInput<R>];

/** Any route's input, as the plumbing handles it. */
interface AnyInput {
  params?: Readonly<Record<string, string>>;
  body?: unknown;
  query?: Readonly<Record<string, string | number | boolean | null | undefined>>;
}

const R = API_ROUTES;

/**
 * Typed fetch wrapper for the owner API (`/api/*`), over the API_FETCH
 * transport. Every route is an entry of API_ROUTES (@tangent/shared), which
 * says its method, path, body and reply; `call` and `stream` take an entry,
 * so a route's reply type comes from the table. The named methods are one
 * call each, for the apps and their test doubles.
 */
@Injectable({ providedIn: 'root' })
export class ApiClient {
  /** Optional so a bare `Injector.create` (tests) falls back to the global fetch. */
  private readonly transport = inject(API_FETCH, { optional: true }) ?? defaultApiFetch;
  private readonly extraHeaders = inject(API_HEADERS, { optional: true }) ?? (() => ({}));

  /** Calls a JSON (or 204) route; resolves with its reply. */
  call<R extends JsonRoute>(route: R, ...input: InputArgs<R>): Promise<RouteReply<R>>;
  async call(route: JsonRoute, input: AnyInput = {}): Promise<unknown> {
    return (await this.send(route, input)).reply;
  }

  /** `call`, plus the status, for a route whose 2xx codes differ in meaning. */
  callWithStatus<R extends JsonRoute>(
    route: R,
    ...input: InputArgs<R>
  ): Promise<{ reply: RouteReply<R>; status: number }>;
  callWithStatus(route: JsonRoute, input: AnyInput = {}): Promise<unknown> {
    return this.send(route, input);
  }

  /** Opens a `text/event-stream` route; resolves with the open response. */
  stream<R extends StreamRoute>(
    route: R,
    input: RouteInput<R>,
    signal: AbortSignal,
  ): Promise<Response>;
  async stream(route: StreamRoute, input: AnyInput, signal: AbortSignal): Promise<Response> {
    const res = await this.request(route, input, signal);
    if (!res.body) throw new ApiError(res.status, 'internal', 'Empty stream response');
    return res;
  }

  /** A route's URL, for a link or a download. */
  url<R extends ApiRoute>(route: R, ...input: InputArgs<R>): string;
  url(route: ApiRoute, { params, query }: AnyInput = {}): string {
    return routeUrl(route, params, query);
  }

  me = () => this.call(R.me);
  /** Permanently deletes the signed-in user and everything they own; `confirmEmail` must be their email. */
  deleteAccount = (confirmEmail: string) => this.call(R.deleteAccount, { body: { confirmEmail } });
  providers = () => this.call(R.providers);

  // Bring-your-own-key: the key goes to the Worker once and comes back only
  // as a sealed HttpOnly cookie that this code can't read.
  keyStatus = () => this.call(R.keyStatus);
  saveKey = (provider: string, apiKey: string) =>
    this.call(R.saveKey, { body: { provider, apiKey } });
  /** Omit `provider` to forget every stored key. */
  forgetKey = (provider?: string) => this.call(R.forgetKey, { body: provider ? { provider } : {} });

  // Billing (both apps: the membership and the credit are per user)
  billing = () => this.call(R.billing);
  /** One page of metered usage, newest first. Pass the previous page's `nextCursor` for the next. */
  usage = (cursor?: string | null, limit?: number) =>
    this.call(R.usage, { query: { cursor: cursor || null, limit } });
  /** A one-time top-up of the caller's own credit: the payment provider's checkout URL. */
  createCheckout = (amountCents: number) => this.call(R.createCheckout, { body: { amountCents } });
  /** The yearly membership's checkout (or, for a user who already pays, the billing portal). */
  membershipCheckout = () => this.call(R.membershipCheckout);
  /** The payment provider's billing portal; 404 `no_customer` until something was paid. */
  billingPortal = () => this.call(R.billingPortal);
  /** Redeems the operator's code to waive the membership fee; resolves with the membership. */
  redeemMembershipWaiver = (code: string) =>
    this.call(R.redeemMembershipWaiver, { body: { code } });

  // The open pool
  poolStatus = () => this.call(R.poolStatus);
  poolMe = () => this.call(R.poolMe);

  // Account settings (server-side, per account)
  settings = () => this.call(R.settings);
  /** `systemPrompt: null` (or blank) goes back to the built-in default. */
  updateSettings = (req: UpdateSettingsRequest) => this.call(R.updateSettings, { body: req });

  // Trees, branches and links
  listTrees = () => this.call(R.listTrees);
  createTree = (req: CreateTreeRequest) => this.call(R.createTree, { body: req });
  getTree = (treeId: string) => this.call(R.getTree, { params: { treeId } });
  updateTree = (treeId: string, req: UpdateTreeRequest) =>
    this.call(R.updateTree, { params: { treeId }, body: req });
  deleteTree = (treeId: string) => this.call(R.deleteTree, { params: { treeId } });
  createBranch = (req: CreateBranchRequest) => this.call(R.createBranch, { body: req });
  updateBranch = (branchId: string, req: UpdateBranchRequest) =>
    this.call(R.updateBranch, { params: { branchId }, body: req });
  deleteBranch = (branchId: string) => this.call(R.deleteBranch, { params: { branchId } });
  /** `limits`: plan like a send with power's settings (the server ignores them in Learn). */
  getContext = (
    branchId: string,
    nodeId: string | null,
    resolve: boolean,
    limits: ContextLimitsQuery = {},
  ) => this.call(R.getContext, { params: { branchId }, query: { nodeId, resolve, ...limits } });
  /** What bounds a message's input on the branch (power's input limit setting). */
  inputBudget = (branchId: string) => this.call(R.inputBudget, { params: { branchId } });
  /** Resolves with the new link, or the existing one when the two messages are already linked. */
  createLink = async (req: CreateLinkRequest): Promise<CreateLinkResult> => {
    const { reply, status } = await this.callWithStatus(R.createLink, { body: req });
    return { link: reply, created: status === 201 };
  };
  updateLink = (linkId: string, req: UpdateLinkRequest) =>
    this.call(R.updateLink, { params: { linkId }, body: req });
  deleteLink = (linkId: string) => this.call(R.deleteLink, { params: { linkId } });

  // Generating: each resolves with the open event stream
  sendMessage = (branchId: string, req: SendMessageRequest, signal: AbortSignal) =>
    this.stream(R.sendMessage, { params: { branchId }, body: req }, signal);
  /** Reconnect to a generation: `snapshot`, then live events. */
  streamNode = (nodeId: string, signal: AbortSignal) =>
    this.stream(R.streamNode, { params: { nodeId } }, signal);
  cancelNode = (nodeId: string) => this.call(R.cancelNode, { params: { nodeId } });
  /** Review the conversation up to an assistant reply. */
  reviewNode = (nodeId: string, req: ReviewRequest, signal: AbortSignal) =>
    this.stream(R.reviewNode, { params: { nodeId }, body: req }, signal);
  /** Compare: one model's candidate answer at the branch's leaf; nothing is stored until committed. */
  streamCandidate = (branchId: string, req: CandidateRequest, signal: AbortSignal) =>
    this.stream(R.streamCandidate, { params: { branchId }, body: req }, signal);
  /** Keeps one finished candidate: appends the question and that answer to the branch. */
  commitCandidate = (branchId: string, candidateId: string) =>
    this.call(R.commitCandidate, { params: { branchId, candidateId } });

  // Shares
  listShares = () => this.call(R.listShares);
  createShare = (req: CreateShareRequest) => this.call(R.createShare, { body: req });
  updateShare = (shareId: string, req: UpdateShareRequest) =>
    this.call(R.updateShare, { params: { shareId }, body: req });
  republishShare = (shareId: string) => this.call(R.republishShare, { params: { shareId } });
  revokeShare = (shareId: string) => this.call(R.revokeShare, { params: { shareId } });
  deleteShare = (shareId: string) => this.call(R.deleteShare, { params: { shareId } });

  // Admin (the admin app; 404 for anyone but an admin)
  adminStatus = () => this.call(R.adminStatus);
  /** One page of users, newest first; `q` filters by email substring. */
  adminUsers = (q?: string, cursor?: string | null) =>
    this.call(R.adminUsers, { query: { q: q || null, cursor: cursor || null } });
  updateAdminUser = (userId: string, req: UpdateAdminUserRequest) =>
    this.call(R.updateAdminUser, { params: { userId }, body: req });
  /** The open pool's balance, holds and overage breaker state. */
  adminPool = () => this.call(R.adminPool);
  /** Credits (or debits) a user's personal ledger or the pool without a payment. */
  adminCredit = (req: AdminCreditRequest) => this.call(R.adminCredit, { body: req });
  /** Pool consumption per user over the last `days`, most spend first. */
  adminPoolUsage = (days?: number) =>
    this.call(R.adminPoolUsage, { query: { days: days || undefined } });
  adminUserShares = (userId: string) => this.call(R.adminUserShares, { params: { userId } });
  /** Revokes any user's share (a takedown). */
  adminRevokeShare = (shareId: string) => this.call(R.adminRevokeShare, { params: { shareId } });

  // Export / backup / import

  /** Download link for a Markdown or HTML export. */
  exportUrl = (p: ExportParams) =>
    this.url(R.exportTree, {
      query: {
        treeId: p.treeId,
        scope: p.scope,
        format: p.format,
        nodeId: p.scope !== 'tree' ? p.nodeId : null,
        includeAncestors: p.includeAncestors || null,
        includePrivate: p.includePrivate || null,
      },
    });
  /** Download link for the JSON backup of one tree. */
  backupUrl = (treeId: string) => this.url(R.backup, { params: { treeId } });
  /**
   * The JSON backup of one tree, fetched with this app's headers, for an app
   * that saves it from memory (Learn).
   */
  backup = (treeId: string) => this.call(R.backup, { params: { treeId } });
  importBackup = (backup: TreeBackupInput) => this.call(R.importBackup, { body: backup });

  // Plumbing

  private async send(
    route: JsonRoute,
    input: AnyInput,
  ): Promise<{ reply: unknown; status: number }> {
    const res = await this.request(route, input);
    const text = res.status === 204 ? '' : await res.text();
    return { reply: text ? JSON.parse(text) : undefined, status: res.status };
  }

  private async request(
    route: RouteSpec,
    { params, body, query }: AnyInput,
    signal?: AbortSignal,
  ): Promise<Response> {
    const init: RequestInit = {
      method: route.method,
      credentials: 'same-origin',
      headers: { ...this.extraHeaders(), accept: 'application/json, text/event-stream' },
    };
    if (signal) init.signal = signal;
    if (body !== undefined) {
      init.body = JSON.stringify(body);
      init.headers = { ...init.headers, 'content-type': 'application/json' };
    }
    let res: Response;
    // Called detached: a provided bare `fetch` must not be invoked with `this` set.
    const transport = this.transport;
    try {
      res = await transport(routeUrl(route, params, query), init);
    } catch (err) {
      if (signal?.aborted) throw err;
      throw new ApiError(0, 'network', err instanceof Error ? err.message : 'Network error');
    }
    if (!res.ok) throw await this.toError(res);
    return res;
  }

  private async toError(res: Response): Promise<ApiError> {
    let parsed: unknown = null;
    try {
      parsed = await res.json();
    } catch {
      // Not JSON (e.g. a proxy error page).
    }
    // Only a missing or expired session is "sign in again". Other 401s (no
    // usable API key: `key_required`) keep their code and the server's message.
    if (res.status === 401 && (!isErrorBody(parsed) || parsed.error.code === 'unauthorized'))
      return new ApiError(401, 'unauthorized', SESSION_EXPIRED_MESSAGE);
    if (isErrorBody(parsed))
      return new ApiError(
        res.status,
        parsed.error.code,
        parsed.error.message,
        parsed.error.pool ?? null,
      );
    return new ApiError(res.status, fallbackCode(res.status), `${res.status} ${res.statusText}`);
  }
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * True for an ApiError with `code`: `unauthorized` is a missing or expired
 * session (not `key_required`), `not_found` something gone (or never the
 * caller's), and the `pool_*` codes carry what the refusal hit in `err.pool`.
 */
export function hasCode(err: unknown, code: ApiErrorCode | 'network'): err is ApiError {
  return err instanceof ApiError && err.code === code;
}
