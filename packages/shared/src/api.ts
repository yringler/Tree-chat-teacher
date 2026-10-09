import { z } from './zod.js';
import type { ContextPlan } from './context-plan.js';
import type {
  Branch,
  BranchFunding,
  ChatNode,
  ContextMode,
  LinkOrigin,
  Payer,
  NodeLink,
  Share,
  ShareMode,
  ShareScope,
  TokenUsage,
  Tree,
} from './domain.js';
import { NODE_ERROR_KINDS } from './domain.js';
import type { ProviderInfo } from './provider.js';
import { MAX_REQUESTED_OUTPUT_TOKENS, MIN_REQUESTED_OUTPUT_TOKENS } from './output-tokens.js';
import {
  INPUT_OVERFLOWS,
  MAX_REQUESTED_INPUT_TOKENS,
  MIN_REQUESTED_INPUT_TOKENS,
  requestedInputTokens,
} from './input-limit.js';
import type { AccountMode, MembershipInfo } from './billing.js';
import {
  CITATIONS_MAX,
  CITATION_EXCERPT_MAX,
  type Citation,
  type GroundingMode,
} from './grounding.js';
import type { PoolBlockDetails } from './pool.js';

/*
 * The HTTP API's request schemas and reply types. Its routes, with which
 * schema and type each takes and answers, are API_ROUTES (api-routes.ts).
 * Every non-2xx response carries an ApiError body.
 */

export interface ApiError {
  error: {
    code: ApiErrorCode;
    message: string;
    /** Pool refusals (`pool_*` codes): what was hit, for the empty and cap-reached states. */
    pool?: PoolBlockDetails;
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
  /** 402: generating on own keys needs the yearly membership (`MembershipInfo.required`), and the user has none. */
  | 'membership_required'
  /** 401: no usable API key for the provider (missing, tampered, expired or rotated key cookie). */
  | 'key_required'
  | 'provider_error'
  | 'internal'
  /** 402: the open pool can't cover the request right now (`error.pool`). */
  | 'pool_empty'
  /** 429: a daily pool cap or rate limit was reached (`error.pool` says which, and when it resets). */
  | 'pool_cap_reached'
  /** 403: the pool can't be used for this request or by this account. */
  | 'pool_unavailable'
  /** 404: the payment provider has no customer for the user yet (`POST /api/billing/portal`). */
  | 'no_customer'
  /** 501: a route the in-browser demos don't offer (sharing, keys, payments, admin). */
  | 'not_implemented';

export interface MeResponse {
  /** Signed-in user's email; null only in dev bypass mode. */
  email: string | null;
  /**
   * Signed-in user's Better Auth id, shown as "Account ID" so they can give it
   * to the operator (e.g. to be allowed to share); null only in dev bypass mode.
   */
  userId: string | null;
  /**
   * Account the request acts as, the same in every mode: the user's
   * `u_<userId>`; `default_simple` in dev bypass mode.
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
   * True when the server offers the built-in provider (`openrouter`, the
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
   * `required && status === 'inactive'` means generating on the user's own
   * keys answers 402 `membership_required` (the open pool and Tangent
   * credit don't).
   */
  membership: MembershipInfo;
  /**
   * The fundings on which generating in this account needs the membership,
   * whether or not the user has one: the Worker's own rule
   * (`needsMembership` in billing/gate.ts) asked of each funding.
   * `['own-key']` in either app where the membership is required (the user's
   * own keys; Tangent credit needs none); empty wherever no membership is
   * required (the fee off, a server without billing, the dev bypass). A
   * branch or lesson on one of these fundings is read-only while
   * `membership.status` is `inactive`. The server states the rule so the
   * clients never copy it.
   */
  membershipNeededFor: BranchFunding[];
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
  /** Cross-links between the tree's messages (NodeLink). */
  links: NodeLink[];
}

const id = z.string().min(1).max(64);
const contextMode = z.enum([
  'path',
  'summary',
  'message',
  'independent',
]) satisfies z.ZodType<ContextMode>;
const groundingMode = z.enum(['off', 'auto', 'always']) satisfies z.ZodType<GroundingMode>;
const citationSchema = z.object({
  url: z.string().max(2048),
  title: z.string().max(500).nullable(),
  excerpt: z
    .string()
    .max(CITATION_EXCERPT_MAX + 1)
    .nullable(),
}) satisfies z.ZodType<Citation>;
/** Who pays for a branch's calls in power mode (`Branch.funding`); Learn ignores it. */
export const branchFundingSchema = z.enum(['own-key', 'credit']) satisfies z.ZodType<BranchFunding>;
/** Longest system prompt a tree or the account settings may hold. */
export const MAX_SYSTEM_PROMPT_CHARS = 20_000;

/**
 * Without a (non-blank) `systemPrompt`, the tree gets the account's saved
 * default (SettingsResponse.systemPrompt), else the built-in one.
 */
export const createTreeRequestSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  systemPrompt: z.string().max(MAX_SYSTEM_PROMPT_CHARS).nullable().optional(),
  /** The trunk's endpoint and how power pays for it; both default to the account's default route. */
  providerId: id.optional(),
  funding: branchFundingSchema.optional(),
  model: z.string().min(1).max(200).optional(),
});
export type CreateTreeRequest = z.infer<typeof createTreeRequestSchema>;

