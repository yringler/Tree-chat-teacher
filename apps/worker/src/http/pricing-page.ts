import { escapeHtml } from '@tangent/render';
import {
  formatBps,
  formatCents,
  formatMicros,
  LEARN_KEY_PROVIDER,
  MAX_TOP_UP_CENTS,
  MIN_TOP_UP_CENTS,
  POOL_MOTTO,
  poolFundingText,
} from '@tangent/shared';
import type { GroundingPolicy } from '@tangent/core';
import { Hono, type Context } from 'hono';
import { groundingDailyCap, groundingPolicy } from '../billing/grounding.js';
import { membershipCreditCents, membershipRequired } from '../billing/membership.js';
import { appConfig, type PoolDailyCaps } from '../config.js';
import type { AppBindings, AppEnv } from '../env.js';
import { poolModel } from '../pool/params.js';
import { cachedPoolStatus } from '../pool/status.js';
import { waitUntilOf } from '../routes/pool.js';
import { creditSold, ownKeyProviders, poolAvailable } from '../services.js';
import { learnOffer, simpleProviderConfig, type LearnOffer } from '../simple-mode.js';
import { joinList, LANDING_STYLE, MARK, poolStepsHtml, roughWords, styleCsp } from './landing.js';
import { copyrightNotice, legalInfo, type LegalInfo } from './legal-info.js';

/**
 * `/pricing`: what each way to pay gets you, as a pricing chart. Plan cards up
 * top say it in a line or two, a comparison table spells it out row by row,
 * and numbered notes under the table carry the fine print (fees, tax, limits,
 * what needs a membership). Static and script-free like the landing page, and
 * every number but the pool's balance comes from the config, so it describes
 * what this deployment actually sells, one column each: Free always (the open
 * pool, and the user's own keys while no membership is required); Pay as you
 * go while credit is sold (`creditSold`), which anyone may buy, member or not;
 * Your own key while the membership is required (`membershipRequired`), which
 * own keys need in Learn and power mode alike. The open pool has the same
 * limits for everyone, so every column shows the same pool line. The pool is
 * free credit Tangent provides; nothing here offers it for sale or calls it a
 * donation. Each pool line on the plan cards says the replies last only while
 * the pool has credit, with its balance from the landing page's cached meter.
 */

/** Everything the page states, resolved from the config (one place, for the tests too). */
export interface PricingFacts {
  /** The open pool, while Learn may spend from it (`poolAvailable`). */
  pool: {
    modelId: string;
    modelLabel: string;
    revenueShareBps: number;
    maxOutputTokens: number;
    /** Each learner's daily caps, the same for everyone. */
    caps: PoolDailyCaps;
    /** What the pool can spend right now (the meter's `availableMicros`); null when it couldn't be read. */
    availableMicros: number | null;
  } | null;
  /** Prepaid credit, while it is sold: the built-in provider is offered and the payment provider sells top-ups. */
  credit: {
    markupBps: number;
    openRouterFeeBps: number;
    /** The built-in provider is OpenRouter: credit takes any OpenRouter model, at OpenRouter's prices. */
    openRouter: boolean;
    minTopUpCents: number;
    maxTopUpCents: number;
  } | null;
  /** The yearly membership, while it is required (`membershipRequired`): what own keys need. */
  membership: { priceCents: number; includedCreditCents: number } | null;
  /** The `GROUNDING` ceiling, or `off` when Learn's provider can't search (`LearnOffer.search`). */
  grounding: GroundingPolicy;
  /** A search costs about 1¢ (`LearnOffer.searchAboutOneCent`). */
  searchAboutOneCent: boolean;
  /** Learn's models, the default first (`LearnOffer.tiers`); fewer than two = no choice of tier. */
  tiers: LearnOffer['tiers'];
  /** Automatic web searches a user may run per UTC day on credit (`GROUNDING_AUTO_DAILY_CAP`); 0 = no cap. */
  searchDailyCap: number;
  /** Who power mode takes the user's own keys for, and which can search (`ownKeyProviders`); empty when unknown. */
  providers: { id: string; label: string; search: boolean }[];
  /** Share links are offered to everyone (`LegalInfo.sharing`). */
  sharing: boolean;
}

