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
import { appConfig, type PoolTierCaps } from '../config.js';
import type { AppBindings, AppEnv } from '../env.js';
import { poolModel } from '../pool/params.js';
import { cachedPoolStatus } from '../pool/status.js';
import { waitUntilOf } from '../routes/pool.js';
import { creditSold, ownKeyProviders, poolAvailable } from '../services.js';
import { learnOffer, simpleProviderConfig, type LearnOffer } from '../simple-mode.js';
import { joinList, LANDING_STYLE, MARK, poolStepsHtml, roughWords, styleCsp } from './landing.js';
import { copyrightNotice, legalInfo, type LegalInfo } from './legal-info.js';

/**
 * `/pricing`: what each plan gets you, as a pricing chart. Plan cards up top
 * say it in a line or two, a comparison table spells it out row by row, and
 * numbered notes under the table carry the fine print (fees, tax, limits,
 * what needs a membership). Static and script-free like the landing page, and
 * every number but the pool's balance comes from the config, so it describes
 * what this deployment actually sells: the free plan always; the paid column is the membership
 * when one is required (`membershipRequired`), else pay-as-you-go credit when
 * credit is sold, else absent. The open pool is free credit Tangent
 * provides; nothing here offers it for sale or calls it a donation. Each pool
 * line on the plan cards says the replies last only while the pool has
 * credit, with its balance from the landing page's cached meter.
 */