/**
 * Per-account settings, stored server-side (one row per account, the same in
 * every app).
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
  /**
   * Defaults to the parent branch's provider, funding and model. A provider
   * without a funding is on the user's own key (`own-key`); a funding
   * without a provider keeps the parent's provider.
   */
  providerId: id.optional(),
  funding: branchFundingSchema.optional(),
  model: z.string().min(1).max(200).optional(),
  isPrivate: z.boolean().optional(),
  /** Defaults to the parent branch's setting. */
  grounding: groundingMode.optional(),
});
export type CreateBranchRequest = z.input<typeof createBranchRequestSchema>;

export const updateBranchRequestSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  contextMode: contextMode.optional(),
  anchorQuote: z.string().max(10_000).nullable().optional(),
  isPrivate: z.boolean().optional(),
  /** As in createBranchRequestSchema: a provider without a funding is `own-key`. */
  providerId: id.optional(),
  funding: branchFundingSchema.optional(),
  model: z.string().min(1).max(200).optional(),
  grounding: groundingMode.optional(),
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

/** Most links one tree may hold (`POST /api/links` beyond it is 400). */
export const MAX_LINKS_PER_TREE = 1000;
/** Longest note a link may carry. */
export const MAX_LINK_NOTE_CHARS = 500;

const linkNote = z.string().trim().max(MAX_LINK_NOTE_CHARS);

/**
 * Links two messages of the same tree (400 for two trees, or a message to
 * itself). A blank `note` is stored as null.
 */
export const createLinkRequestSchema = z
  .object({
    /** Where the link was made from (`NodeLink.sourceNodeId`). */
    fromNodeId: id,
    toNodeId: id,
    note: linkNote.nullable().optional(),
  })
  .refine((v) => v.fromNodeId !== v.toNodeId, {
    message: 'A message cannot be linked to itself',
    path: ['toNodeId'],
  });
export type CreateLinkRequest = z.input<typeof createLinkRequestSchema>;

/** A blank `note` is stored as null. */
export const updateLinkRequestSchema = z.object({
  note: linkNote.nullable(),
});
export type UpdateLinkRequest = z.infer<typeof updateLinkRequestSchema>;

/**
 * Power's reply length and input limit, as a send, a compare candidate and a
 * review take them (JSON body fields; Learn's server ignores them). Clamped
 * like a send's: within the model's limits, and on Tangent credit at the
 * server's caps.
 */
export const generationLimitsShape = {
  /**
   * Power only (Learn ignores it): the reply's output cap, instead of the
   * default for the model (larger for reasoning models, output-tokens.ts);
   * capped at the model's limit.
   */
  maxOutputTokens: z
    .number()
    .int()
    .min(MIN_REQUESTED_OUTPUT_TOKENS)
    .max(MAX_REQUESTED_OUTPUT_TOKENS)
    .optional(),
  /**
   * Power only (Learn ignores it): the most input the message may send, below
   * the model's context window (input-limit.ts); the server caps it at the
   * window less the reply, and on Tangent credit at its own input cap.
   */
  maxInputTokens: requestedInputTokens.optional(),
  /** Power only: what a conversation over its input budget loses (absent = `compact`). */
  inputOverflow: z.enum(INPUT_OVERFLOWS).optional(),
};

export const sendMessageRequestSchema = z.object({
  content: z.string().min(1).max(200_000),
  /** `required`: "Check sources", the reply must run a web search (400 if the provider can't). */
  ground: z.enum(['required']).optional(),
  ...generationLimitsShape,
});
export type SendMessageRequest = z.infer<typeof sendMessageRequestSchema>;

/**
 * Query parameters of `GET /api/branches/:id/context` that make the preview
 * plan like a send with power's settings (all optional; the server ignores
 * them in Learn, as it does on a send).
 */
export const contextLimitsQuerySchema = z.object({
  maxInputTokens: z.coerce
    .number()
    .int()
    .min(MIN_REQUESTED_INPUT_TOKENS)
    .max(MAX_REQUESTED_INPUT_TOKENS)
    .optional(),
  maxOutputTokens: z.coerce
    .number()
    .int()
    .min(MIN_REQUESTED_OUTPUT_TOKENS)
    .max(MAX_REQUESTED_OUTPUT_TOKENS)
    .optional(),
  inputOverflow: z.enum(INPUT_OVERFLOWS).optional(),
});
export type ContextLimitsQuery = z.infer<typeof contextLimitsQuerySchema>;