export function pricingFacts(
  env: AppEnv,
  sharing: boolean,
  poolAvailableMicros: number | null = null,
): PricingFacts {
  const config = appConfig(env);
  const poolId = poolModel(env);
  const offer = learnOffer(env);
  return {
    pool: poolAvailable(env)
      ? {
          modelId: poolId,
          modelLabel:
            simpleProviderConfig(env).models.find((m) => m.id === poolId)?.label ?? poolId,
          revenueShareBps: config.pool.revenueShareBps,
          maxOutputTokens: config.pool.maxOutputTokens,
          caps: config.pool.caps.user,
          availableMicros: poolAvailableMicros,
        }
      : null,
    credit: creditSold(env)
      ? {
          markupBps: config.billing.markupBps,
          openRouterFeeBps: config.billing.openRouterFeeBps,
          openRouter: offer?.openRouter ?? false,
          minTopUpCents: MIN_TOP_UP_CENTS,
          maxTopUpCents: MAX_TOP_UP_CENTS,
        }
      : null,
    membership: membershipRequired(env)
      ? {
          priceCents: config.billing.membershipPriceCents,
          includedCreditCents: membershipCreditCents(env),
        }
      : null,
    grounding: offer?.search ? groundingPolicy(env) : 'off',
    searchAboutOneCent: offer?.searchAboutOneCent ?? false,
    tiers: offer?.tiers ?? [],
    searchDailyCap: groundingDailyCap(env),
    providers: ownKeyProviders(env),
    sharing,
  };
}

/** Extra rules for the plan cards and the chart, on top of the landing page's stylesheet. Hashed for the CSP. */
export const PRICING_STYLE =
  LANDING_STYLE +
  `
.intro{padding-top:24px;padding-bottom:40px}
.intro .lede{max-width:40rem}
.why{padding-bottom:56px}
.why .sub{max-width:40rem}
.plans{display:grid;gap:16px;padding-bottom:56px}
.plan{display:flex;flex-direction:column;padding:24px;border:1px solid var(--border);border-radius:14px;background:var(--bg-elev)}
.plan.featured{border-color:var(--accent);box-shadow:var(--shadow)}
.plan h3{margin:0;font-size:1.15rem}
.plan .price{margin:12px 0 6px;font-size:2.1rem;font-weight:700;line-height:1.15;letter-spacing:-.02em}
.plan .price small{color:var(--muted);font-size:1rem;font-weight:500;letter-spacing:0}
.plan .for{margin:0 0 16px;color:var(--muted)}
.plan ul{margin:0 0 24px;padding:0 0 0 18px;font-size:.95rem}
.plan li{margin:0 0 6px}
.plan li::marker{color:var(--accent)}
.plan .btn{align-self:flex-start;margin-top:auto}
.plan .while{display:block;width:fit-content;margin-top:6px;padding:3px 10px;border:1px solid var(--accent);border-radius:999px;background:var(--accent-soft);font-size:.82rem;font-weight:600}
.chart{overflow-x:auto;border:1px solid var(--border);border-radius:14px;background:var(--bg-elev)}
.chart table{width:100%;border-collapse:collapse;font-size:.92rem}
.chart th,.chart td{padding:10px 14px;border-bottom:1px solid var(--border);text-align:left;vertical-align:top}
.chart thead>tr>*{background:var(--bg-sunken);font-size:.95rem}
.chart thead th,.chart td{width:30%;text-align:center}
.chart tbody th{font-weight:500}
.chart .group th{padding-top:20px;color:var(--muted);font-size:.75rem;font-weight:700;letter-spacing:.06em;text-transform:uppercase}
.chart tbody tr:last-child>*{border-bottom:0}
.chart .yes{color:var(--accent)}
.chart .no{color:var(--muted)}
sup.fn{margin-left:1px;font-size:.72em;line-height:0}
sup.fn a{font-weight:600;text-decoration:none}
.plan .price sup.fn{font-size:.8rem}
.notes h3{margin:32px 0 8px;font-size:1rem}
.notes ol{margin:0;padding-left:22px;color:var(--muted);font-size:.9rem}
.notes li{margin:0 0 10px}
.notes li:target{color:var(--fg)}
.notes .back{text-decoration:none}
.sr-only{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}
@media (max-width:479px){.chart th,.chart td{padding:8px 10px}.chart thead th,.chart td{width:24%}}
@media (min-width:720px){.plans.two{grid-template-columns:1fr 1fr}.plans.one{max-width:30rem}}
@media (min-width:960px){.plans.three{grid-template-columns:1fr 1fr 1fr}}
@media (min-width:720px) and (max-width:959px){.plans.three{grid-template-columns:1fr 1fr}}
`;

