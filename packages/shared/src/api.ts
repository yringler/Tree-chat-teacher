import { z } from 'zod';

// Neither the web app's CSP nor workerd allows eval. Skip zod's `new Function`
// JIT probe, which a strict CSP / Trusted Types reports as a violation even
// though zod catches the error.
z.config({ jitless: true });
import type { ContextPlan } from './context-plan.js';
import type {
  Branch,
  ChatNode,
  ContextMode,
  Share,
  ShareMode,
  ShareScope,
  TokenUsage,
  Tree,
} from './domain.js';
import type { ProviderInfo } from './provider.js';
import type { AccountMode, MembershipInfo } from './billing.js';
import type { PoolBlockDetails, PoolConsentDetails } from './pool.js';

/**
 * HTTP API contract between the Angular app and the Worker.
 *
 * Authentication (Better Auth, apps/worker/src/auth/auth.ts):
 *
 *   /api/auth/*                                  Better Auth endpoints (sign-in, callbacks, session, passkeys)
 *   GET    /api/login-options                    -> LoginOptionsResponse (public)
 *
 * Owner API (signed-in session required), all JSON unless noted. Each request
 * acts as the caller's account for the app named by the MODE_HEADER (power
 * when absent); Learn requests also send the PAYMENT_HEADER (billing.ts):
 *
 *   GET    /api/me                               -> MeResponse
 *   DELETE /api/account          DeleteAccountRequest -> 204 + cleared cookies (both accounts, same-origin only)
 *   GET    /api/providers                        -> ProviderInfo[]
 *   GET    /api/trees                            -> TreeSummary[]
 *   POST   /api/trees            CreateTreeRequest -> TreeDetail
 *   GET    /api/trees/:treeId                    -> TreeDetail
 *   PATCH  /api/trees/:treeId     UpdateTreeRequest -> Tree
 *   DELETE /api/trees/:treeId                    -> 204
 *   POST   /api/branches          CreateBranchRequest -> Branch
 *   PATCH  /api/branches/:branchId UpdateBranchRequest -> Branch
 *   DELETE /api/branches/:branchId               -> DeleteBranchResponse (not the trunk)
 *   POST   /api/branches/:branchId/messages SendMessageRequest -> text/event-stream of StreamEvent
 *   GET    /api/nodes/:nodeId/stream              -> text/event-stream of StreamEvent (reconnect)
 *   POST   /api/nodes/:nodeId/cancel              -> 204
 *   POST   /api/nodes/:nodeId/review ReviewRequest -> text/event-stream of ReviewEvent (review.ts)
 *   GET    /api/branches/:branchId/context?nodeId=&resolve=true|false -> ContextPlanResponse
 *   GET    /api/shares                            -> ShareSummary[]
 *   POST   /api/shares            CreateShareRequest -> ShareSummary
 *   PATCH  /api/shares/:shareId   UpdateShareRequest -> ShareSummary
 *   POST   /api/shares/:shareId/republish         -> ShareSummary
 *   POST   /api/shares/:shareId/revoke            -> ShareSummary
 *   GET    /api/export?treeId=&scope=&nodeId=&format=md|html&includeAncestors= -> file download
 *   GET    /api/trees/:treeId/backup              -> TreeBackup (JSON download)
 *   POST   /api/import            TreeBackup      -> TreeDetail (new ids)
 *   GET    /api/settings                          -> SettingsResponse (the account's own settings)
 *   PATCH  /api/settings         UpdateSettingsRequest -> SettingsResponse
 *   GET    /api/key/status                        -> KeyStatusResponse
 *   POST   /api/key              SaveKeyRequest  -> 204 + Set-Cookie (sealed, HttpOnly)
 *   DELETE /api/key              ForgetKeyRequest -> 204 + Set-Cookie (cleared or re-sealed)
 *                                                (simple: only the `openrouter` key, used as Learn's own key)
 *
 * Billing (both apps; membership and credit are per user, shared by both; billing.ts):
 *
 *   GET    /api/billing                          -> BillingSummary
 *   GET    /api/billing/usage?cursor=&limit=     -> UsageListResponse (newest first, limit <= 100, default 50)
 *   POST   /api/billing/checkout CreateCheckoutRequest -> CheckoutResponse (same-origin only;
 *                                                target `personal` or `pool`; 400 below the pool minimum)
 *   POST   /api/billing/membership/waiver MembershipWaiverRequest -> MembershipInfo (same-origin only;
 *                                                400 no code configured, 403 wrong code, 429 rate limited)
 *   POST   /api/billing/membership/checkout       -> CheckoutResponse (same-origin only; the yearly
 *                                                membership's hosted checkout, or the billing portal
 *                                                when the user already has a paid membership)
 *   POST   /api/billing/portal                    -> PortalResponse (same-origin only; the payment
 *                                                provider's billing portal; 404 `no_customer` when the
 *                                                provider has no customer for the user yet)
 *   POST   /api/webhooks/:provider                Payment provider webhooks (public, signed by the
 *                                                active provider; see the README)
 *
 * Admin (admins only: ADMIN_USER_IDS, or the local dev bypass; 404 `not_found`
 * to anyone else; admin.ts):
 *
 *   GET    /api/admin/status                     -> AdminStatusResponse
 *   GET    /api/admin/users?q=&cursor=           -> AdminUsersResponse (newest first, ADMIN_USERS_PAGE per page,
 *                                                q = email substring)
 *   PATCH  /api/admin/users/:userId UpdateAdminUserRequest -> AdminUser (same-origin only;
 *                                                share permission and/or pool suspension)
 *   GET    /api/admin/pool/usage?days=&limit=    -> AdminPoolUsageResponse (per-user pool consumption,
 *                                                most spend first; today's busiest network keys)
 *   GET    /api/admin/pool                       -> AdminPoolResponse (the pool's balance, holds and
 *                                                overage breaker state)
 *   GET    /api/admin/pool/topics?status=        -> AdminPoolTopicsResponse (the impact feed's review queue)
 *   POST   /api/admin/pool/topics/:topicId AdminPoolTopicDecision -> AdminPoolTopic (same-origin only;
 *                                                404 for a topic never queued)
 *   GET    /api/admin/users/:userId/shares       -> ShareSummary[] (both of the user's accounts, newest first)
 *   POST   /api/admin/shares/:shareId/revoke     -> ShareSummary (any owner's share; same-origin only)
 *   POST   /api/admin/credit AdminCreditRequest -> AdminCreditResponse (same-origin only; personal
 *                                                or pool, idempotent; simulated purchases 404 unless
 *                                                DEV_PURCHASES_ENABLED)
 *
 * Generating routes (messages, review, context?resolve=true) answer 402
 * `membership_required` when the membership is required and the user has
 * none (`MembershipInfo`), then 402 `payment_required` when a call on the
 * built-in provider (`tangent`, on credit) finds the available credit too
 * low. Calls on the user's own keys never touch credit. Every other route
 * stays open without a membership: nobody is locked out of their data.
 *
 * Community pool (pool.ts; Learn only, PAYMENT_HEADER `pool`, or `credit`
 * whose credit can't cover a call): the server pins the pool's model, system
 * prompt, output cap and context cap, whatever the tree or branch says.
 *
 *   POST /api/branches/:branchId/messages       402 `pool_empty`, 429 `pool_cap_reached`,
 *                                                403 `pool_unavailable` (with `error.pool`), always
 *                                                before any message is written; 400 for a message
 *                                                longer than the pool accepts
 *   GET  /api/branches/:branchId/context?resolve=true   gated the same way; summaries run on the pool
 *   POST /api/nodes/:nodeId/review               403 `pool_unavailable` on the `pool` header (no
 *                                                reviews on the pool); `credit` never falls back
 *   POST /api/pool/verify  PoolVerifyRequest  -> PoolVerifyResponse (same-origin only; a Turnstile
 *                                                pass for accounts with none on record; 400 when the
 *                                                token fails, 403 `pool_unavailable` reason
 *                                                `duplicate_identity` when another account uses the
 *                                                same mailbox)
 *   GET  /api/pool/me                         -> PoolMeResponse (today's caps and use, verified,
 *                                                supporter, the caller's own credit, the notice
 *                                                version acknowledged and the current one)
 *   POST /api/pool/consent PoolConsentRequest -> PoolConsentResponse (same-origin only; records the
 *                                                acknowledgment of POOL_NOTICE_TEXT; 409 `conflict`
 *                                                for any version but the current one)
 *
 * A pool send or resolve is refused (403 `pool_unavailable`, before anything
 * is written) for an account that is `suspended` by an admin, has no
 * Turnstile pass on record (`verify`), shares its mailbox with another pool
 * account (`duplicate_identity`) or is newer than POOL_MIN_ACCOUNT_AGE_MS
 * (`too_new`); with 403 `pool_consent_required` (`error.consent`) until the
 * current pool notice is acknowledged (again after every version bump); and
 * with 429 `pool_cap_reached` past a daily cap or a per-minute limit (`rate`). There is no OpenAI-compatible endpoint: the
 * pool is only reachable through the routes above.
 *
 * Public (no sign-in; rate-limited; read-only):
 *
 *   GET /api/pool/status     -> PoolStatusResponse (the pool meter; aggregates only, cached 60 s)
 *   GET /s/:token            -> text/html viewer page (Open Graph tags, self-contained)
 *   GET /s/:token/data.json  -> SharePayload
 *
 * Errors: non-2xx responses carry ApiError.
 */