/** `GET /api/branches/:id/context`: plan before `nodeId` (default: the leaf), `resolve` missing summaries. */
export const contextQuerySchema = contextLimitsQuerySchema.extend({
  nodeId: z.string().min(1).max(64).optional(),
  resolve: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
});

/** `GET /api/billing/usage`: newest first, from `cursor` (the previous page's `nextCursor`). */
export const usageQuerySchema = z.object({
  cursor: z.string().min(1).max(512).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

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
  | {
      type: 'start';
      userNode: ChatNode;
      assistantNode: ChatNode;
      branch: Branch;
      /** Who pays for the reply, as the server decided (a Learn send may move from credit to the pool). */
      funding: Payer;
    }
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
  funding: BranchFunding;
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
  /** Absent in backups made before links existed. */
  links?: NodeLink[];
}

/**
 * The file-name stem of an export or backup of a tree titled `title`: ASCII
 * words joined by hyphens, at most 60 characters, `tangent-export` when
 * nothing is left.
 */
export function exportFileStem(title: string): string {
  const s = title
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/[\s_]+/g, '-')
    .toLowerCase()
    .slice(0, 60);
  return s || 'tangent-export';
}

/** The file name of a tree's JSON backup (`<stem>.tangent.json`), from the server or a Learn download. */
export function backupFileName(title: string): string {
  return `${exportFileStem(title)}.tangent.json`;
}

const isoDate = z.string().min(1).max(64);
const role = z.enum(['user', 'assistant', 'system']);
const nodeStatus = z.enum(['streaming', 'complete', 'error']);
const nodeErrorKind = z.enum(NODE_ERROR_KINDS);
const linkOrigin = z.enum(['user', 'ai']) satisfies z.ZodType<LinkOrigin>;

/*
 * What one import may write. An import lands in D1 in one batch, so these
 * (with the per-account import rate limit, byok/guard.ts) bound what a
 * request can add to the database; each sits well above what using the app
 * produces, so any exported tree imports again.
 */
/** A backup's JSON: a long conversation (1,000 exchanges with 4 KB replies) is about 5 MB. */
export const MAX_BACKUP_BYTES = 10 * 1024 * 1024;
/** Branches of one tree, as many as the links it may hold. */
export const MAX_BACKUP_BRANCHES = 1_000;
/** Messages of one tree: 5,000 exchanges. */
export const MAX_BACKUP_NODES = 10_000;
/**
 * One message: a reply at the largest output cap (128k tokens of ~4
 * characters) fits, and even at 3 UTF-8 bytes a character the row stays
 * under D1's 2 MB limit.
 */
export const MAX_BACKUP_NODE_CHARS = 600_000;
/** A failed reply's error as imported: provider errors are kept whole, so a longer one is cut, not refused. */
export const MAX_NODE_ERROR_CHARS = 2_000;

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
  branches: z
    .array(
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
        grounding: groundingMode.optional(),
        /**
         * Optional: import reads a missing one as `own-key`
         * (ChatService.importBackup), so an import never spends credit implicitly.
         */
        funding: branchFundingSchema.optional(),
        createdAt: isoDate,
        updatedAt: isoDate,
      }),
    )
    .max(MAX_BACKUP_BRANCHES),
  nodes: z
    .array(
      z.object({
        id,
        treeId: id,
        branchId: id,
        parentId: id.nullable(),
        seq: z.number().int().min(0),
        role,
        content: z.string().max(MAX_BACKUP_NODE_CHARS),
        status: nodeStatus,
        error: z
          .string()
          .transform((s) => s.slice(0, MAX_NODE_ERROR_CHARS))
          .nullable(),
        // A kind from a later version reads as none: import takes the kind from the message.
        errorKind: nodeErrorKind.nullable().optional().catch(null),
        providerId: z.string().max(64).nullable(),
        model: z.string().max(200).nullable(),
        usage: z.object({ inputTokens: z.number(), outputTokens: z.number() }).nullable(),
        sources: z.array(citationSchema).max(CITATIONS_MAX).nullable().optional(),
        createdAt: isoDate,
      }),
    )
    .max(MAX_BACKUP_NODES),
  /**
   * Absent in backups made before links existed. Import drops a link whose
   * ends aren't both in `nodes`, a self-link and a repeated pair.
   */
  links: z
    .array(
      z.object({
        id,
        treeId: id,
        sourceNodeId: id,
        targetNodeId: id,
        note: z.string().max(MAX_LINK_NOTE_CHARS).nullable(),
        origin: linkOrigin.optional(),
        createdAt: isoDate,
        updatedAt: isoDate,
      }),
    )
    .max(MAX_LINKS_PER_TREE)
    .optional(),
});

export type { ProviderInfo };