type NoteId = 'pool' | 'own-key' | 'credit' | 'top-up' | 'membership' | 'power-read' | 'search';

/**
 * Numbered notes, numbered in the order the page first cites them (so build
 * the page top to bottom). The first citation of a note carries the anchor its
 * back link returns to; a note never cited isn't listed.
 */
function footnotes(texts: Partial<Record<NoteId, string>>) {
  const cited: NoteId[] = [];
  return {
    ref(id: NoteId): string {
      if (texts[id] === undefined) throw new Error(`pricing: no text for note ${id}`);
      const seen = cited.includes(id);
      if (!seen) cited.push(id);
      const n = cited.indexOf(id) + 1;
      return `<sup class="fn"><a href="#note-${id}"${seen ? '' : ` id="ref-${id}"`} aria-label="Note ${n}">${n}</a></sup>`;
    },
    list(): string {
      return cited
        .map(
          (id) =>
            `<li id="note-${id}">${texts[id]!} <a class="back" href="#ref-${id}" aria-label="Back to the text">↩</a></li>`,
        )
        .join('\n');
    },
  };
}

/** The power-mode providers other than Learn's (OpenRouter), as `Anthropic and OpenAI`; '' when none or unknown. */
function otherProviders(f: PricingFacts): string {
  return escapeHtml(
    joinList(
      f.providers.filter((p) => p.id !== LEARN_KEY_PROVIDER).map((p) => p.label),
      'and',
    ),
  );
}

/** The power-mode providers that can't search the web, as `Anthropic or OpenAI`; '' when every one can. */
function nonSearchProviders(f: PricingFacts): string {
  return escapeHtml(
    joinList(
      f.providers.filter((p) => !p.search).map((p) => p.label),
      'or',
    ),
  );
}

/** What the reader pays per 1¢ of the provider's price on credit: `1.16` for a 5.5% fee and a 10% markup. */
function perCent(credit: NonNullable<PricingFacts['credit']>): string {
  return (((10_000 + credit.openRouterFeeBps) * (10_000 + credit.markupBps)) / 1e8).toFixed(2);
}