export interface ApiError {
  error: {
    code: ApiErrorCode;
    message: string;
    /** Pool refusals (`pool_*` codes): what was hit, for the empty and cap-reached states. */
    pool?: PoolBlockDetails;
    /** 403 `pool_consent_required`: the notice version to acknowledge (`POST /api/pool/consent`). */
    consent?: PoolConsentDetails;
  };
}

export type ApiErrorCode =
  | 'bad_request'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'gone'
  | 'rate_limited'
  /** 402: a call on the built-in provider needs more credit (or billing isn't configured). */
  | 'payment_required'
  /** 402: generating needs the yearly membership (`MembershipInfo.required`), and the user has none. */
  | 'membership_required'
  /** 401: no usable API key for the provider (missing, tampered, expired or rotated key cookie). */
  | 'key_required'
  | 'provider_error'
  | 'internal'
  /** 402: the community pool can't cover the request right now (`error.pool`). */
  | 'pool_empty'
  /** 429: a daily pool cap or rate limit was reached (`error.pool` says which, and when it resets). */
  | 'pool_cap_reached'
  /** 403: the current pool notice must be acknowledged first. */
  | 'pool_consent_required'
  /** 403: the pool can't be used for this request or by this account. */
  | 'pool_unavailable'
  /** 404: the payment provider has no customer for the user yet (`POST /api/billing/portal`). */
  | 'no_customer';

