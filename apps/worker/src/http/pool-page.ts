import { escapeHtml } from '@tangent/render';
import {
  formatBps,
  formatMicros,
  POOL_EMPTY_TEXT,
  POOL_IMPACT_WEEK_PATTERN,
  poolFundingText,
  poolImpactWeekText,
  type PoolImpactResponse,
} from '@tangent/shared';
import { Hono } from 'hono';
import { membershipRequired } from '../billing/membership.js';
import { appConfig, type PoolGlobalCap } from '../config.js';
import type { AppBindings, AppEnv } from '../env.js';
import { poolImpactWeeks, readPoolImpact } from '../pool/impact.js';
import { modelPrice } from '../pool/model-prices.js';
import { poolModel } from '../pool/params.js';
import { ceilingHoldMicros } from '../pool/pricing.js';
import { poolContributions } from '../pool/revenue-share.js';
import { weekStart } from '../pool/status.js';
import { simpleProviderConfig } from '../simple-mode.js';
import { renderImpactBlock } from './impact-block.js';
import { legalInfo, type LegalInfo } from './legal-info.js';
import { legalResponse, page } from './legal.js';

/**
 * `/pool`: how the open pool works (spec §8, transparency page). A
 * static, script-free page like the legal pages, whose numbers (revenue
 * share, model, caps) come from the config module, so it always describes
 * what this deployment does. The pool is free credit Tangent provides from
 * its revenue (pool/revenue-share.ts, docs/polar-migration/05-pool-framing.md):
 * nothing on the page offers pool credit for sale, and it never calls the
 * pool a donation.
 */

/** Everything the page states, resolved from the config (one place, for the tests too). */
export interface PoolPageFacts {
  enabled: boolean;
  model: { id: string; label: string };
  /** `POOL_REVENUE_SHARE_BPS`: the share of Tangent's revenue added to the pool. */
  revenueShareBps: number;
  sessionEstimateMicros: number;
  maxOutputTokens: number;
  free: { requestsPerDay: number; spendMicrosPerDay: number };
  member: { requestsPerDay: number; spendMicrosPerDay: number };
  /** The yearly membership is sold and required here (`membershipRequired`): members exist. */
  membershipOffered: boolean;
  globalFree: PoolGlobalCap;
  globalMember: PoolGlobalCap;
  ip: { requestsPerDay: number; spendMicrosPerDay: number };
  perMinute: number;
  /** The reply's ceiling hold: the part of a daily spend cap that can't start one more reply. */
  ceilingHoldMicros: number | null;
  /** Distinct learners a topic needs in a week to be named (`IMPACT_MIN_DISTINCT_USERS`). */
  minDistinctUsers: number;
  /** Days a topic tag outlives its branch's last pool use. */
  tagRetentionDays: number;
}

/**
 * The impact feed on `/pool`: the snapshot shown (the requested week's, else
 * the latest), the weeks to choose from (newest first), and the week asked
 * for with `?week=`, if any. Null when it couldn't be read (or the pool is off).
 */
export interface PoolPageFeed {
  requestedWeek: string | null;
  impact: PoolImpactResponse | null;
  weeks: string[];
}

export async function poolPageFacts(env: AppEnv): Promise<PoolPageFacts> {
  const config = appConfig(env);
  const pool = config.pool;
  const id = poolModel(env);
  const price = await modelPrice(env, id);
  return {
    enabled: config.flags.poolEnabled,
    model: { id, label: simpleProviderConfig(env).models.find((m) => m.id === id)?.label ?? id },
    revenueShareBps: pool.revenueShareBps,
    sessionEstimateMicros: pool.sessionEstimateMicros,
    maxOutputTokens: pool.maxOutputTokens,
    free: pool.caps.free,
    member: pool.caps.member,
    membershipOffered: membershipRequired(env),
    globalFree: pool.caps.globalFree,
    globalMember: pool.caps.globalMember,
    ip: pool.caps.ip,
    perMinute: pool.limits.userPerMinute,
    ceilingHoldMicros: price
      ? ceilingHoldMicros(price, pool.maxOutputTokens, config.billing.openRouterFeeBps)
      : null,
    minDistinctUsers: config.impact.minDistinctUsers,
    tagRetentionDays: config.impact.tagRetentionDays,
  };
}