/** The notes' fine print, for the features this deployment offers. */
function noteTexts(f: PricingFacts): Partial<Record<NoteId, string>> {
  const { pool, credit, membership } = f;
  const searches = f.grounding !== 'off';
  const others = otherProviders(f);
  const texts: Partial<Record<NoteId, string>> = {
    'own-key': `With your own key, the AI provider bills you directly, at its own prices, and Tangent adds nothing to that bill. Learn takes an OpenRouter key${searches ? ', which also works for web search' : ''}${others ? `; power mode also takes ${others} keys` : ''}.${membership ? ' Your own keys need the membership, in Learn and in power mode alike.' : ''}`,
  };
  if (pool) {
    texts.pool = `${escapeHtml(poolFundingText(pool.revenueShareBps))} Pool replies use the ${escapeHtml(pool.modelLabel)} model, are at most ${pool.maxOutputTokens.toLocaleString('en-US')} tokens long (roughly ${roughWords(pool.maxOutputTokens)} words) and don’t search the web. While the pool has credit, each learner can use up to ${pool.caps.requestsPerDay.toLocaleString('en-US')} replies or ${escapeHtml(formatMicros(pool.caps.spendMicrosPerDay))} of AI cost a day, whichever comes first. The limits are the same for everyone, whatever else they pay for, and reset at 00:00 UTC. You need to be signed in and pass a quick check that you’re human, with one account per email address. <a href="/pool">How the pool works, with every limit</a>.`;
  }
  if (credit) {
    const share =
      pool && pool.revenueShareBps > 0
        ? ` Tangent puts ${escapeHtml(formatBps(pool.revenueShareBps))} of its markup into the open pool as credit is used.`
        : '';
    // Credit runs on the built-in provider: OpenRouter unless the operator points it elsewhere.
    const via = credit.openRouter ? 'OpenRouter' : 'the AI provider';
    const fee =
      credit.openRouterFeeBps > 0
        ? ` plus the ${escapeHtml(formatBps(credit.openRouterFeeBps))} fee ${via} charges on credit purchases`
        : '';
    texts.credit = `You pay what each reply costs Tangent, plus Tangent’s ${escapeHtml(formatBps(credit.markupBps))} markup. Tangent’s cost is ${via}’s price${fee}. So for every 1¢ ${via} charges, you pay about ${perCent(credit)}¢. Summaries and titles made on credit are charged the same way, and your billing page lists every charge.${share}`;
    texts['top-up'] =
      `Top up ${escapeHtml(formatCents(credit.minTopUpCents))} to ${escapeHtml(formatCents(credit.maxTopUpCents))} at a time. Tax is added at checkout. The payment processor’s fee (a percentage plus a fixed amount) comes out of the credit you receive, so larger top-ups lose a smaller share to it. Credit doesn’t expire while your account exists. It can’t be transferred, and it isn’t refundable, except where the law requires it or Polar’s terms for buyers allow it. Polar, our merchant of record, handles checkout, tax and receipts (<a href="/terms">terms</a>, section 7).${membership ? ' Buying and spending credit never needs a membership.' : ''}`;
  }
  if (membership) {
    const included =
      credit && membership.includedCreditCents > 0
        ? ` Each paid year comes with ${escapeHtml(formatCents(membership.includedCreditCents))} of credit.`
        : credit
          ? ' Credit is separate: anyone can buy it, member or not.'
          : '';
    texts.membership = `${escapeHtml(formatCents(membership.priceCents))} a year plus tax. It renews every year until you cancel, and one membership covers your own keys in both Learn and power mode.${included} Cancel any time under <strong>Manage billing</strong>; your membership lasts until the end of the year you paid for.`;
    texts['power-read'] =
      `Without a membership, you can still open, read and export everything you made on your own keys, and use <strong>Create a copy in Learn</strong> to continue a power-mode conversation there.${credit ? ' Power mode on Tangent credit needs no membership.' : ''}`;
  }
  if (searches) {
    const when =
      f.grounding === 'explicit'
        ? 'On request: choose <strong>Check sources</strong> under an answer, and the tutor searches the web, rechecks what it said and cites what it found.'
        : `${f.grounding === 'always-offer' ? 'On any reply' : 'When a reply probably needs checking (a specific date or figure, something recent, a few tangents deep, or when you ask for sources)'}, the tutor may search the web once and list its sources under the answer. Or choose <strong>Check sources</strong> under an answer to search on demand.`;
    const cap =
      credit && f.grounding !== 'explicit' && f.searchDailyCap > 0
        ? ` On credit, automatic searches stop after ${f.searchDailyCap.toLocaleString('en-US')} a day; <strong>Check sources</strong> always works.`
        : '';
    const unable = nonSearchProviders(f);
    const where = unable
      ? ` It isn’t available with ${unable} keys${pool ? ', and it’s off on the open pool' : ''}.`
      : pool
        ? ' It’s off on the open pool.'
        : '';
    // About 1¢ is OpenRouter's Exa price with up to 10 results; other engines and more results differ.
    const price = f.searchAboutOneCent
      ? 'A search adds about 1¢ to the cost of that reply.'
      : 'A search adds to the cost of that reply.';
    texts.search = `${when} ${price}${cap}${where}`;
  }
  return texts;
}

