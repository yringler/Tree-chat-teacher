import { escapeHtml } from '@tangent/render';
import {
  formatBps,
  formatCents,
  formatMicros,
  MAX_TOP_UP_CENTS,
  MIN_TOP_UP_CENTS,
  poolFundingText,
} from '@tangent/shared';
import type { GroundingPolicy } from '@tangent/core';
import { Hono, type Context } from 'hono';
import { groundingPolicy } from '../billing/grounding.js';
import { membershipCreditCents, membershipRequired } from '../billing/membership.js';
import { paymentProvider } from '../billing/payments/index.js';
import { appConfig, type PoolTierCaps } from '../config.js';
import type { AppBindings, AppEnv } from '../env.js';
import { poolModel } from '../pool/params.js';
import { cachedPoolStatus } from '../pool/status.js';
import { waitUntilOf } from '../routes/pool.js';
import { builtInAvailable, poolAvailable } from '../services.js';
import { simpleProviderConfig } from '../simple-mode.js';
import { LANDING_STYLE, MARK, styleCsp } from './landing.js';
import { copyrightNotice, legalInfo, type LegalInfo } from './legal-info.js';

/**
 * `/pricing`: what each plan gets you, as a pricing chart. Plan cards up top
 * say it in a line or two, a comparison table spells it out row by row, and
 * numbered notes under the table carry the fine print (fees, tax, limits,
 * what needs a membership). Static and script-free like the landing page, and
 * every number but the pool's balance comes from the config, so it describes
 * what this deployment actually sells: the free plan always; the paid column is the membership
 * when one is required (`membershipRequired`), else pay-as-you-go credit when
 * credit is sold, else absent. The community pool is free credit Tangent
 * provides; nothing here offers it for sale or calls it a donation. Each pool
 * line on the plan cards says the replies last only while the pool has
 * credit, with its balance from the landing page's cached meter.
 */