export interface MeResponse {
  /** Signed-in user's email; null only in dev bypass mode. */
  email: string | null;
  /**
   * Signed-in user's Better Auth id, shown as "Account ID" so they can give it
   * to the operator (e.g. to be allowed to share); null only in dev bypass mode.
   */
  userId: string | null;
  /**
   * Account the request acts as: the user's `p_<userId>` (power) or
   * `u_<userId>` (simple); `default` / `default_simple` in dev bypass mode.
   */
  accountId: string;
  /** The app the request came from (the MODE_HEADER): `power` (/) or `simple` (/learn/). */
  mode: AccountMode;
  /** True when running with DEV_ALLOW_NO_AUTH (wrangler dev only). */
  devMode: boolean;
  /**
   * True only in the local dev bypass, whose power account may use the
   * server's PROVIDERS keys. Every signed-in user brings their own keys, or
   * uses the built-in provider on credit (`builtInCredit`).
   */
  operatorKeys: boolean;
  /**
   * True when the server offers the built-in provider (`tangent`, the
   * operator's OpenRouter key) on prepaid credit: payments and the operator's
   * key are set up. Power lists it among its providers; Learn offers it as
   * "Use Tangent credit". The credit is per user, shared by both apps.
   */
  builtInCredit: boolean;
  /**
   * True when this user may publish share links: everyone once the operator
   * set DMCA_AGENT_REGISTERED; until then only admins and the users the
   * operator allowed on the admin page. False: creating, editing and
   * republishing a share are 403 and the user's `/s/*` links don't open;
   * exporting still works.
   */
  sharing: boolean;
  /** True for the operator's own accounts (ADMIN_USER_IDS): the power app links to `/admin/`. */
  isAdmin: boolean;
  /**
   * The user's membership, so the apps can gate generating at startup:
   * `required && status === 'inactive'` means every generating request
   * answers 402 `membership_required`.
   */
  membership: MembershipInfo;
  /**
   * The "featured learning" wall of conversations users publish. Always false:
   * only a stub exists (FEATURED_CONVERSATIONS_ENABLED, docs/DEFERRED.md), so
   * no app renders an entry point.
   */
  featuredConversations: false;
}