/** "$5.00 or 20% of the pool at 00:00 UTC plus what's added that day, whichever is lower". */
function globalCapText(cap: PoolGlobalCap): string {
  return `${escapeHtml(formatMicros(cap.spendMicrosPerDay))} or ${escapeHtml(formatBps(cap.bpsOfMorningBalance))} of the pool at 00:00 UTC plus what's added that day, whichever is lower`;
}

/** The live part of "What the pool is funding": a snapshot and the week selector. */
function feedSection(feed: PoolPageFeed | null): string {
  if (!feed) return '';
  let shown: string;
  if (feed.requestedWeek && !feed.impact)
    shown = '<p class="impact-missing">No snapshot for that week.</p>';
  else if (!feed.impact)
    shown =
      '<p>The first weekly snapshot appears on the Monday after the pool’s first full week.</p>';
  else
    shown = `<h3>${escapeHtml(poolImpactWeekText(feed.impact.weekStart).replace(/^t/, 'T'))}</h3>\n${renderImpactBlock(feed.impact)}`;
  const current = feed.impact?.weekStart;
  const weeks = feed.weeks.length
    ? `<nav aria-label="Past weeks"><h3>Past weeks</h3><ul class="weeks">${feed.weeks
        .map((w) => {
          const label = escapeHtml(poolImpactWeekText(w).replace(/^the week of /, 'Week of '));
          return w === current
            ? `<li><a href="/pool?week=${w}#impact" aria-current="page">${label}</a></li>`
            : `<li><a href="/pool?week=${w}#impact">${label}</a></li>`;
        })
        .join('')}</ul></nav>`
    : '';
  return `${shown}\n${weeks}\n`;
}

/** `$0.10` from a cent up; `1.4¢` below a cent. */
function smallMoney(micros: number): string {
  if (micros >= 10_000) return formatMicros(micros);
  return `${Number((micros / 10_000).toFixed(1))}¢`;
}

/** Who is a member (billing/membership.ts `isMember`): a paid or waived yearly membership. */
function membersText(offered: boolean): string {
  if (!offered)
    return 'There is no membership here right now, so every learner gets the free limits.';
  return 'Anyone with a Tangent membership (yearly) is a member, and gets the higher limits above. Paid accounts are much harder to farm than free ones, so they get more room.';
}

/** Where the pool's credit comes from, in detail (the summary states the commitment). */
function sourcesText(revenueShareBps: number): string {
  if (revenueShareBps <= 0) return "Pool credit isn't sold. Tangent adds it, at its discretion.";
  const share = formatBps(revenueShareBps);
  return `Pool credit isn't sold. Tangent adds ${share} of each membership payment, after tax and the payment provider's fee, when the payment comes in, and once a day ${share} of the markup on the credit people used the day before (UTC). The markup is what Tangent earns on credit; buying credit adds nothing until it is used. If a membership payment is refunded, the same part of its share comes back out of the pool. Tangent may add more on top.`;
}

/** What the revenue share added recently, when it could be read. */
export interface PoolPageContributions {
  weekMicros: number;
  monthMicros: number;
}