/** Everything the page states, resolved from the config (one place, for the tests too). */
export interface PricingFacts {
  /** The open pool, while Learn may spend from it (`poolAvailable`). */
  pool: {
    modelId: string;
    modelLabel: string;
    revenueShareBps: number;
    maxOutputTokens: number;
    free: PoolTierCaps;
    member: PoolTierCaps;
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
  /** The yearly membership, while it is required (`membershipRequired`). */
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
          free: config.pool.caps.free,
          member: config.pool.caps.member,
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
    'own-key': `With your own key, the AI provider bills you directly, at its own prices, and Tangent adds nothing. Learn takes an OpenRouter key${searches ? ', which also works for web search' : ''}${others ? `; power mode also takes ${others} keys` : ''}.${membership ? ' Your own keys never need a membership in Learn, but in power mode they do.' : ''}`,
  };
  if (pool) {
    const members = membership
      ? ` (members: ${pool.member.requestsPerDay.toLocaleString('en-US')} replies or ${escapeHtml(formatMicros(pool.member.spendMicrosPerDay))})`
      : '';
    texts.pool = `${escapeHtml(poolFundingText(pool.revenueShareBps))} Pool replies use the ${escapeHtml(pool.modelLabel)} model, are at most ${pool.maxOutputTokens.toLocaleString('en-US')} tokens long (roughly ${roughWords(pool.maxOutputTokens)} words) and don’t search the web. While the pool has credit, each learner can use up to ${pool.free.requestsPerDay.toLocaleString('en-US')} replies or ${escapeHtml(formatMicros(pool.free.spendMicrosPerDay))} of AI cost a day, whichever comes first${members}. Limits reset at 00:00 UTC. You need to be signed in and pass a quick check that you’re human, with one account per email address. <a href="/pool">How the pool works, with every limit</a>.`;
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
      `Top up ${escapeHtml(formatCents(credit.minTopUpCents))} to ${escapeHtml(formatCents(credit.maxTopUpCents))} at a time. Tax is added at checkout. The payment processor’s fee (a percentage plus a fixed amount) comes out of the credit you receive, so larger top-ups lose a smaller share to it. Credit doesn’t expire while your account exists. It can’t be transferred, and it isn’t refundable, except where the law requires it or Polar’s terms for buyers allow it. Polar, our merchant of record, handles checkout, tax and receipts (<a href="/terms">terms</a>, section 7).${membership ? ' Buying credit needs a membership, but credit you already have keeps working without one.' : ''}`;
  }
  if (membership) {
    const included =
      credit && membership.includedCreditCents > 0
        ? ` Each paid year comes with ${escapeHtml(formatCents(membership.includedCreditCents))} of credit.`
        : '';
    texts.membership = `${escapeHtml(formatCents(membership.priceCents))} a year plus tax. It renews every year until you cancel, and one membership covers both Learn and power mode.${included} Cancel any time under <strong>Manage billing</strong>; your membership lasts until the end of the year you paid for.`;
    texts['power-read'] =
      `Without a membership, you can still open, read and export your power-mode conversations, and use <strong>Create a copy in Learn</strong> to continue any of them there.${credit ? ' Credit you already have keeps working in power mode too.' : ''}`;
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

interface Row {
  label: string;
  free: Cell;
  paid: Cell;
}

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

function perDay(caps: PoolTierCaps): string {
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
  if (f.membership)
    return `${f.pool ? 'Learn free.' : 'Free on your own key.'} Go further for ${escapeHtml(formatCents(f.membership.priceCents))} a year.`;
  if (f.pool)
    return f.credit ? 'Learn free. Pay only for what you use.' : 'Learn free, or on your own key.';
  return f.credit ? 'Pay only for what you use.' : 'Free on your own key.';
}

/** The friendly overview: the ways to pay, no fine print. */
function lede(f: PricingFacts): string {
  const { pool, credit, membership } = f;
  const parts: string[] = [];
  if (pool)
    parts.push(
      `Anyone signed in can learn free on the open pool: up to ${pool.free.requestsPerDay.toLocaleString('en-US')} replies a day, while the pool has credit.`,
    );
  parts.push(
    pool
      ? 'You can also use your own OpenRouter key, and Tangent charges nothing for it.'
      : 'Bring your own OpenRouter key and Tangent charges nothing: you pay OpenRouter directly.',
  );
  if (credit && !membership)
    parts.push(
      `Or buy prepaid credit and pay for each reply at what it costs Tangent, plus ${escapeHtml(formatBps(credit.markupBps))}.`,
    );
  if (membership) {
    const perks = [
      ...(pool
        ? [
            `raises your pool limit to ${pool.member.requestsPerDay.toLocaleString('en-US')} replies a day`,
          ]
        : []),
      ...(credit ? ['lets you buy prepaid credit'] : []),
      'unlocks power mode on your own keys',
    ];
    parts.push(
      `A membership (${escapeHtml(formatCents(membership.priceCents))} a year) ${joinList(perks, 'and')}.`,
    );
  } else parts.push('No subscription, nothing to cancel.');
  return parts.join(' ');
}

/** The membership card's one-line summary: what it adds over Free. */
function membershipFor(f: PricingFacts): string {
  const adds = [
    ...(f.pool ? ['more free replies'] : []),
    ...(f.credit ? ['prepaid credit'] : []),
    'power mode on your own keys',
  ];
  const text = joinList(adds, 'and');
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}.`;
}

export function renderPricingPage(info: LegalInfo, f: PricingFacts): string {
  const { pool, credit, membership } = f;
  const notes = footnotes(noteTexts(f));
  const searches = f.grounding !== 'off';
  const paidName = membership ? 'Membership' : credit ? 'Pay as you go' : null;
  // Learn's deeper tier, when it has a choice of models, and whether the pool runs it.
  const top = f.tiers.length >= 2 ? f.tiers[0]! : null;
  const poolHasTop = top !== null && pool?.modelId === top.id;
  const anyModel = credit?.openRouter ? 'any OpenRouter model' : 'your choice of model';

  // Built top to bottom, so the notes number in reading order.
  const freeCard = `<article class="plan${pool ? ' featured' : ''}">
<h3>Free</h3>
<p class="price">$0</p>
<p class="for">${pool ? 'Learn every day on the open pool.' : 'Learn on your own OpenRouter key.'}</p>
<ul>
${pool ? `<li>${pool.free.requestsPerDay.toLocaleString('en-US')} free replies a day on the open pool${notes.ref('pool')}${whilePoolHasCredit(pool.availableMicros)}</li>\n` : ''}<li>Your own OpenRouter key in Learn, with nothing added by Tangent${notes.ref('own-key')}</li>
${membership ? '' : '<li>Every power-mode control, on your own keys</li>\n'}<li>The demo, with no sign-up</li>
</ul>
<a class="btn${pool ? ' primary' : ''}" href="/learn/login">${pool ? 'Start learning free' : 'Start learning'}</a>
</article>`;

  let paidCard = '';
  if (membership) {
    paidCard = `<article class="plan">
<h3>Membership</h3>
<p class="price">${escapeHtml(formatCents(membership.priceCents))}<small> a year + tax</small>${notes.ref('membership')}</p>
<p class="for">${membershipFor(f)}</p>
<ul>
<li>Everything in Free</li>
${pool ? `<li>${pool.member.requestsPerDay.toLocaleString('en-US')} pool replies a day instead of ${pool.free.requestsPerDay.toLocaleString('en-US')}${whilePoolHasCredit(pool.availableMicros)}</li>\n` : ''}<li>Power mode on your own API keys</li>
${credit ? `<li>Buy prepaid credit for ${escapeHtml(joinList([top ? `the ${top.label} tier` : 'Learn', ...(searches ? ['web search'] : []), anyModel], 'and'))}${notes.ref('credit')}</li>\n` : ''}${credit && membership.includedCreditCents > 0 ? `<li>${escapeHtml(formatCents(membership.includedCreditCents))} of credit included each year${notes.ref('top-up')}</li>\n` : ''}</ul>
<a class="btn" href="/learn/login">Sign in to join</a>
</article>`;
  } else if (credit) {
    paidCard = `<article class="plan">
<h3>Pay as you go</h3>
<p class="price">At cost<small> + ${escapeHtml(formatBps(credit.markupBps))} a reply</small>${notes.ref('credit')}</p>
<p class="for">Prepaid credit: no key to manage, no subscription.</p>
<ul>
<li>Everything in Free</li>
<li>${top ? `The ${escapeHtml(top.label)} tier in Learn` : 'Learn on credit'}, and ${anyModel} in power mode</li>
${searches ? `<li>${f.grounding === 'explicit' ? 'Web search to check any answer' : 'Web search when an answer needs it'}</li>\n` : ''}<li>Top up from ${escapeHtml(formatCents(credit.minTopUpCents))}; credit doesn’t expire${notes.ref('top-up')}</li>
</ul>
<a class="btn" href="/learn/login">Sign in to add credit</a>
</article>`;
  }

  // A membership only lets you buy credit: what credit pays for isn't "included".
  const onCredit: Cell = credit ? (membership ? 'With credit or your key' : true) : 'On your key';
  const learn: Row[] = [
    {
      label: 'Straight answers, tangents and “Ask about this” side questions',
      free: true,
      paid: true,
    },
  ];
  if (pool)
    learn.push({
      label: `Free replies on the open pool${notes.ref('pool')}`,
      free: perDay(pool.free),
      paid: perDay(membership ? pool.member : pool.free),
    });
  if (top)
    learn.push({
      label: `The ${escapeHtml(top.label)} tier${top.label === 'Smart' ? ', for deeper explanations' : ''}`,
      free: `${poolHasTop ? 'On the open pool or your key' : 'On your key'}${notes.ref('own-key')}`,
      paid: poolHasTop ? true : onCredit,
    });
  if (searches)
    learn.push({
      label: `Web search, with sources${notes.ref('search')}`,
      free: 'On your key',
      paid: onCredit,
    });

  const power: Row[] = [
    {
      label: 'Every control: context modes, inspector, reviewer, system prompts',
      free: membership ? `Read and export${notes.ref('power-read')}` : 'On your keys',
      paid: true,
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
      free: !membership,
      paid: true,
    },
  ];
  if (credit)
    power.push({
      label: `${anyModel.charAt(0).toUpperCase()}${anyModel.slice(1)}, on prepaid credit`,
      free: false,
      paid: true,
    });
  power.push({
    label: f.sharing
      ? 'Read-only share links, Markdown and HTML export'
      : 'Markdown and HTML export',
    free: true,
    paid: true,
  });

  const cost: Row[] = [
    { label: 'Tangent’s charge on your own key', free: 'Nothing', paid: 'Nothing' },
    {
      label: 'Price',
      free: '$0',
      paid: membership
        ? `${escapeHtml(formatCents(membership.priceCents))} a year${notes.ref('membership')}`
        : credit
          ? `At cost + ${escapeHtml(formatBps(credit.markupBps))}${notes.ref('credit')}`
          : '',
    },
  ];
  if (credit) {
    const topUp = `Top up from ${escapeHtml(formatCents(credit.minTopUpCents))}${notes.ref('top-up')}`;
    cost.push({
      label: 'Prepaid credit',
      free: false,
      paid:
        membership && membership.includedCreditCents > 0
          ? `${escapeHtml(formatCents(membership.includedCreditCents))} a year included; ${topUp.charAt(0).toLowerCase()}${topUp.slice(1)}`
          : topUp,
    });
  }

  const group = (title: string, rows: Row[]): string =>
    `<tr class="group"><th scope="colgroup" colspan="${paidName ? 3 : 2}">${title}</th></tr>\n` +
    rows
      .map(
        (r) =>
          `<tr><th scope="row">${r.label}</th>${cell(r.free)}${paidName ? cell(r.paid) : ''}</tr>`,
      )
      .join('\n');
  const chart = `<div class="chart">
<table>
<caption class="sr-only">What each plan includes</caption>
<thead><tr><td></td><th scope="col">Free</th>${paidName ? `<th scope="col">${paidName}</th>` : ''}</tr></thead>
<tbody>
${group('Learn', learn)}
${group('Power mode', power)}
${group('Cost', cost)}
</tbody>
</table>
</div>`;

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
<div class="plans ${paidCard ? 'two' : 'one'}">
${freeCard}
${paidCard}
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
