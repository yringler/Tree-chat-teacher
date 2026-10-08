import { escapeHtml } from '@tangent/render';
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
import { membershipRequired } from '../billing/membership.js';
import { appConfig, type PoolDailyCaps, type PoolGlobalCap } from '../config.js';
import type { AppBindings, AppEnv } from '../env.js';
import { modelPrice } from '../pool/model-prices.js';
import { poolModel } from '../pool/params.js';
import { ceilingHoldMicros } from '../pool/pricing.js';
import { poolModelInfo } from '../pool/status.js';
import { creditSold } from '../services.js';
import { joinList } from './landing.js';
import { legalInfo, type LegalInfo } from './legal-info.js';
import { legalResponse, page } from './legal.js';

/**
 * `/pool`: how the open pool works (spec §8, transparency page). A
 * static, script-free page like the legal pages, whose numbers (model, caps)
 * come from the config module, so it always describes what this deployment
 * does. The pool is free credit Tangent provides (admin adjustments,
 * docs/polar-migration/05-pool-framing.md): nothing on the page offers pool
 * credit for sale, and it never calls the pool a donation.
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
  const id = poolModel(env);
  const price = await modelPrice(env, id);
  return {
    enabled: config.flags.poolEnabled,
    model: poolModelInfo(env),
    sessionEstimateMicros: pool.sessionEstimateMicros,
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

/** "$5.00 or 20% of the pool at 00:00 UTC plus what's added that day, whichever is lower". */
function globalCapText(cap: PoolGlobalCap): string {
  return `${escapeHtml(formatMicros(cap.spendMicrosPerDay))} or ${escapeHtml(formatBps(cap.bpsOfMorningBalance))} of the pool at 00:00 UTC plus what's added that day, whichever is lower`;
}

/** `$0.10` from a cent up; `1.4¢` below a cent. */
function smallMoney(micros: number): string {
  if (micros >= 10_000) return formatMicros(micros);
  return `${Number((micros / 10_000).toFixed(1))}¢`;
}