export function renderPoolPage(
  info: LegalInfo,
  f: PoolPageFacts,
  feed: PoolPageFeed | null = null,
  contributions: PoolPageContributions | null = null,
): string {
  const model = `${escapeHtml(f.model.label)} (<code>${escapeHtml(f.model.id)}</code>)`;
  const ceiling =
    f.ceilingHoldMicros === null
      ? ''
      : `<p>Before a reply starts, the pool sets aside what the longest possible reply could cost (about ${escapeHtml(smallMoney(f.ceilingHoldMicros))}) and settles the real cost when it ends. So the last ${escapeHtml(smallMoney(f.ceilingHoldMicros))} or so of a daily spending limit can't start a new reply.</p>\n`;
  const added =
    contributions && f.revenueShareBps > 0
      ? `<p>So far Tangent’s revenue share has added ${escapeHtml(formatMicros(contributions.weekMicros))} to the pool this week (since Monday, UTC) and ${escapeHtml(formatMicros(contributions.monthMicros))} this month.</p>\n`
      : '';
  const contact = escapeHtml(info.contactEmail);
  return page(
    info,
    '/pool',
    'The open pool',
    `<h1>The open pool: how Tangent keeps learning free</h1>
<div class="summary">
<p><strong>The short version.</strong> ${escapeHtml(poolFundingText(f.revenueShareBps))} Any signed-in learner can use it in Tangent Learn, on one economical model, within daily limits.</p>
</div>
<h2>Why it exists</h2>
<p>Good AI tutoring costs real money for every reply, so most of it sits behind a paywall. Tangent charges for ${f.membershipOffered ? 'memberships and credit' : 'credit'} like any software business, and keeps a share of what it earns open for anyone who wants to learn. Paying for Tangent pays for Tangent; the pool is Tangent’s own decision, within daily limits and while it has credit.</p>
${f.enabled ? '' : '<p class="updated">The open pool isn’t running on this server yet.</p>\n'}
<h2>Where the credit comes from</h2>
<p>${escapeHtml(sourcesText(f.revenueShareBps))}</p>
${added}
<h2>How it works</h2>
<ul>
<li>Any signed-in learner can use the pool in Tangent Learn. When your own credit runs out, Learn uses the pool, and when you have both you choose with the switch above the message box.</li>
<li>The pool can never go below zero. Every reply sets aside its worst-case cost first, and is refused if the pool can't cover it.</li>
<li>When it runs out, Learn says so: "${escapeHtml(POOL_EMPTY_TEXT)}" Your message is kept, and you can buy credit for yourself or use your own OpenRouter key.</li>
<li>The meter shows about how many learning sessions the pool still covers, counting ${escapeHtml(formatMicros(f.sessionEstimateMicros))} per session, next to the amount in dollars and how many learners and exchanges it funded this week. Those are totals only; no one's name or questions are shown.</li>
</ul>

<h2>What a reply costs</h2>
<p>Each reply is paid from the pool at the AI provider's price (including the provider's credit-purchase fee), with no markup, and costs the learner nothing. Tangent earns nothing on the pool.</p>

<h2>Which model pool learners get</h2>
<p>Every reply on the pool uses ${model}, with a fixed teaching prompt, replies of at most ${f.maxOutputTokens.toLocaleString('en-US')} tokens and a capped amount of earlier conversation. Choosing another model or prompt isn't possible on the pool; that keeps it a learning tool and keeps each reply cheap. Reviews aren't available on the pool.</p>

<h2>Why there are limits</h2>
<p>A shared pool only works if no one person or script can drain it. So the pool is good for learning and poor as a free general-purpose AI service:</p>
<table>
<thead><tr><th>Limit</th><th>Value</th></tr></thead>
<tbody>
<tr><td>Replies per learner per day</td><td>${f.free.requestsPerDay.toLocaleString('en-US')} (members: ${f.member.requestsPerDay.toLocaleString('en-US')})</td></tr>
<tr><td>Spending per learner per day</td><td>${escapeHtml(formatMicros(f.free.spendMicrosPerDay))} (members: ${escapeHtml(formatMicros(f.member.spendMicrosPerDay))})</td></tr>
<tr><td>Replies per minute</td><td>${f.perMinute.toLocaleString('en-US')}</td></tr>
<tr><td>Per network per day</td><td>${f.ip.requestsPerDay.toLocaleString('en-US')} replies, ${escapeHtml(formatMicros(f.ip.spendMicrosPerDay))}</td></tr>
<tr><td>All non-members together, per day</td><td>${globalCapText(f.globalFree)}</td></tr>
<tr><td>All members together, per day</td><td>${globalCapText(f.globalMember)}</td></tr>
</tbody>
</table>
<p>Daily limits reset at 00:00 UTC. The last two keep a busy day from emptying the pool before later learners that day get to use it; credit added during the day counts toward them straight away. Using the pool needs a signed-in account that passed a quick human check, and one account per email address.</p>
${ceiling}
<h2>Members</h2>
<p>${escapeHtml(membersText(f.membershipOffered))}</p>

<h2 id="impact">What the pool is funding</h2>
<p>Every Monday, Tangent publishes what the pool funded the week before (Monday to Sunday, UTC): how many exchanges and learners, how many topics, and how deep learners went down their branches. These are totals only. No one's questions or name are ever shown, and a topic is named only when all of these hold:</p>
<ul>
<li>at least ${f.minDistinctUsers.toLocaleString('en-US')} different learners explored it that week (fewer only count toward the totals);</li>
<li>it isn't a sensitive subject: health, mental health, sexuality, legal matters, personal finances and religious doubt are counted but never named;</li>
<li>it isn't on the blocklist, and an administrator reviewed it the first time it qualified. After approval it appears automatically in later weeks.</li>
</ul>
<p>Topics come from a fixed list. After a pool reply, the pool's model sorts that one message into a topic; the message itself isn't stored, and the topic is kept without your name, then deleted ${f.tagRetentionDays.toLocaleString('en-US')} days after the conversation's last use of the pool. Pool learners acknowledge this before their first pool request. Conversations on your own credit or your own key are never sorted.</p>
${feedSection(feed)}
<h2>Questions</h2>
<p>For questions about the pool, or to arrange something with ${escapeHtml(info.operator)} directly, email <a href="mailto:${contact}">${contact}</a>.</p>

<h2>More</h2>
<p>The pool is covered by the <a href="/terms">terms of service</a> (section 7), and the <a href="/privacy">privacy policy</a> describes what is stored about pool use.</p>`,
  );
}

