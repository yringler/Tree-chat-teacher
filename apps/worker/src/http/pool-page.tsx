import {
  formatBps,
  formatMicros,
  POOL_EMPTY_TEXT,
  POOL_FUNDING_TEXT,
  poolModelDifferences,
  type PoolModelInfo,
  roughWords,
} from '@tangent/shared';
import { Hono } from 'hono';
import { creditSold } from '../availability.js';
import { membershipRequired } from '../billing/membership.js';
import { appConfig, type PoolDailyCaps, type PoolGlobalCap } from '../config.js';
import type { AppBindings, AppEnv } from '../env.js';
import { modelPrice } from '../pool/price-table.js';
import { POOL_SESSION_ESTIMATE_MICROS, poolModel } from '../pool/params.js';
import { ceilingHoldMicros } from '../pool/pricing.js';
import { poolModelInfo } from '../pool/status.js';
import { joinList } from './copy.js';
import { docResponse } from './legal.js';
import { legalInfo, type LegalInfo } from './legal-info.js';

/**
 * `/pool`: how the open pool works (the transparency page). A static,
 * script-free page like the legal pages, whose numbers (model, caps) come
 * from the config module, so it always describes what this deployment does.
 * The pool is free credit Tangent provides (the operator's admin
 * adjustments): nothing on the page offers pool credit for sale, and it
 * never calls the pool a donation.
 */

/** Everything the page states, resolved from the config (one place, for the tests too). */
export interface PoolPageFacts {
  enabled: boolean;
  /** The pool's model and how it is asked against the tier that runs it (`poolModelInfo`). */
  model: PoolModelInfo;
  sessionEstimateMicros: number;
  maxOutputTokens: number;
  /** Each learner's daily caps: the same for everyone, member or not. */
  user: PoolDailyCaps;
  /** The yearly membership is sold and required here (`membershipRequired`): Tangent sells it. */
  membershipOffered: boolean;
  /** Prepaid credit is sold here (`creditSold`): a learner can buy their own. */
  creditSold: boolean;
  /** All learners together, per day. */
  global: PoolGlobalCap;
  ip: PoolDailyCaps;
  perMinute: number;
  /** The reply's ceiling hold: the part of a daily spend cap that can't start one more reply. */
  ceilingHoldMicros: number | null;
}

export async function poolPageFacts(env: AppEnv): Promise<PoolPageFacts> {
  const config = appConfig(env);
  const pool = config.pool;
  const price = await modelPrice(env, poolModel(env));
  return {
    enabled: config.flags.poolEnabled,
    model: poolModelInfo(env),
    sessionEstimateMicros: POOL_SESSION_ESTIMATE_MICROS,
    maxOutputTokens: pool.maxOutputTokens,
    user: pool.caps.user,
    membershipOffered: membershipRequired(env),
    creditSold: creditSold(env),
    global: pool.caps.global,
    ip: pool.caps.ip,
    perMinute: pool.limits.userPerMinute,
    ceilingHoldMicros: price
      ? ceilingHoldMicros(
          price,
          pool.maxInputTokens,
          pool.maxOutputTokens,
          config.billing.openRouterFeeBps,
        )
      : null,
  };
}

/** `$0.10` from a cent up; `1.4¢` below a cent. */
function smallMoney(micros: number): string {
  if (micros >= 10_000) return formatMicros(micros);
  return `${Number((micros / 10_000).toFixed(1))}¢`;
}