export function renderPoolPage(info: LegalInfo, f: PoolPageFacts): string {
  // The reply cap is stated next to it, so only the thinking is named here.
  const asked = poolModelDifferences(f.model, { replies: false });
  const model =
    asked.length === 0
      ? `${escapeHtml(f.model.label)} (<code>${escapeHtml(f.model.id)}</code>)`
      : `${escapeHtml(f.model.label)}'s model (<code>${escapeHtml(f.model.id)}</code>) with ${escapeHtml(asked.join(' and '))}`;
  const ceiling =
    f.ceilingHoldMicros === null
      ? ''
      : `<p>Before a reply starts, the pool sets aside what the longest possible reply could cost (about ${escapeHtml(smallMoney(f.ceilingHoldMicros))}) and settles the real cost when it ends. So the last ${escapeHtml(smallMoney(f.ceilingHoldMicros))} or so of a daily spending limit can't start a new reply.</p>\n`;
  const contact = escapeHtml(info.contactEmail);
  // What Tangent sells here, if anything.
  const sold = joinList(
    [f.membershipOffered && 'memberships', f.creditSold && 'credit'].filter(
      (x): x is string => typeof x === 'string',
    ),
    'and',
  );
  const why = sold
    ? `Tangent charges for ${sold} like any software business, and keeps the pool open for anyone who wants to learn. Paying for Tangent pays for Tangent; the pool is Tangent’s own decision, within daily limits and while it has credit.`
    : 'Tangent keeps the pool open for anyone who wants to learn. It is Tangent’s own decision, within daily limits and while it has credit.';
  const ownKey = `use your own OpenRouter key${f.membershipOffered ? ' (with a membership)' : ''}`;
  const instead = f.creditSold
    ? `buy credit for yourself instead, or ${ownKey}`
    : `${ownKey} instead`;
  return page(
    info,
    '/pool',
    'The open pool',
    `<h1>The open pool: how Tangent keeps learning free</h1>
<div class="summary">
<p><strong>The short version.</strong> ${escapeHtml(POOL_FUNDING_TEXT)} Any signed-in learner can use it in Tangent Learn, on one economical model, within daily limits.</p>
</div>
<h2>Why it exists</h2>
<p>Good AI tutoring costs real money for every reply, so most of it sits behind a paywall. ${why}</p>
${f.enabled ? '' : '<p class="updated">The open pool isn’t running on this server yet.</p>\n'}
<h2>Where the credit comes from</h2>
<p>Pool credit isn't sold. Tangent adds it, at its discretion.</p>

<h2>How it works</h2>
<ul>
<li>Any signed-in learner can use the pool in Tangent Learn. When your own credit runs out, Learn uses the pool. When you have both, you choose with the <strong>Pay for replies with</strong> switch above the message box.</li>
<li>The pool can never go below zero. Every reply sets aside its worst-case cost first, and is refused if the pool can't cover it.</li>
<li>When it runs out, Learn says so: "${escapeHtml(POOL_EMPTY_TEXT)}" Your message is kept, and you can ${instead}.</li>
<li>The meter shows about how many learning sessions the pool still covers, counting ${escapeHtml(formatMicros(f.sessionEstimateMicros))} per session, next to the amount in dollars. Those are totals only; no one's name or questions are shown.</li>
</ul>

<h2>What a reply costs</h2>
<p>Each reply is paid from the pool at the AI provider's price (including the provider's credit-purchase fee), with no markup, and costs the learner nothing. Tangent earns nothing on the pool.</p>

<h2>Which model pool learners get</h2>
<p>Every reply on the pool uses ${model}, a fixed teaching prompt, replies of at most ${f.maxOutputTokens.toLocaleString('en-US')} tokens (roughly ${roughWords(f.maxOutputTokens)} words) and a capped amount of earlier conversation. You can't choose another model or prompt on the pool: that keeps it a learning tool and keeps each reply cheap. Reviews and web search aren't available on the pool either.</p>

<h2>Why there are limits</h2>
<p>A shared pool only works if no one person or script can drain it. So the pool is good for learning and poor as a free general-purpose AI service:</p>
<table>
<thead><tr><th>Limit</th><th>Value</th></tr></thead>
<tbody>
<tr><td>Replies per learner per day</td><td>${f.user.requestsPerDay.toLocaleString('en-US')}</td></tr>
<tr><td>Spending per learner per day</td><td>${escapeHtml(formatMicros(f.user.spendMicrosPerDay))}</td></tr>
<tr><td>Replies per minute</td><td>${f.perMinute.toLocaleString('en-US')}</td></tr>
<tr><td>Per network per day</td><td>${f.ip.requestsPerDay.toLocaleString('en-US')} replies, ${escapeHtml(formatMicros(f.ip.spendMicrosPerDay))}</td></tr>
<tr><td>All learners together, per day</td><td>${globalCapText(f.global)}</td></tr>
</tbody>
</table>
<p>The limits are the same for everyone: a membership or credit of your own doesn’t change them. Daily limits reset at 00:00 UTC. The last one keeps a busy day from emptying the pool before later learners that day get to use it; credit added during the day counts toward it straight away. Using the pool needs a signed-in account that passed a quick human check, and one account per email address.</p>
${ceiling}
<h2>Questions</h2>
<p>For questions about the pool, or to arrange something with ${escapeHtml(info.operator)} directly, email <a href="mailto:${contact}">${contact}</a>.</p>

<h2>More</h2>
<p>The pool is covered by the <a href="/terms">terms of service</a> (section 7), and the <a href="/privacy">privacy policy</a> describes what is stored about pool use.</p>`,
  );
}

/** `GET /pool`, public (mounted at the root by `createApp`; listed in run_worker_first). */
export function poolPageRoutes(): Hono<AppBindings> {
  const app = new Hono<AppBindings>();
  app.get('/pool', async (c) =>
    legalResponse(c, renderPoolPage(legalInfo(c.env, c.req.raw), await poolPageFacts(c.env))),
  );
  return app;
}