/** Everything the page states, resolved from the config (one place, for the tests too). */
export interface PricingFacts {
  /** The community pool, while Learn may spend from it (`poolAvailable`). */
  pool: {
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
    minTopUpCents: number;
    maxTopUpCents: number;
  } | null;
  /** The yearly membership, while it is required (`membershipRequired`). */
  membership: { priceCents: number; includedCreditCents: number } | null;
  grounding: GroundingPolicy;
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
  const creditSold = builtInAvailable(env) && (paymentProvider(env)?.capabilities.topUps ?? false);
  return {
    pool: poolAvailable(env)
      ? {
          modelLabel:
            simpleProviderConfig(env).models.find((m) => m.id === poolId)?.label ?? poolId,
          revenueShareBps: config.pool.revenueShareBps,
          maxOutputTokens: config.pool.maxOutputTokens,
          free: config.pool.caps.free,
          member: config.pool.caps.member,
          availableMicros: poolAvailableMicros,
        }
      : null,
    credit: creditSold
      ? {
          markupBps: config.billing.markupBps,
          openRouterFeeBps: config.billing.openRouterFeeBps,
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
    grounding: groundingPolicy(env),
    sharing,
  };
}

/** Extra rules for the plan cards and the chart, on top of the landing page's stylesheet. Hashed for the CSP. */
export const PRICING_STYLE =
  LANDING_STYLE +
  `
.intro{padding-top:24px;padding-bottom:40px}
.intro .lede{max-width:40rem}
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

/** The notes' fine print, for the features this deployment offers. */
function noteTexts(f: PricingFacts): Partial<Record<NoteId, string>> {
  const { pool, credit, membership } = f;
  const searches = f.grounding !== 'off';
  const texts: Partial<Record<NoteId, string>> = {
    'own-key': `On your own key, the AI provider bills you directly, at its own prices, and Tangent adds nothing. Learn${searches ? ' and web search' : ''} run on an OpenRouter key; power mode also takes keys for the other providers this server offers.${membership ? ' In power mode your own keys need a membership; in Learn they never do.' : ''}`,
  };
  if (pool) {
    const members = membership
      ? ` (members: ${pool.member.requestsPerDay.toLocaleString('en-US')} replies and ${escapeHtml(formatMicros(pool.member.spendMicrosPerDay))})`
      : '';
    texts.pool = `${escapeHtml(poolFundingText(pool.revenueShareBps))} Pool replies use the ${escapeHtml(pool.modelLabel)} model, run up to ${pool.maxOutputTokens.toLocaleString('en-US')} tokens and don’t search the web. Each learner gets up to ${pool.free.requestsPerDay.toLocaleString('en-US')} replies and ${escapeHtml(formatMicros(pool.free.spendMicrosPerDay))} of AI cost a day${members}, while the pool has credit; limits reset at 00:00 UTC. Using it needs a signed-in account that passed a quick human check, one per email address. <a href="/pool">How the pool works, with every limit</a>.`;
  }
  if (credit) {
    const share =
      pool && pool.revenueShareBps > 0
        ? ` ${escapeHtml(formatBps(pool.revenueShareBps))} of the markup goes into the community pool as credit is used.`
        : '';
    texts.credit = `Each reply costs what OpenRouter charges for it, plus OpenRouter’s ${escapeHtml(formatBps(credit.openRouterFeeBps))} fee for buying credit, plus Tangent’s ${escapeHtml(formatBps(credit.markupBps))} markup. Summaries and titles made on credit are charged the same way, and the billing page lists every charge.${share}`;
    texts['top-up'] =
      `Top up between ${escapeHtml(formatCents(credit.minTopUpCents))} and ${escapeHtml(formatCents(credit.maxTopUpCents))} at a time. Tax is added at checkout, and the payment processor’s fee comes out of the amount credited. Credit doesn’t expire while your account exists, can’t be transferred, and isn’t refundable except where the law requires it. Polar, our merchant of record, runs checkout, tax and receipts (<a href="/terms">terms</a>, section 7).${membership ? ' Buying credit needs a membership; credit you already have keeps working without one.' : ''}`;
  }
  if (membership) {
    const included =
      credit && membership.includedCreditCents > 0
        ? ` Each paid year includes ${escapeHtml(formatCents(membership.includedCreditCents))} of credit.`
        : '';
    texts.membership = `${escapeHtml(formatCents(membership.priceCents))} a year plus tax, renewing each year until you cancel. One membership covers Learn and power mode.${included} Cancel any time under Manage billing; the membership runs to the end of the year you paid for.`;
    texts['power-read'] =
      `Without a membership, your power conversations stay listed, readable and exportable, and you can copy any of them into Learn to keep going there.${credit ? ' Credit you already have keeps working in power mode too.' : ''}`;
  }
  if (searches) {
    const when =
      f.grounding === 'explicit'
        ? 'On request: <strong>Check sources</strong> under an answer has the tutor search the web, correct itself where it needs to, and cite what it found.'
        : f.grounding === 'always-offer'
          ? 'Offered on every reply; the model decides whether to search, at most once a reply, and lists its sources under the answer.'
          : 'Offered when an answer likely needs it (a date or a figure, something recent, a few tangents deep, or when you ask for sources); the model decides whether to search, at most once a reply, and lists its sources under the answer.';
    texts.search = `${when} A search adds a little to that reply’s cost. It runs on OpenRouter only, so not ${pool ? 'on the community pool or ' : ''}on Anthropic or OpenAI keys.`;
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

const TITLE = 'Pricing · Tangent';
const DESCRIPTION = 'What you can do on Tangent for free, and exactly what paying gets you.';

/** The headline, for whichever ways to pay this deployment offers. */
function headline(f: PricingFacts): string {
  if (f.pool)
    return f.credit ? 'Learn free. Pay only for what you use.' : 'Learn free, or on your own key.';
  return f.credit ? 'Pay only for what you use.' : 'Free on your own key.';
}

/** The friendly overview: the ways to pay, no fine print. */
function lede(f: PricingFacts): string {
  const parts: string[] = [];
  if (f.pool)
    parts.push('Every account can learn for free on the community pool, within daily limits.');
  parts.push(
    f.pool
      ? 'Bring your own OpenRouter key and Tangent charges nothing.'
      : 'Bring your own OpenRouter key and Tangent charges nothing: you pay the AI provider directly.',
  );
  if (f.credit)
    parts.push('Or top up prepaid credit and pay for each reply at cost, plus a small markup.');
  parts.push(
    f.membership
      ? 'A yearly membership adds more room on the pool and your own keys in power mode.'
      : 'No subscription, nothing to cancel.',
  );
  return parts.join(' ');
}

export function renderPricingPage(info: LegalInfo, f: PricingFacts): string {
  const { pool, credit, membership } = f;
  const notes = footnotes(noteTexts(f));
  const searches = f.grounding !== 'off';
  const paidName = membership ? 'Membership' : credit ? 'Pay as you go' : null;

  // Built top to bottom, so the notes number in reading order.
  const freeCard = `<article class="plan${pool ? ' featured' : ''}">
<h3>Free</h3>
<p class="price">$0</p>
<p class="for">${pool ? 'Learn every day on the community pool.' : 'Learn on your own OpenRouter key.'}</p>
<ul>
${pool ? `<li>${pool.free.requestsPerDay.toLocaleString('en-US')} free replies a day on the community pool${notes.ref('pool')}${whilePoolHasCredit(pool.availableMicros)}</li>\n` : ''}<li>Your own OpenRouter key, with nothing added by Tangent${notes.ref('own-key')}</li>
${membership ? '' : '<li>Every power-mode control, on your own keys</li>\n'}<li>The demo, with no sign-up</li>
</ul>
<a class="btn${pool ? ' primary' : ''}" href="/learn/login">${pool ? 'Start learning free' : 'Start learning'}</a>
</article>`;

  let paidCard = '';
  if (membership) {
    paidCard = `<article class="plan">
<h3>Membership</h3>
<p class="price">${escapeHtml(formatCents(membership.priceCents))}<small> a year + tax</small>${notes.ref('membership')}</p>
<p class="for">More room to learn, and your own keys in power mode.</p>
<ul>
<li>Everything in Free</li>
${pool ? `<li>${pool.member.requestsPerDay.toLocaleString('en-US')} pool replies a day instead of ${pool.free.requestsPerDay.toLocaleString('en-US')}${whilePoolHasCredit(pool.availableMicros)}</li>\n` : ''}<li>Your own API keys in power mode</li>
${credit ? `<li>Prepaid credit for the Smart tier and any OpenRouter model${notes.ref('credit')}</li>\n` : ''}${credit && membership.includedCreditCents > 0 ? `<li>${escapeHtml(formatCents(membership.includedCreditCents))} of credit included each year${notes.ref('top-up')}</li>\n` : ''}</ul>
<a class="btn" href="/learn/login">Sign in to join</a>
</article>`;
  } else if (credit) {
    paidCard = `<article class="plan">
<h3>Pay as you go</h3>
<p class="price">At cost<small> + ${escapeHtml(formatBps(credit.markupBps))} a reply</small>${notes.ref('credit')}</p>
<p class="for">Prepaid credit: no key to manage, no subscription.</p>
<ul>
<li>Everything in Free</li>
<li>The Smart tier in Learn, and any OpenRouter model in power mode</li>
${searches ? `<li>${f.grounding === 'explicit' ? 'Web search to check any answer' : 'Web search when an answer needs it'}</li>\n` : ''}<li>Top up from ${escapeHtml(formatCents(credit.minTopUpCents))}; credit doesn’t expire${notes.ref('top-up')}</li>
</ul>
<a class="btn" href="/learn/login">Sign in to add credit</a>
</article>`;
  }

  const learn: Row[] = [
    { label: 'Straight answers, tangents and “Ask about this” branches', free: true, paid: true },
  ];
  if (pool)
    learn.push({
      label: `Replies on the community pool${notes.ref('pool')}`,
      free: perDay(pool.free),
      paid: perDay(membership ? pool.member : pool.free),
    });
  learn.push({
    label: 'The Smart tier, for deeper answers',
    free: `On your key${notes.ref('own-key')}`,
    paid: credit ? true : 'On your key',
  });
  if (searches)
    learn.push({
      label: `Web search to check facts${notes.ref('search')}`,
      free: 'On your key',
      paid: credit ? true : 'On your key',
    });

  const power: Row[] = [
    {
      label: 'Every control: context modes, inspector, reviewer, system prompts',
      free: membership ? `Read and export${notes.ref('power-read')}` : 'On your keys',
      paid: true,
    },
    { label: 'Your own API keys, for any provider offered here', free: !membership, paid: true },
  ];
  if (credit)
    power.push({ label: 'Any OpenRouter model, on Tangent credit', free: false, paid: true });
  power.push({
    label: f.sharing
      ? 'Read-only share links, Markdown and HTML export'
      : 'Markdown and HTML export',
    free: true,
    paid: true,
  });

  const cost: Row[] = [
    { label: 'What Tangent adds on your own key', free: 'Nothing', paid: 'Nothing' },
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
<section aria-labelledby="compare">
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
<nav aria-label="Footer"><a href="/learn/demo">Try the demo</a><a href="/welcome">About Tangent</a><a href="/pricing" aria-current="page">Pricing</a><a href="/pool">Community pool</a><a href="/privacy">Privacy</a><a href="/terms">Terms</a></nav>
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
