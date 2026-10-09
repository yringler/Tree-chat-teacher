// The Worker's side of the tree's Durable Object protocol (tree-session.ts):
// one method per internal route, so the routes never build its URLs, and the
// encoding of the account each call acts as, both ways.
import { z } from 'zod';
import type { AccountContext, AppEnv } from '../env.js';
import type { PoolParams } from '../pool/params.js';
import type { SessionCommitBody, SessionHoldBody, SessionSendBody } from './tree-session.js';

const ids = {
  id: z.string().min(1),
  userId: z.string().min(1).nullable(),
  billingAccountId: z.string().min(1),
};

/**
 * Every `AccountContext`, and nothing else. The pool's parameters were
 * resolved by the Worker (pool/params.ts) and travel as they are.
 */
const accountSchema = z.union([
  z.strictObject({
    ...ids,
    mode: z.literal('power'),
    creditOffered: z.boolean(),
    operatorKeys: z.boolean(),
  }),
  z.strictObject({ ...ids, mode: z.literal('simple'), payer: z.enum(['own-key', 'credit']) }),
  z.strictObject({
    ...ids,
    userId: z.string().min(1),
    mode: z.literal('simple'),
    payer: z.literal('pool'),
    pool: z.custom<PoolParams>((v) => typeof v === 'object' && v !== null && !Array.isArray(v)),
  }),
  z.strictObject({ ...ids, mode: z.literal('simple'), payer: z.literal('pool'), pool: z.null() }),
]) satisfies z.ZodType<AccountContext>;

/**
 * The account an internal call acts as, checked whole: a missing or malformed
 * one throws (a 500 from the Durable Object), never standing in for another
 * account such as the dev bypass's.
 */
export function parseAccount(value: unknown): AccountContext {
  return accountSchema.parse(value);
}

/** The account as a query parameter, for the internal routes without a body (`accountFromParams` reads it). */
export function accountParams(account: AccountContext): Record<string, string> {
  return { account: JSON.stringify(account) };
}

/** The account `accountParams` sent; throws when it is missing or malformed (`parseAccount`). */
export function accountFromParams(params: URLSearchParams): AccountContext {
  const json = params.get('account');
  if (json === null) throw new Error('The internal call names no account');
  return parseAccount(JSON.parse(json));
}

/**
 * The Durable Object of `treeId` (one per tree). Its answers are passed on
 * as they are: an SSE stream, or JSON (an error's JSON body included).
 */
export function treeSession(env: AppEnv, treeId: string) {
  const stub = env.TREE_SESSION.get(env.TREE_SESSION.idFromName(treeId));
  const call = (path: string, params: Record<string, string>, init?: RequestInit) =>
    stub.fetch(
      `https://tree-session${path}?${new URLSearchParams({ treeId, ...params }).toString()}`,
      init,
    );
  const post = (body: unknown): RequestInit => ({ method: 'POST', body: JSON.stringify(body) });
  return {
    send: (branchId: string, body: SessionSendBody) => call('/send', { branchId }, post(body)),
    stream: (nodeId: string, account: AccountContext) =>
      call('/stream', { nodeId, ...accountParams(account) }),
    cancel: (nodeId: string, account: AccountContext) =>
      call('/cancel', { nodeId, ...accountParams(account) }, { method: 'POST' }),
    deleteBranch: (branchId: string, account: AccountContext) =>
      call('/delete-branch', { branchId, ...accountParams(account) }, { method: 'POST' }),
    deleteTree: (account: AccountContext) =>
      call('/delete-tree', accountParams(account), { method: 'POST' }),
    holdCandidate: (body: SessionHoldBody) => call('/hold-candidate', {}, post(body)),
    commitCandidate: (body: SessionCommitBody) => call('/commit-candidate', {}, post(body)),
  };
}