/** A chart cell: included, not included, or a short phrase (HTML). */
type Cell = boolean | string;

const CHECK =
  '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" ' +
  'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';

function cell(c: Cell): string {
  if (c === true) return `<td class="yes">${CHECK}<span class="sr-only">Included</span></td>`;
  if (c === false)
    return '<td class="no"><span aria-hidden="true">—</span><span class="sr-only">Not included</span></td>';
  return `<td>${c}</td>`;
}

/**
 * The pool's condition, stated under each pool line of the plan cards: the
 * replies are there only while the pool has credit, and how much it has now.
 */
function whilePoolHasCredit(availableMicros: number | null): string {
  const now =
    availableMicros === null
      ? ''
      : availableMicros > 0
        ? ` · currently ${escapeHtml(formatMicros(availableMicros))}`
        : ' · empty right now';
  return `<span class="while">While the pool has credit${now}</span>`;
}

function perDay(caps: PoolDailyCaps): string {
  return `${caps.requestsPerDay.toLocaleString('en-US')} a day`;
}

/**
 * "Why there's a free plan": the pool as Tangent's own policy, shown to
 * everyone comparing plans, with its catch (one model, daily limits, only
 * while it has credit). It never ties the pool to the reader's purchase:
 * paying for Tangent pays for Tangent (docs/DECISIONS.md).
 */
function whyFreeSection(pool: NonNullable<PricingFacts['pool']>, memberships: boolean): string {
  const source =
    pool.revenueShareBps > 0
      ? 'credit Tangent sets aside from what it earns'
      : 'free credit Tangent provides';
  return `<section class="why" aria-labelledby="why">
<div class="wrap">
<p class="eyebrow">The open pool</p>
<h2 id="why">Why there’s a free plan</h2>
<p class="sub">${escapeHtml(POOL_MOTTO)} Free replies come from the open pool: ${source}. They use the ${escapeHtml(pool.modelLabel)} model, have daily limits, and are available only while the pool has credit. <a href="/pool">How the pool works</a></p>
${poolStepsHtml(pool.revenueShareBps, memberships)}
</div>
</section>
`;
}

const TITLE = 'Pricing · Tangent';
const DESCRIPTION = 'What you can do on Tangent for free, and exactly what paying gets you.';

/** The headline, for whichever ways to pay this deployment offers. */
function headline(f: PricingFacts): string {
  if (f.membership) {
    const price = escapeHtml(formatCents(f.membership.priceCents));
    if (f.credit)
      return f.pool
        ? 'Learn free, pay for what you use, or bring your own key.'
        : 'Pay for what you use, or bring your own key.';
    return f.pool
      ? `Learn free, or bring your own key for ${price} a year.`
      : `Bring your own key for ${price} a year.`;
  }
  if (f.pool)
    return f.credit ? 'Learn free. Pay only for what you use.' : 'Learn free, or on your own key.';
  return f.credit ? 'Pay only for what you use.' : 'Free on your own key.';
}

/**
 * The yearly AI spend above which the membership costs less than the markup
 * on credit (the membership's price over the markup: $100 for $10 and 10%);
 * null unless both are offered and the markup is above 0.
 */
export function breakEvenCents(f: PricingFacts): number | null {
  if (!f.credit || !f.membership || f.credit.markupBps <= 0) return null;
  return Math.round((f.membership.priceCents * 10_000) / f.credit.markupBps);
}