function PoolPage(props: { info: LegalInfo; facts: PoolPageFacts }) {
  const { info, facts: f } = props;
  // The reply cap is stated next to it, so only the thinking is named here.
  const asked = poolModelDifferences(f.model, { replies: false });
  // What Tangent sells here, if anything.
  const sold = joinList(
    [f.membershipOffered && 'memberships', f.creditSold && 'credit'].filter(
      (x): x is string => typeof x === 'string',
    ),
    'and',
  );
  const ownKey = `use your own OpenRouter key${f.membershipOffered ? ' (with a membership)' : ''}`;
  const hold = f.ceilingHoldMicros === null ? null : smallMoney(f.ceilingHoldMicros);
  return (
    <>
      <h1>The open pool: how Tangent keeps learning free</h1>
      <div class="summary">
        <p>
          <strong>The short version.</strong> {POOL_FUNDING_TEXT} Any signed-in learner can use it
          in Tangent Learn, on one economical model, within daily limits.
        </p>
      </div>
      <h2>Why it exists</h2>
      <p>
        Good AI tutoring costs real money for every reply, so most of it sits behind a paywall.{' '}
        {sold
          ? `Tangent charges for ${sold} like any software business, and keeps the pool open for anyone who wants to learn. Paying for Tangent pays for Tangent; the pool is Tangent’s own decision, within daily limits and while it has credit.`
          : 'Tangent keeps the pool open for anyone who wants to learn. It is Tangent’s own decision, within daily limits and while it has credit.'}
      </p>
      {!f.enabled && <p class="updated">The open pool isn’t running on this server yet.</p>}
      <h2>Where the credit comes from</h2>
      <p>Pool credit isn't sold. Tangent adds it, at its discretion.</p>

      <h2>How it works</h2>
      <ul>
        <li>
          Any signed-in learner can use the pool in Tangent Learn. When your own credit runs out,
          Learn uses the pool. When you have both, you choose with the{' '}
          <strong>Pay for replies with</strong> switch above the message box.
        </li>
        <li>
          The pool can never go below zero. Every reply sets aside its worst-case cost first, and is
          refused if the pool can't cover it.
        </li>
        <li>
          When it runs out, Learn says so: "{POOL_EMPTY_TEXT}" Your message is kept, and you can{' '}
          {f.creditSold ? `buy credit for yourself instead, or ${ownKey}` : `${ownKey} instead`}.
        </li>
        <li>
          The meter shows about how many learning sessions the pool still covers, counting{' '}
          {formatMicros(f.sessionEstimateMicros)} per session, next to the amount in dollars. Those
          are totals only; no one's name or questions are shown.
        </li>
      </ul>

      <h2>What a reply costs</h2>
      <p>
        Each reply is paid from the pool at the AI provider's price (including the provider's
        credit-purchase fee), with no markup, and costs the learner nothing. Tangent earns nothing
        on the pool.
      </p>

      <h2>Which model pool learners get</h2>
      <p>
        Every reply on the pool uses{' '}
        {asked.length === 0 ? f.model.label : `${f.model.label}'s model`} (<code>{f.model.id}</code>
        ){asked.length > 0 && ` with ${asked.join(' and ')}`}, a fixed teaching prompt, replies of
        at most {f.maxOutputTokens.toLocaleString('en-US')} tokens (roughly{' '}
        {roughWords(f.maxOutputTokens)} words) and a capped amount of earlier conversation. You
        can't choose another model or prompt on the pool: that keeps it a learning tool and keeps
        each reply cheap. Reviews and web search aren't available on the pool either.
      </p>

      <h2>Why there are limits</h2>
      <p>
        A shared pool only works if no one person or script can drain it. So the pool is good for
        learning and poor as a free general-purpose AI service:
      </p>
      <table>
        <thead>
          <tr>
            <th>Limit</th>
            <th>Value</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>Replies per learner per day</td>
            <td>{f.user.requestsPerDay.toLocaleString('en-US')}</td>
          </tr>
          <tr>
            <td>Spending per learner per day</td>
            <td>{formatMicros(f.user.spendMicrosPerDay)}</td>
          </tr>
          <tr>
            <td>Replies per minute</td>
            <td>{f.perMinute.toLocaleString('en-US')}</td>
          </tr>
          <tr>
            <td>Per network per day</td>
            <td>
              {f.ip.requestsPerDay.toLocaleString('en-US')} replies,{' '}
              {formatMicros(f.ip.spendMicrosPerDay)}
            </td>
          </tr>
          <tr>
            <td>All learners together, per day</td>
            <td>
              {formatMicros(f.global.spendMicrosPerDay)} or{' '}
              {formatBps(f.global.bpsOfMorningBalance)} of the pool at 00:00 UTC plus what's added
              that day, whichever is lower
            </td>
          </tr>
        </tbody>
      </table>
      <p>
        The limits are the same for everyone: a membership or credit of your own doesn’t change
        them. Daily limits reset at 00:00 UTC. The last one keeps a busy day from emptying the pool
        before later learners that day get to use it; credit added during the day counts toward it
        straight away. Using the pool needs a signed-in account that passed a quick human check, and
        one account per email address.
      </p>
      {hold && (
        <p>
          Before a reply starts, the pool sets aside what the longest possible reply could cost
          (about {hold}) and settles the real cost when it ends. So the last {hold} or so of a daily
          spending limit can't start a new reply.
        </p>
      )}
      <h2>Questions</h2>
      <p>
        For questions about the pool, or to arrange something with {info.operator} directly, email{' '}
        <a href={`mailto:${info.contactEmail}`}>{info.contactEmail}</a>.
      </p>

      <h2>More</h2>
      <p>
        The pool is covered by the <a href="/terms">terms of service</a> (section 7), and the{' '}
        <a href="/privacy">privacy policy</a> describes what is stored about pool use.
      </p>
    </>
  );
}

/** `GET /pool`, public (mounted at the root by `createApp`; listed in run_worker_first). */
export function poolPageRoutes(): Hono<AppBindings> {
  const app = new Hono<AppBindings>();
  app.get('/pool', async (c) => {
    const info = legalInfo(c.env, c.req.raw);
    const facts = await poolPageFacts(c.env);
    return docResponse(info, '/pool', 'The open pool', <PoolPage info={info} facts={facts} />);
  });
  return app;
}
