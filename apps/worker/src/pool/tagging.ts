// Request-time topic tagging of pool conversations (spec §9 "Tagging",
// docs/pool/PLAN.md §S8a). After a pool reply completes on a branch that has
// no tag yet, the pool model classifies the user message of that exchange
// into one leaf of the taxonomy (pool/taxonomy.ts), and the leaf id (or the
// `sensitive` sentinel) is stored with the branch's depth. So the weekly job
// never needs conversation text.
//
// What it never does:
// - see anything but that one message: not earlier messages of the branch
//   (which may have been on personal credit or the user's key), not the reply;
// - store or log text: the message lives only in the classifier request, the
//   tag row has no text column, rejected output is counted, not logged;
// - run for a conversation the pool didn't fund (the caller checks; this
//   checks again);
// - fail the send: it runs after the reply, in the background, and gives up
//   silently (an empty pool refuses the reservation; the exchange still counts
//   in the totals).
//
// The call is charged to the pool through the same reserve/settle flow as any
// pool call (`purpose: 'tagging'`, PLAN §5): the meter of
// `poolGeneratingRegistry` reserves its exact worst case on PoolBank, which
// counts tagging toward no one's caps or rate limits.
import type { ProviderRegistry } from '@tangent/shared';
import { appConfig } from '../config.js';
import { createD1Repositories } from '../db/d1-repositories.js';
import { isPoolFunded, type AccountContext, type AppEnv } from '../env.js';
import { poolGeneratingRegistry, type Defer } from '../services.js';
import { BUILT_IN_PROVIDER_ID } from '../simple-mode.js';
import { isSensitive, isValidLeafTopicId, LEAF_TOPIC_IDS, SENSITIVE_TOPIC_ID } from './taxonomy.js';

/** The pool exchange to classify. */
export interface PoolExchange {
  treeId: string;
  branchId: string;
  /**
   * The user message of the pool exchange that just completed
   * (`BeginSendResult.userNode.content` of a pool-funded run), and nothing else.
   */
  poolExchangeUserMessage: string;
  /** Keeps the meter's background settlement alive (`ctx.waitUntil`). */
  defer: Defer;
}

/** Test seams; production uses the defaults. */
export interface TaggingOptions {
  /** The unmetered provider registry (the pool's config of the built-in provider). */
  providers?: ProviderRegistry;
  now?: Date;
}

/**
 * What became of a classification: `tagged`; `exists` (the branch already
 * had a tag); `rejected` (the classifier answered something other than a leaf
 * id); `skipped` (not pool-funded, or the branch is gone); `failed` (the call
 * failed or the pool refused it).
 */
export type TagOutcome = 'tagged' | 'exists' | 'rejected' | 'skipped' | 'failed';

/** The classifier's instructions: the leaf ids, and nothing to echo back. */
export const CLASSIFIER_SYSTEM_PROMPT = [
  "You sort a learner's question into one topic of a fixed list.",
  'Answer with exactly one topic id from the list below and nothing else: no explanation, no punctuation, no quotes.',
  'If no topic fits, answer general.other. Never repeat or quote the question.',
  '',
  'Topic ids:',
  ...LEAF_TOPIC_IDS,
].join('\n');

function logOutcome(outcome: TagOutcome, extra: Record<string, unknown> = {}): void {
  // Counters only: never the message or the classifier's output.
  const line = JSON.stringify({ event: 'pool_tag', outcome, ...extra });
  if (outcome === 'tagged' || outcome === 'exists') console.log(line);
  else console.warn(line);
}

/**
 * Classifies the user message of a completed pool exchange and stores the
 * branch's topic (the first tag of a branch wins: `ON CONFLICT DO NOTHING`).
 * Never throws.
 */
export async function classifyPoolExchange(
  env: AppEnv,
  account: AccountContext,
  exchange: PoolExchange,
  options: TaggingOptions = {},
): Promise<TagOutcome> {
  try {
    if (!isPoolFunded(account) || !account.userId) return 'skipped';
    const existing = await env.DB.prepare('SELECT 1 AS ok FROM pool_topic_tags WHERE branch_id = ?')
      .bind(exchange.branchId)
      .first<{ ok: number }>();
    if (existing) return 'exists';

    const impact = appConfig(env).impact;
    const providers = poolGeneratingRegistry(env, account, exchange.defer, options.providers);
    const provider = providers.get(BUILT_IN_PROVIDER_ID);
    if (!provider) {
      logOutcome('failed', { reason: 'no_provider' });
      return 'failed';
    }
    let output = '';
    let failed: string | null = null;
    for await (const event of provider.stream({
      model: account.pool.model,
      system: CLASSIFIER_SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: exchange.poolExchangeUserMessage.slice(0, impact.classifierInputChars),
        },
      ],
      maxOutputTokens: impact.classifierMaxOutputTokens,
      // Nobody waits on the classifier; the pool meter bounds the call with
      // `pool.callTimeoutMs`, like every pool call.
      signal: new AbortController().signal,
      usageTag: {
        purpose: 'tagging',
        treeId: exchange.treeId,
        branchId: exchange.branchId,
        nodeId: null,
      },
    })) {
      if (event.type === 'delta') output += event.text;
      else if (event.type === 'error') failed = event.error.code;
    }
    if (failed !== null) {
      logOutcome('failed', { reason: failed });
      return 'failed';
    }

    const topicId = output.trim();
    if (!isValidLeafTopicId(topicId)) {
      logOutcome('rejected');
      return 'rejected';
    }

    const chain = await createD1Repositories(env.DB).trees.getBranchChain(exchange.branchId);
    if (chain.length === 0) return 'skipped';
    const stored = isSensitive(topicId) ? SENSITIVE_TOPIC_ID : topicId;
    await env.DB.prepare(
      `INSERT INTO pool_topic_tags (branch_id, topic_id, branch_depth, created_at)
       VALUES (?, ?, ?, ?) ON CONFLICT(branch_id) DO NOTHING`,
    )
      .bind(exchange.branchId, stored, chain.length - 1, (options.now ?? new Date()).toISOString())
      .run();
    logOutcome('tagged');
    return 'tagged';
  } catch (err) {
    // An Error's message here comes from D1 or the meter, never from the conversation.
    logOutcome('failed', { reason: err instanceof Error ? err.name : 'unknown' });
    return 'failed';
  }
}