/** The friendly overview: the ways to pay, no fine print. */
function lede(f: PricingFacts): string {
  const { pool, credit, membership } = f;
  const parts: string[] = [];
  if (pool)
    parts.push(
      `Anyone signed in can learn free on the open pool: up to ${pool.caps.requestsPerDay.toLocaleString('en-US')} replies a day, the same limits for everyone, while the pool has credit.`,
    );
  if (credit)
    parts.push(
      `${pool ? 'Want more, or power mode? Buy' : 'Buy'} prepaid credit${membership ? ', with no subscription' : ''}: you pay for each reply at what it costs Tangent, plus ${escapeHtml(formatBps(credit.markupBps))}.`,
    );
  if (membership)
    parts.push(
      `${pool || credit ? 'Prefer your own API key?' : 'Bring your own API key:'} Your AI provider bills you directly, and a ${escapeHtml(formatCents(membership.priceCents))} yearly membership covers Tangent itself.`,
    );
  else
    parts.push(
      pool || credit
        ? 'You can also use your own OpenRouter key, and Tangent charges nothing for it.'
        : 'Bring your own OpenRouter key and Tangent charges nothing: you pay OpenRouter directly.',
    );
  const breakEven = breakEvenCents(f);
  if (breakEven !== null)
    parts.push(
      `A rule of thumb: if you’d spend less than about ${escapeHtml(formatCents(breakEven))} a year on AI, credit costs you less; if more, your own key does.`,
    );
  if (!membership) parts.push('No subscription, nothing to cancel.');
  return parts.join(' ');
}

/** The pricing chart's columns, left to right: Free, then each way to pay this deployment offers. */
type Column = 'free' | 'credit' | 'key';

/** One row of the chart: a cell per column (a column the deployment doesn't offer is skipped). */
type Row = { label: string } & Record<Column, Cell>;