/** What the login page offers. Magic links and passkeys are always available once auth is configured. */
export interface LoginOptionsResponse {
  /** False when the server has no BETTER_AUTH_SECRET (sign-in can't work). */
  configured: boolean;
  /** True when DEV_ALLOW_NO_AUTH applies: no sign-in needed. */
  devMode: boolean;
  /** OAuth providers with credentials configured. */
  social: { google: boolean; github: boolean };
  /** Cloudflare Turnstile site key for the magic-link form; null = not configured. */
  turnstileSiteKey: string | null;
}

export interface TreeSummary {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  branchCount: number;
  messageCount: number;
}

/** Whole tree in one response; the client builds the outline with @tangent/core. */
export interface TreeDetail {
  tree: Tree;
  branches: Branch[];
  nodes: ChatNode[];
}

const id = z.string().min(1).max(64);
const contextMode = z.enum(['path', 'summary', 'independent']) satisfies z.ZodType<ContextMode>;
/** Longest system prompt a tree or the account settings may hold. */
export const MAX_SYSTEM_PROMPT_CHARS = 20_000;

/**
 * Without a (non-blank) `systemPrompt`, the tree gets the account's saved
 * default (SettingsResponse.systemPrompt), else the built-in one.
 */
export const createTreeRequestSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  systemPrompt: z.string().max(MAX_SYSTEM_PROMPT_CHARS).nullable().optional(),
  providerId: id.optional(),
  model: z.string().min(1).max(200).optional(),
});
export type CreateTreeRequest = z.infer<typeof createTreeRequestSchema>;

/**
 * Per-account settings, stored server-side (one row per account). Power and
 * Learn are separate accounts, so each has its own.
 */
export interface SettingsResponse {
  /**
   * System prompt of new conversations; null = the built-in default
   * (`defaultSystemPrompt`). A conversation's own prompt (PATCH /api/trees/:id)
   * overrides it for that conversation.
   */
  systemPrompt: string | null;
  /** The built-in default the server uses for this account's mode, so a client can show and edit it. */
  defaultSystemPrompt: string;
}

/** A blank `systemPrompt` is stored as null (the built-in default). */
export const updateSettingsRequestSchema = z.object({
  systemPrompt: z.string().max(MAX_SYSTEM_PROMPT_CHARS).nullable(),
});
export type UpdateSettingsRequest = z.infer<typeof updateSettingsRequestSchema>;

/**
 * Permanently deletes the signed-in user: both of their accounts (power and
 * Learn) with every conversation, share link and setting, their sign-in
 * methods and sessions, and their customer record with the payment provider
 * (which cancels their membership). `confirmEmail` must be the user's email, so a stray request can't do it.
 */
export const deleteAccountRequestSchema = z.object({
  confirmEmail: z.string().trim().min(1).max(320),
});
export type DeleteAccountRequest = z.infer<typeof deleteAccountRequestSchema>;