/** What the revenue share added this week and month; null while the pool is off or D1 can't be read. */
export async function poolPageContributions(
  env: AppEnv,
  now = new Date(),
): Promise<PoolPageContributions | null> {
  if (!appConfig(env).flags.poolEnabled) return null;
  try {
    return await poolContributions(env, now, weekStart(now));
  } catch (err) {
    console.warn('/pool: the revenue share could not be read', err);
    return null;
  }
}

/**
 * The impact feed for `/pool?week=…`: that week's snapshot (none for an
 * unknown or malformed week), else the latest, and the weeks to pick from.
 * Null while the pool is off or when D1 can't be read (the page still renders).
 */
export async function poolPageFeed(
  env: AppEnv,
  week: string | undefined,
): Promise<PoolPageFeed | null> {
  if (!appConfig(env).flags.poolEnabled) return null;
  const requestedWeek = week?.trim() || null;
  try {
    const valid = requestedWeek !== null && POOL_IMPACT_WEEK_PATTERN.test(requestedWeek);
    const [impact, weeks] = await Promise.all([
      requestedWeek === null || valid
        ? readPoolImpact(env.DB, requestedWeek ?? undefined)
        : Promise.resolve(null),
      poolImpactWeeks(env.DB),
    ]);
    return { requestedWeek, impact, weeks };
  } catch (err) {
    console.warn('/pool: the impact feed could not be read', err);
    return null;
  }
}

/** `GET /pool`, public (mounted at the root by `createApp`; listed in run_worker_first). */
export function poolPageRoutes(): Hono<AppBindings> {
  const app = new Hono<AppBindings>();
  app.get('/pool', async (c) =>
    legalResponse(
      c,
      renderPoolPage(
        legalInfo(c.env, c.req.raw),
        await poolPageFacts(c.env),
        await poolPageFeed(c.env, c.req.query('week')),
        await poolPageContributions(c.env),
      ),
    ),
  );
  return app;
}