export function renderPricingPage(info: LegalInfo, f: PricingFacts): string {
  const { pool, credit, membership } = f;
  const notes = footnotes(noteTexts(f));
  const searches = f.grounding !== 'off';
  const columns: { id: Column; name: string }[] = [
    { id: 'free', name: 'Free' },
    ...(credit ? [{ id: 'credit' as const, name: 'Pay as you go' }] : []),
    ...(membership ? [{ id: 'key' as const, name: 'Your own key' }] : []),
  ];
  // Learn's deeper tier, when it has a choice of models, and whether the pool runs it.
  const top = f.tiers.length >= 2 ? f.tiers[0]! : null;
  const poolHasTop = top !== null && pool?.modelId === top.id;
  const anyModel = credit?.openRouter ? 'any OpenRouter model' : 'your choice of model';

  // Built top to bottom, so the notes number in reading order.
  const freeCard = `<article class="plan${pool ? ' featured' : ''}">
<h3>Free</h3>
<p class="price">$0</p>
<p class="for">${pool ? 'Learn every day on the open pool.' : membership ? 'See how Tangent works in the demo.' : 'Learn on your own OpenRouter key.'}</p>
<ul>
${pool ? `<li>${pool.caps.requestsPerDay.toLocaleString('en-US')} free replies a day on the open pool${notes.ref('pool')}${whilePoolHasCredit(pool.availableMicros)}</li>\n` : ''}${membership ? '' : `<li>Your own OpenRouter key in Learn, with nothing added by Tangent${notes.ref('own-key')}</li>\n<li>Every power-mode control, on your own keys</li>\n`}<li>The demo, with no sign-up</li>
</ul>
<a class="btn${pool ? ' primary' : ''}" href="/learn/login">${pool ? 'Start learning free' : 'Start learning'}</a>
</article>`;

  const creditCard = credit
    ? `<article class="plan">
<h3>Pay as you go</h3>
<p class="price">At cost<small> + ${escapeHtml(formatBps(credit.markupBps))} a reply</small>${notes.ref('credit')}</p>
<p class="for">Prepaid credit: no key to manage, no subscription${membership ? ', no membership' : ''}.</p>
<ul>
<li>Everything in Free</li>
<li>${top ? `The ${escapeHtml(top.label)} tier in Learn` : 'Learn on credit'}, and ${anyModel} in power mode</li>
${searches ? `<li>${f.grounding === 'explicit' ? 'Web search to check any answer' : 'Web search when an answer needs it'}</li>\n` : ''}<li>Top up from ${escapeHtml(formatCents(credit.minTopUpCents))}; credit doesn’t expire${notes.ref('top-up')}</li>
</ul>
<a class="btn" href="/learn/login">Sign in to add credit</a>
</article>`
    : '';

  const keyCard = membership
    ? `<article class="plan">
<h3>Your own key</h3>
<p class="price">${escapeHtml(formatCents(membership.priceCents))}<small> a year + tax</small>${notes.ref('membership')}</p>
<p class="for">Your AI provider bills you directly; a yearly membership covers Tangent.</p>
<ul>
<li>Everything in Free</li>
<li>Learn and power mode on your own API keys${notes.ref('own-key')}</li>
<li>Nothing added to your AI provider’s bill</li>
${credit && membership.includedCreditCents > 0 ? `<li>${escapeHtml(formatCents(membership.includedCreditCents))} of credit included each year${notes.ref('top-up')}</li>\n` : ''}</ul>
<a class="btn" href="/learn/login">Sign in to join</a>
</article>`
    : '';

  // Own keys are free while no membership is required: Free (and Pay as you go, which has
  // everything in Free) has them. Otherwise only the own-key column does.
  const keysFree = membership === null;
  const learn: Row[] = [
    {
      label: 'Straight answers, tangents and “Ask about this” side questions',
      free: true,
      credit: true,
      key: true,
    },
  ];
  if (pool)
    // The same limits for everyone, whatever else they pay for.
    learn.push({
      label: `Free replies on the open pool${notes.ref('pool')}`,
      free: perDay(pool.caps),
      credit: perDay(pool.caps),
      key: perDay(pool.caps),
    });
  learn.push({
    label: `Your own OpenRouter key${notes.ref('own-key')}`,
    free: keysFree,
    credit: keysFree,
    key: true,
  });
  if (top) {
    const onPool = poolHasTop ? 'On the open pool' : '';
    learn.push({
      label: `The ${escapeHtml(top.label)} tier${top.label === 'Smart' ? ', for deeper explanations' : ''}`,
      free: keysFree ? `${onPool ? `${onPool} or your key` : 'On your key'}` : onPool || false,
      credit: true,
      key: true,
    });
  }
  if (searches)
    learn.push({
      label: `Web search, with sources${notes.ref('search')}`,
      free: keysFree ? 'On your key' : false,
      credit: true,
      key: true,
    });

  const power: Row[] = [
    {
      label: 'Every control: context modes, inspector, reviewer, system prompts',
      free: keysFree ? 'On your keys' : `Read and export${notes.ref('power-read')}`,
      credit: true,
      key: true,
    },
    {
      label: f.providers.length
        ? `Your own ${escapeHtml(
            joinList(
              f.providers.map((p) => p.label),
              'and',
            ),
          )} keys`
        : 'Your own API keys',
      free: keysFree,
      credit: keysFree,
      key: true,
    },
  ];
  if (credit)
    power.push({
      label: `${anyModel.charAt(0).toUpperCase()}${anyModel.slice(1)}, on prepaid credit`,
      free: false,
      credit: true,
      // Credit is anyone's to buy: the membership neither includes it nor is needed for it.
      key: 'Bought separately',
    });
  power.push({
    label: f.sharing
      ? 'Read-only share links, Markdown and HTML export'
      : 'Markdown and HTML export',
    free: true,
    credit: true,
    key: true,
  });

  const cost: Row[] = [
    {
      label: 'Price',
      free: '$0',
      credit: credit
        ? `At cost + ${escapeHtml(formatBps(credit.markupBps))}${notes.ref('credit')}`
        : '',
      key: membership
        ? `${escapeHtml(formatCents(membership.priceCents))} a year${notes.ref('membership')}`
        : '',
    },
    {
      label: 'Tangent’s charge on your own key',
      free: keysFree ? 'Nothing' : false,
      credit: keysFree ? 'Nothing' : false,
      key: 'Nothing per reply',
    },
  ];
  if (credit) {
    const topUp = `Top up from ${escapeHtml(formatCents(credit.minTopUpCents))}${notes.ref('top-up')}`;
    cost.push({
      label: 'Prepaid credit',
      free: false,
      credit: topUp,
      key:
        membership && membership.includedCreditCents > 0
          ? `${escapeHtml(formatCents(membership.includedCreditCents))} a year included`
          : 'Bought separately',
    });
  }

  const group = (title: string, rows: Row[]): string =>
    `<tr class="group"><th scope="colgroup" colspan="${columns.length + 1}">${title}</th></tr>\n` +
    rows
      .map(
        (r) =>
          `<tr><th scope="row">${r.label}</th>${columns.map((col) => cell(r[col.id])).join('')}</tr>`,
      )
      .join('\n');
  const chart = `<div class="chart">
<table>
<caption class="sr-only">What each plan includes</caption>
<thead><tr><td></td>${columns.map((col) => `<th scope="col">${col.name}</th>`).join('')}</tr></thead>
<tbody>
${group('Learn', learn)}
${group('Power mode', power)}
${group('Cost', cost)}
</tbody>
</table>
</div>`;
  const plans = [freeCard, creditCard, keyCard].filter((card) => card !== '');

  const canonical = escapeHtml(new URL('/pricing', info.origin).toString());
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${escapeHtml(TITLE)}</title>
<meta name="description" content="${escapeHtml(DESCRIPTION)}">
<link rel="canonical" href="${canonical}">
<style>${PRICING_STYLE}</style>
</head>
<body>
<header class="wrap top">
<a class="brand" href="/welcome">${MARK}Tangent</a>
<nav aria-label="Account"><a href="/learn/login">Sign in to Learn</a><a href="/login">Power sign in</a></nav>
</header>
<main>
<div class="wrap intro">
<p class="eyebrow">Pricing</p>
<h1>${headline(f)}</h1>
<p class="lede">${lede(f)}</p>
</div>
<div class="wrap">
<h2 class="sr-only">Plans</h2>
<div class="plans ${['one', 'two', 'three'][plans.length - 1]}">
${plans.join('\n')}
</div>
</div>
${pool ? whyFreeSection(pool, membership !== null) : ''}<section aria-labelledby="compare">
<div class="wrap">
<h2 id="compare">Exactly what you get</h2>
<p class="sub">Line by line. The numbered notes under the chart have the details.</p>
${chart}
<div class="notes">
<h3>Notes</h3>
<ol>
${notes.list()}
</ol>
</div>
</div>
</section>
</main>
<footer>
<div class="wrap">
<span>${escapeHtml(copyrightNotice(info.operator))}</span>
<nav aria-label="Footer"><a href="/learn/demo">Try the demo</a><a href="/welcome">About Tangent</a><a href="/pricing" aria-current="page">Pricing</a><a href="/pool">Open pool</a><a href="/privacy">Privacy</a><a href="/terms">Terms</a></nav>
</div>
</footer>
</body>
</html>
`;
}

/** What the pool can spend now, through the meter's edge cache; null while it is off or can't be read. */
async function poolAvailableMicros(c: Context<AppBindings>): Promise<number | null> {
  if (!poolAvailable(c.env)) return null;
  try {
    return (await cachedPoolStatus(c.env, waitUntilOf(c))).availableMicros;
  } catch (err) {
    console.warn('/pricing: the pool meter could not be read', err);
    return null;
  }
}

/** `/pricing`'s response: one hashed stylesheet, cacheable for five minutes. */
async function pricingResponse(c: Context<AppBindings>): Promise<Response> {
  const info = legalInfo(c.env, c.req.raw);
  const facts = pricingFacts(c.env, info.sharing, await poolAvailableMicros(c));
  return new Response(renderPricingPage(info, facts), {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': await styleCsp(PRICING_STYLE),
      'Referrer-Policy': 'same-origin',
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'public, max-age=300',
    },
  });
}

/** `GET /pricing`, public (mounted at the root by `createApp`; listed in run_worker_first). */
export function pricingPageRoutes(): Hono<AppBindings> {
  const app = new Hono<AppBindings>();
  app.get('/pricing', (c) => pricingResponse(c));
  return app;
}