export const updateTreeRequestSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  systemPrompt: z.string().max(MAX_SYSTEM_PROMPT_CHARS).nullable().optional(),
});
export type UpdateTreeRequest = z.infer<typeof updateTreeRequestSchema>;

export const createBranchRequestSchema = z.object({
  /** The branch point: any node of the tree. */
  fromNodeId: id,
  contextMode: contextMode.default('path'),
  anchorQuote: z.string().max(10_000).nullable().optional(),
  title: z.string().trim().min(1).max(200).optional(),
  /** Defaults to the parent branch's provider/model. */
  providerId: id.optional(),
  model: z.string().min(1).max(200).optional(),
  isPrivate: z.boolean().optional(),
});
export type CreateBranchRequest = z.input<typeof createBranchRequestSchema>;

export const updateBranchRequestSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  contextMode: contextMode.optional(),
  anchorQuote: z.string().max(10_000).nullable().optional(),
  isPrivate: z.boolean().optional(),
  providerId: id.optional(),
  model: z.string().min(1).max(200).optional(),
});
export type UpdateBranchRequest = z.infer<typeof updateBranchRequestSchema>;

/**
 * Deleting a branch removes it with every branch below it (their messages,
 * cached summaries, and shares that target one of their messages).
 */
export interface DeleteBranchResponse {
  treeId: string;
  /** The deleted branch first, then its descendants. */
  branchIds: string[];
  nodeIds: string[];
}

export const sendMessageRequestSchema = z.object({
  content: z.string().min(1).max(200_000),
});
export type SendMessageRequest = z.infer<typeof sendMessageRequestSchema>;

/**
 * Bring-your-own-key. The key is sent once, sealed by the Worker into an
 * HttpOnly cookie, and never returned by any endpoint.
 */
export const saveKeyRequestSchema = z.object({
  provider: z.string().min(1).max(64),
  apiKey: z.string().trim().min(1).max(512),
});
export type SaveKeyRequest = z.infer<typeof saveKeyRequestSchema>;

/** Omit `provider` to forget every stored key. */
export const forgetKeyRequestSchema = z.object({
  provider: z.string().min(1).max(64).optional(),
});
export type ForgetKeyRequest = z.infer<typeof forgetKeyRequestSchema>;

export interface KeyStatusResponse {
  /** False when the server has no KEY_ENCRYPTION_SECRET (keys can't be stored). */
  enabled: boolean;
  hasKey: boolean;
  /** Provider ids with a stored key. Never any part of a key. */
  providers: string[];
}

/**
 * Server-sent events on the message stream. Each SSE frame is
 * `event: <type>\ndata: <JSON StreamEvent>\n\n`.
 *
 * Order: `start` → (`status`)* → (`delta` | `usage`)* → exactly one of `done` | `error`.
 * A reconnect (`GET /api/nodes/:id/stream`) starts with `snapshot` instead of `start`.
 */
export type StreamEvent =
  | { type: 'start'; userNode: ChatNode; assistantNode: ChatNode; branch: Branch }
  | { type: 'snapshot'; node: ChatNode }
  | { type: 'status'; message: string }
  | { type: 'delta'; nodeId: string; text: string }
  | { type: 'usage'; nodeId: string; usage: Partial<TokenUsage> }
  | { type: 'done'; node: ChatNode; branch: Branch }
  | { type: 'error'; nodeId: string | null; message: string; node: ChatNode | null };

export interface ContextPlanResponse {
  plan: ContextPlan;
  /** Exactly what would be sent to the provider. */
  rendered: { system: string | null; messages: { role: 'user' | 'assistant'; content: string }[] };
  providerId: string;
  model: string;
  /** Exact provider count when supported; otherwise null (plan has estimates). */
  exactInputTokens: number | null;
}

export const shareScopeSchema = z.enum(['tree', 'subtree', 'path']) satisfies z.ZodType<ShareScope>;
export const shareModeSchema = z.enum(['snapshot', 'live']) satisfies z.ZodType<ShareMode>;

export const createShareRequestSchema = z
  .object({
    treeId: id,
    scope: shareScopeSchema,
    /** Required for subtree/path. */
    nodeId: id.nullable().optional(),
    includeAncestors: z.boolean().default(false),
    mode: shareModeSchema.default('snapshot'),
    title: z.string().trim().max(200).nullable().optional(),
    expiresAt: z.iso.datetime().nullable().optional(),
  })
  .refine((v) => v.scope === 'tree' || !!v.nodeId, {
    message: 'nodeId is required for subtree and path shares',
    path: ['nodeId'],
  });
export type CreateShareRequest = z.input<typeof createShareRequestSchema>;

export const updateShareRequestSchema = z.object({
  title: z.string().trim().max(200).nullable().optional(),
  expiresAt: z.iso.datetime().nullable().optional(),
});
export type UpdateShareRequest = z.infer<typeof updateShareRequestSchema>;

export interface ShareSummary extends Share {
  treeTitle: string;
  /** Absolute URL of the public viewer page. */
  url: string;
  /** Derived: revoked, expired, or active. */
  state: 'active' | 'revoked' | 'expired';
}

export const exportQuerySchema = z
  .object({
    treeId: id,
    scope: shareScopeSchema.default('tree'),
    nodeId: id.optional(),
    format: z.enum(['md', 'html']).default('md'),
    includeAncestors: z
      .enum(['true', 'false'])
      .default('false')
      .transform((v) => v === 'true'),
    includePrivate: z
      .enum(['true', 'false'])
      .default('false')
      .transform((v) => v === 'true'),
  })
  .refine((v) => v.scope === 'tree' || !!v.nodeId, {
    message: 'nodeId is required for subtree and path exports',
    path: ['nodeId'],
  });
export type ExportQuery = z.infer<typeof exportQuerySchema>;

/** JSON backup of one tree (owner data, including private branches). */
export interface TreeBackup {
  format: 'tangent-tree-backup';
  version: 1;
  exportedAt: string;
  tree: Tree;
  branches: Branch[];
  nodes: ChatNode[];
}

const isoDate = z.string().min(1).max(64);
const role = z.enum(['user', 'assistant', 'system']);
const nodeStatus = z.enum(['streaming', 'complete', 'error']);

/** A parsed backup as accepted by import (owner fields optional). */
export type TreeBackupInput = z.infer<typeof treeBackupSchema>;

export const treeBackupSchema = z.object({
  format: z.literal('tangent-tree-backup'),
  version: z.literal(1),
  exportedAt: isoDate,
  tree: z.object({
    id,
    /** Ignored on import: restored trees belong to the importing account. */
    accountId: id.optional(),
    title: z.string().max(200),
    systemPrompt: z.string().max(MAX_SYSTEM_PROMPT_CHARS).nullable(),
    trunkBranchId: id,
    createdAt: isoDate,
    updatedAt: isoDate,
  }),
  branches: z.array(
    z.object({
      id,
      treeId: id,
      parentBranchId: id.nullable(),
      branchPointNodeId: id.nullable(),
      contextMode,
      anchorQuote: z.string().max(10_000).nullable(),
      title: z.string().max(200),
      titleSource: z.enum(['default', 'auto', 'user']),
      isPrivate: z.boolean(),
      providerId: z.string().max(64),
      model: z.string().max(200),
      createdAt: isoDate,
      updatedAt: isoDate,
    }),
  ),
  nodes: z.array(
    z.object({
      id,
      treeId: id,
      branchId: id,
      parentId: id.nullable(),
      seq: z.number().int().min(0),
      role,
      content: z.string().max(1_000_000),
      status: nodeStatus,
      error: z.string().nullable(),
      providerId: z.string().nullable(),
      model: z.string().nullable(),
      usage: z.object({ inputTokens: z.number(), outputTokens: z.number() }).nullable(),
      createdAt: isoDate,
    }),
  ),
});

export type { ProviderInfo };
