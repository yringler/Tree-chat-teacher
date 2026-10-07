import { escapeHtml } from '@tangent/render';
import {
  formatBps,
  formatMicros,
  POOL_AT_COST_TEXT,
  POOL_EMPTY_TEXT,
  POOL_MOTTO,
  poolSessionsHeadline,
  poolSteps,
  poolWeekText,
  type PoolImpactResponse,
  type PoolStatusResponse,
} from '@tangent/shared';
import type { GroundingPolicy } from '@tangent/core';
import { Hono, type Context } from 'hono';
import { authBaseUrl, authConfigured } from '../auth/auth.js';
import { groundingPolicy } from '../billing/grounding.js';
import { membershipRequired } from '../billing/membership.js';
import { appConfig } from '../config.js';
import type { AppBindings, AppEnv } from '../env.js';
import { latestImpactForPage, renderImpactBlock } from './impact-block.js';
import { copyrightNotice, legalInfo } from './legal-info.js';
import { LEARN_APP_CSP, LEARN_COMMON_HEADERS } from './learn-app.js';
import { cachedPoolStatus } from '../pool/status.js';
import { waitUntilOf } from '../routes/pool.js';
import { creditSold, ownKeyProviders } from '../services.js';
import { learnOffer } from '../simple-mode.js';

/**
 * Better Auth's session cookie (`cookiePrefix: 'tangent'` in auth/auth.ts),
 * plain on http://localhost and `__Secure-` prefixed on https.
 */
const SESSION_COOKIES: ReadonlySet<string> = new Set([
  'tangent.session_token',
  '__Secure-tangent.session_token',
]);

/** True when the Cookie header carries a non-empty Better Auth session cookie. */
export function hasSessionCookie(cookieHeader: string | null | undefined): boolean {
  if (!cookieHeader) return false;
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (SESSION_COOKIES.has(part.slice(0, eq).trim()) && part.slice(eq + 1).trim() !== '') {
      return true;
    }
  }
  return false;
}

/** The local dev bypass (auth/session.ts): everyone is the owner, so `/` is the app. */
function devBypass(env: AppEnv): boolean {
  return !authConfigured(env) && env.DEV_ALLOW_NO_AUTH === 'true';
}

/**
 * Constant inline stylesheet of the landing page. Hashed for the CSP; never
 * interpolate anything into it. Colours follow packages/web-shared base.css.
 */
export const LANDING_STYLE = `
:root{color-scheme:light dark;--bg:#fbfbfa;--bg-elev:#fff;--bg-sunken:#f2f2ef;--fg:#1d1d1b;--muted:#6b6b66;--border:#e2e2dd;--accent:#2f6fdb;--accent-fg:#fff;--accent-soft:#e6eefc;--branch:#7a45c7;--branch-soft:#f0e8fb;--user-bg:#f1f3f8;--shadow:0 1px 2px rgb(0 0 0/.05),0 12px 32px rgb(0 0 0/.08);--font:ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif}
@media (prefers-color-scheme:dark){:root{--bg:#161616;--bg-elev:#1f1f1e;--bg-sunken:#121212;--fg:#e9e9e4;--muted:#9b9b94;--border:#2f2f2c;--accent:#6b9cf0;--accent-fg:#0d1526;--accent-soft:#1d2a42;--branch:#b893f0;--branch-soft:#2e2242;--user-bg:#22242a;--shadow:0 1px 2px rgb(0 0 0/.4),0 12px 32px rgb(0 0 0/.45)}}
*,*::before,*::after{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.6 var(--font);-webkit-font-smoothing:antialiased}
a{color:var(--accent)}
a:focus-visible{outline:2px solid var(--accent);outline-offset:3px;border-radius:6px}
.wrap{max-width:960px;margin:0 auto;padding:0 20px}
header.top{display:flex;align-items:center;justify-content:space-between;gap:16px;padding-top:20px;padding-bottom:20px}
.brand{display:inline-flex;align-items:center;gap:10px;color:var(--fg);font-weight:650;font-size:1.1rem;text-decoration:none}
.brand svg{color:var(--accent)}
.top nav{display:flex;gap:18px;font-size:.92rem}
@media (max-width:479px){.top nav a+a{display:none}}
.top nav a{color:var(--muted);text-decoration:none}
.top nav a:hover{color:var(--fg)}
.hero{display:grid;gap:40px;padding-top:32px;padding-bottom:56px}
.eyebrow{margin:0 0 12px;color:var(--accent);font-size:.8rem;font-weight:600;letter-spacing:.08em;text-transform:uppercase}
h1{margin:0;font-size:clamp(2rem,7vw,3.1rem);line-height:1.1;letter-spacing:-.02em;font-weight:700}
.lede{margin:20px 0 0;max-width:34rem;color:var(--muted);font-size:1.08rem}
.ctas{display:flex;flex-wrap:wrap;gap:12px;margin:28px 0 0}
.btn{display:inline-flex;align-items:center;justify-content:center;min-height:46px;padding:0 22px;border-radius:999px;border:1px solid var(--border);background:var(--bg-elev);color:var(--fg);font-weight:600;text-decoration:none}
.btn:hover{border-color:var(--accent)}
.btn.primary{background:var(--accent);border-color:var(--accent);color:var(--accent-fg)}
.btn.primary:hover{filter:brightness(1.08)}
.note{margin:14px 0 0;max-width:30rem;color:var(--muted);font-size:.88rem}
.power{margin:18px 0 0;font-size:.92rem}
.free{margin:18px 0 0;max-width:32rem;padding:12px 16px;border:1px solid var(--accent);border-radius:12px;background:var(--accent-soft);font-size:.95rem}
.free strong{color:var(--accent)}
.demo{position:relative;margin:0;padding:20px;border:1px solid var(--border);border-radius:16px;background:var(--bg-elev);box-shadow:var(--shadow);font-size:.9rem}
.msg{margin:0 0 12px;padding:10px 14px;border-radius:12px;max-width:92%}
.msg.you{margin-left:auto;background:var(--user-bg)}
.msg.tutor{border:1px solid var(--border)}
mark{background:var(--accent-soft);color:inherit;border-radius:4px;padding:0 2px;box-shadow:inset 0 -2px 0 var(--accent)}
.next{margin:6px 0 12px;padding:0 4px}
.next .tag{display:block;margin:0 0 6px;color:var(--muted);font-size:.72rem;font-weight:700;letter-spacing:.06em;text-transform:uppercase}
.next span+span{display:block;margin:0 0 6px;padding:6px 10px;border:1px solid var(--border);border-radius:10px;background:var(--bg-elev)}
.next b{font-weight:600}
.next i{color:var(--muted);font-style:normal}
.next .on{border-color:var(--accent);background:var(--accent-soft)}
.side{margin:4px 0 0 18px;padding:12px 14px;border-left:3px solid var(--branch);border-radius:0 12px 12px 0;background:var(--branch-soft)}
.side .tag{display:inline-block;margin:0 0 6px;color:var(--branch);font-size:.75rem;font-weight:700;letter-spacing:.04em;text-transform:uppercase}
.side p{margin:0}
.side p+p{margin-top:6px;color:var(--muted)}
section{padding:56px 0;border-top:1px solid var(--border)}
h2{margin:0 0 8px;font-size:clamp(1.4rem,4vw,1.85rem);line-height:1.2;letter-spacing:-.01em}
.sub{margin:0 0 32px;max-width:36rem;color:var(--muted)}
.grid{display:grid;gap:16px}
.card{padding:22px;border:1px solid var(--border);border-radius:14px;background:var(--bg-elev)}
.card h3{margin:0 0 8px;font-size:1.05rem}
.card p{margin:0;color:var(--muted);font-size:.95rem}
.icon{display:inline-flex;align-items:center;justify-content:center;width:36px;height:36px;margin:0 0 14px;border-radius:10px;background:var(--accent-soft);color:var(--accent)}
.mode h3{font-size:1.2rem}
.mode .for{margin:0 0 14px}
.mode ul{margin:0 0 20px;padding:0 0 0 18px;font-size:.95rem}
.mode li{margin:0 0 6px}
.mode li::marker{color:var(--accent)}
.mode.learn{border-color:var(--accent);box-shadow:var(--shadow)}
.pool{display:grid;gap:20px;padding:24px;border:1px solid var(--accent);border-radius:14px;background:var(--bg-elev);box-shadow:var(--shadow)}
.pool .meter{margin:0;font-size:clamp(1.5rem,5vw,2rem);font-weight:700;line-height:1.2}
.pool .meter small{display:block;margin-top:4px;color:var(--muted);font-size:1rem;font-weight:500}
.pool .week{margin:0;color:var(--muted)}
.pool .fee{margin:0;color:var(--muted);font-size:.88rem}
.pool .ctas{margin:0}
.steps{display:grid;gap:12px;margin:0;padding:0;list-style:none;counter-reset:step}
.steps li{position:relative;padding:12px 14px 12px 48px;border:1px solid var(--border);border-radius:12px;background:var(--bg-sunken);font-size:.95rem;counter-increment:step}
.steps li::before{content:counter(step);position:absolute;top:11px;left:14px;display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;border-radius:50%;background:var(--accent);color:var(--accent-fg);font-size:.8rem;font-weight:700}
@media (min-width:720px){.steps{grid-template-columns:repeat(3,1fr)}}
#pool+.sub{max-width:40rem}
.impact{display:grid;gap:8px}
.impact p{margin:0}
.impact .head{font-weight:600}
.impact .depth,.impact .note{color:var(--muted)}
.impact .topics{display:flex;flex-wrap:wrap;gap:8px;margin:4px 0 0;padding:0;list-style:none}
.impact .topics li{padding:4px 10px;border:1px solid var(--border);border-radius:999px;background:var(--accent-soft);font-size:.9rem}
footer{padding:32px 0 48px;border-top:1px solid var(--border);color:var(--muted);font-size:.9rem}
footer .wrap{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:16px}
footer nav{display:flex;flex-wrap:wrap;gap:18px}
footer a{color:var(--muted)}
@media (min-width:720px){.wrap{padding:0 32px}.hero{grid-template-columns:1.15fr 1fr;align-items:center;padding-top:56px;padding-bottom:80px}.grid.four{grid-template-columns:1fr 1fr}.grid.four>:last-child:nth-child(odd){grid-column:1/-1}.grid.two{grid-template-columns:1fr 1fr}section{padding:72px 0}}
`;

/**
 * Brand mark: the app icon (apps/web/public/favicon.svg, the web-shared Logo)
 * in one colour. An orb, a ray touching it at exactly one point, and the
 * point it heads to.
 */
export const MARK =
  '<svg width="28" height="28" viewBox="0 0 28 28" fill="none" aria-hidden="true">' +
  '<circle cx="14" cy="18" r="5.5" stroke="currentColor" stroke-width="2"/>' +
  '<path d="M6.1 14.8L19.1 3.9" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>' +
  '<circle cx="19.1" cy="3.9" r="2.4" fill="currentColor"/></svg>';

/** 20×20 stroke icons for the feature cards. */
function icon(path: string): string {
  return (
    '<span class="icon"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    `stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg></span>`
  );
}

const ICON_BRANCH = icon(
  '<circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="9" r="2"/><path d="M6 7v10M18 11c0 4-6 3-11.5 6.5"/>',
);
const ICON_COMPASS = icon(
  '<circle cx="12" cy="12" r="9"/><path d="m15.5 8.5-2.2 5-5 2.2 2.2-5z"/>',
);
const ICON_EYE = icon(
  '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
);
const ICON_CHECK = icon('<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5M8 11l2 2 4-4"/>');
const ICON_COIN = icon(
  '<circle cx="12" cy="12" r="9"/><path d="M15 9.5c-.5-1-1.6-1.5-3-1.5-1.8 0-3 .9-3 2s1 1.7 3 2 3 .9 3 2-1.2 2-3 2c-1.4 0-2.5-.5-3-1.5M12 6.5V8M12 16v1.5"/>',
);

export interface LandingPageOptions {
  /** Absolute URL of the page's canonical address (the site root). */
  canonicalUrl: string;
  /** Who runs the service, for the footer's copyright line (http/legal.ts). */
  operator: string;
  /** Share links are offered to everyone (DMCA_AGENT_REGISTERED); otherwise only export is advertised. */
  sharing: boolean;
  /** The open pool's meter; absent when the pool is off or couldn't be read. */
  pool?: PoolStatusResponse;
  /** The pool's latest weekly impact snapshot; absent when there is none (or the pool is off). */
  impact?: PoolImpactResponse;
  /** The yearly membership is required for power mode on own keys and for buying credit (`membershipRequired`); own keys in Learn stay free. */
  membership?: boolean;
  /** The operator's `GROUNDING` ceiling; `off` (or absent) leaves web-search grounding off the page. */
  grounding?: GroundingPolicy;
  /**
   * Prepaid credit is sold (`creditSold`), at this markup, on OpenRouter or
   * another endpoint (`LearnOffer.openRouter`); absent = it isn't, and the page doesn't offer it.
   */
  credit?: { markupBps: number; openRouter: boolean };
  /** Who power mode takes the user's own keys for (`ownKeyProviders` labels); empty = a generic phrase. */
  providers?: readonly string[];
  /** Learn's models, the default first (`LearnOffer.tiers` labels); fewer than two = no choice to describe. */
  tiers?: readonly string[];
}

/** About how many English words `tokens` tokens make (¾ of a word each), to the nearest 50: `750` for 1,024. */
export function roughWords(tokens: number): string {
  return Math.max(50, Math.round((tokens * 0.75) / 50) * 50).toLocaleString('en-US');
}

/** `A`, `A or B`, `A, B or C` (or `and`). */
export function joinList(items: readonly string[], word: 'and' | 'or'): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} ${word} ${items[items.length - 1]}`;
}

/** Topics the landing page names at most; `/pool` lists them all. */
const LANDING_IMPACT_TOPICS = 12;

/** True when the pool is on and can cover at least one more learning session: only then is "free" promised. */
function poolOpen(pool: PoolStatusResponse | undefined): pool is PoolStatusResponse {
  return pool !== undefined && pool.sessionsRemaining > 0;
}

/**
 * The pool section's intro: why the pool exists. The steps under it say how
 * (with the revenue share's percentage from the config); the details (what
 * the share is of, the model, the limits) are on `/pool`.
 */
const POOL_INTRO = `Every AI reply costs real money, so good AI tutoring usually sits behind a paywall. ${POOL_MOTTO} Here’s how:`;

/** How the pool comes about, as three numbered steps (`poolSteps`); the landing and pricing pages share it. */
export function poolStepsHtml(revenueShareBps: number, memberships: boolean): string {
  return `<ol class="steps">${poolSteps(revenueShareBps, memberships)
    .map((step) => `<li>${escapeHtml(step)}</li>`)
    .join('')}</ol>`;
}

/** Learners on the pool this week the hero names at least; fewer would read as a weak signal. */
const HERO_LEARNERS_MIN = 10;

/**
 * The open pool section: why it exists, where its credit comes from
 * (Tangent's revenue share, in brief), the meter, this week's
 * counts and the latest weekly impact snapshot when there is one. It is
 * Tangent's own commitment: nothing here is for sale, and nothing asks the
 * visitor to pay for anyone else (docs/DECISIONS.md, "Revenue-funded
 * open pool"). The free sign-up button shows only while the pool has
 * credit.
 */
function poolSection(
  pool: PoolStatusResponse,
  memberships: boolean,
  impact?: PoolImpactResponse,
): string {
  const meter =
    pool.sessionsRemaining > 0
      ? `<p class="meter">${escapeHtml(poolSessionsHeadline(pool.sessionsRemaining))} left<small>${escapeHtml(formatMicros(pool.availableMicros))} in the pool</small></p>`
      : `<p class="meter">${escapeHtml(POOL_EMPTY_TEXT)}<small>${escapeHtml(formatMicros(pool.availableMicros))} in the pool</small></p>`;
  const ctas = poolOpen(pool)
    ? '<a class="btn primary" href="/learn/login">Start learning free</a><a class="btn" href="/pool">How the pool works</a>'
    : '<a class="btn" href="/pool">How the pool works</a>';
  return `<section aria-labelledby="pool">
<div class="wrap">
<p class="eyebrow">The open pool</p>
<h2 id="pool">Curiosity shouldn’t need a credit card</h2>
<p class="sub">${escapeHtml(POOL_INTRO)}</p>
<div class="pool">
${poolStepsHtml(pool.revenueShareBps, memberships)}
${meter}
<p class="week">${escapeHtml(poolWeekText(pool.week))}</p>
${impact ? `${renderImpactBlock(impact, LANDING_IMPACT_TOPICS)}\n` : ''}<div class="ctas">${ctas}</div>
<p class="fee">${escapeHtml(POOL_AT_COST_TEXT)}</p>
</div>
</div>
</section>
`;
}

/**
 * The feature card on web-search grounding (docs/DECISIONS.md, "Grounding
 * (web search)"), worded for the operator's ceiling: offered when a reply
 * likely needs it and the model decides (`auto`, `always-offer`), or only on
 * request (`explicit`). Never promises that every answer is checked, and,
 * while the pool is shown, says that pool replies don't search.
 */
function groundingCard(
  policy: GroundingPolicy | undefined,
  pool: boolean,
  credit: boolean,
): string {
  if (policy === undefined || policy === 'off') return '';
  const notPool = pool
    ? ` Web search works on your own OpenRouter key${credit ? ' or prepaid credit' : ''}, not on the free open pool.`
    : '';
  if (policy === 'explicit') {
    return `<article class="card">${ICON_CHECK}<h3>Check any answer against the web</h3><p>Not sure about a detail? Choose <strong>Check sources</strong> under an answer, and the tutor searches the web, rechecks what it said and cites what it found.${notPool}</p></article>`;
  }
  return `<article class="card">${ICON_CHECK}<h3>Checked against the web when you go deep</h3><p>The further down a tangent you go, the likelier an AI is to get a detail wrong. So when a reply needs it (a specific date or figure, something recent, a few branches deep, or when you ask for sources), the tutor can search the web and list its sources under the answer. An answer from the tutor’s own knowledge says so, and <strong>Check sources</strong> has the tutor look it up.${notPool}</p></article>`;
}

/**
 * The card on how replies are paid for: the open pool while it is on, the
 * user's own OpenRouter key always, and prepaid credit only while it is sold
 * (to members, when the membership is required).
 */
function payCard(opts: LandingPageOptions): string {
  const { pool, credit } = opts;
  const title = pool
    ? credit
      ? 'Free, your key, or pay as you go'
      : 'Free, or on your own key'
    : credit
      ? 'Your key, or pay as you go'
      : 'Free on your own key';
  const parts: string[] = [];
  if (pool) parts.push('Learn free on the open pool, within daily limits, while it has credit.');
  parts.push(
    `${pool ? 'Or use' : 'Use'} your own OpenRouter key: you pay OpenRouter directly, and Tangent charges nothing.`,
  );
  if (credit)
    parts.push(
      `${opts.membership ? 'With a yearly membership, you can also buy' : 'Or buy'} prepaid credit and pay for each reply at what it costs Tangent, plus ${escapeHtml(formatBps(credit.markupBps))}.`,
    );
  return `<article class="card">${ICON_COIN}<h3>${title}</h3><p>${parts.join(' ')} <a href="/pricing">See exactly what’s free and what’s paid</a></p></article>
`;
}

/** The Learn card's list (HTML): what Learn does, then the ways to pay for it. */
function learnItems(opts: LandingPageOptions): string[] {
  const { pool, credit, membership } = opts;
  const items = [
    'Straight answers that explain how things work, ready the moment you sign in',
    'Suggested tangents after each full answer, one tap away',
    'Side questions about any phrase with <strong>Ask about this</strong>',
  ];
  const tiers = opts.tiers ?? [];
  if (tiers.length >= 2) {
    const choice =
      tiers.length === 2 && tiers[0] === 'Smart' && tiers[1] === 'Simple'
        ? 'Two tiers: Smart for deeper explanations, Simple for quicker, cheaper answers'
        : `A choice of models: ${escapeHtml(joinList(tiers, 'and'))}`;
    items.push(pool ? `${choice} (the free pool uses ${escapeHtml(pool.model.label)})` : choice);
  }
  if (pool)
    items.push(
      `Learn free on the open pool, within daily limits, on credit Tangent provides${pool.revenueShareBps > 0 ? ' from its earnings' : ''}`,
    );
  items.push(
    `${pool ? 'Or use your' : 'Your'} own OpenRouter key, with nothing charged by Tangent${membership ? ' and no membership needed' : ''}`,
  );
  if (credit)
    items.push(
      `Or pay per reply from prepaid credit${membership ? ' (buying credit needs a membership)' : ''}`,
    );
  return items;
}

/** The Power card's list (HTML). */
function powerItems(opts: LandingPageOptions): string[] {
  const providers = opts.providers ?? [];
  const items = [
    providers.length
      ? `Your own API keys for ${escapeHtml(joinList(providers, 'or'))}`
      : 'Your own API keys for any provider this server offers',
  ];
  if (opts.credit)
    items.push(
      opts.credit.openRouter
        ? 'Any OpenRouter model, on prepaid credit'
        : 'Your choice of model, on prepaid credit',
    );
  items.push(
    'Every control: context modes, the context inspector, a reviewer and system prompts',
    opts.sharing ? 'Read-only share links, and Markdown or HTML export' : 'Markdown or HTML export',
    'Self-host it on your own Cloudflare account',
  );
  return items;
}

const TITLE = 'Tangent: follow your curiosity, one branch at a time';
const DESCRIPTION =
  'An AI tutor for rabbit holes. Ask anything, get a straight answer, then follow any tangent in its own branch without losing the main thread.';

/**
 * The landing page for anonymous visitors: one self-contained document, no
 * script, one constant inline stylesheet (LANDING_STYLE) allowed by hash.
 */
export function renderLandingPage(opts: LandingPageOptions): string {
  const canonical = escapeHtml(opts.canonicalUrl);
  const free = poolOpen(opts.pool);
  const freeNote = poolOpen(opts.pool)
    ? `<p class="free"><strong>No credit card needed.</strong> ${opts.pool.revenueShareBps > 0 ? `Tangent puts ${escapeHtml(formatBps(opts.pool.revenueShareBps))} of what it earns into the open pool` : 'Tangent provides free credit in the open pool'}, so anyone signed in can learn here free, within daily limits.${opts.pool.week.learners >= HERO_LEARNERS_MIN ? ` ${opts.pool.week.learners.toLocaleString('en-US')} people learned free this week.` : ''} <a href="#pool">How it works</a></p>\n`
    : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${escapeHtml(TITLE)}</title>
<meta name="description" content="${escapeHtml(DESCRIPTION)}">
<link rel="canonical" href="${canonical}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Tangent">
<meta property="og:title" content="${escapeHtml(TITLE)}">
<meta property="og:description" content="${escapeHtml(DESCRIPTION)}">
<meta property="og:url" content="${canonical}">
<meta name="twitter:card" content="summary">
<style>${LANDING_STYLE}</style>
</head>
<body>
<header class="wrap top">
<a class="brand" href="/welcome">${MARK}Tangent</a>
<nav aria-label="Site"><a href="/learn/login">Sign in to Learn</a><a href="/login">Power sign in</a><a href="/pricing">Pricing</a></nav>
</header>
<main>
<div class="wrap hero">
<div>
<p class="eyebrow">An AI tutor built for rabbit holes</p>
<h1>Follow every tangent. Never lose the thread.</h1>
<p class="lede">Ask anything and get a straight answer that explains how it actually works. Then pick a tangent to follow. Each one opens in its own branch, so you can wander as far as you like and come back to the main thread right where you left it.</p>
<div class="ctas">
<a class="btn primary" href="/learn/demo">Try the demo</a>
<a class="btn" href="/learn/login">${free ? 'Start learning free' : 'Start learning'}</a>
</div>
${freeNote}<p class="note">The demo needs no sign-up and runs entirely in your browser. No AI is involved, so its replies and sources are playful nonsense: it’s there to show you how branching works.</p>
<p class="power"><a href="/login">Power users: sign in</a> · <a href="/canvas/demo">Feeling brave? Try Canvas</a>, an experimental map of a whole conversation</p>
</div>
<figure class="demo" aria-label="Example: an answer, its tangents, and a side question branching off it">
<p class="msg you">Why does ice float?</p>
<p class="msg tutor">Because water expands when it freezes. In the liquid, molecules tumble past each other; in ice, each one locks into a hexagonal lattice held open by <mark>hydrogen bonds</mark>, with more empty space than the liquid had. Same mass, more volume, lower density.</p>
<div class="next">
<span class="tag">Where next?</span>
<span class="on"><b>Why lakes freeze from the top down</b> <i>— the same fact, seen from a fish's point of view</i></span>
<span><b>The other substances that expand on freezing</b> <i>— silicon, gallium, and why they are rare</i></span>
<span><b>What a hydrogen bond actually is</b> <i>— one layer down</i></span>
</div>
<div class="side">
<span class="tag">Ask about this</span>
<p>Why hexagonal?</p>
<p>A side question about a highlighted phrase. It opens in its own branch, and the main thread stays as it was.</p>
</div>
</figure>
</div>
<section aria-labelledby="features">
<div class="wrap">
<h2 id="features">Learning that follows your curiosity</h2>
<p class="sub">Every lesson is a tree of branches. Wander off as far as you like, and the conversation stays easy to follow.</p>
<div class="grid four">
<article class="card">${ICON_COMPASS}<h3>Answers first, tangents next</h3><p>Ask a question and get the answer straight away, in real depth: how and why it works, not just the fact, and no quizzing. Full answers end with a few tangents worth following, and one tap opens any of them in its own branch.</p></article>
<article class="card">${ICON_BRANCH}<h3>Branch from any message</h3><p>Highlight a phrase and choose <strong>Ask about this</strong>. Your side question opens in its own branch, so detours never clutter the main thread, and every branch stays one click away.</p></article>
<article class="card">${ICON_EYE}<h3>See exactly what the model sees</h3><p>In power mode, choose how much each branch inherits: the whole conversation so far, a summary of it, or just the passage you branched from. The context inspector shows the exact prompt before it’s sent.</p></article>
${payCard(opts)}
${groundingCard(opts.grounding, opts.pool !== undefined, opts.credit !== undefined)}</div>
</div>
</section>
${opts.pool ? poolSection(opts.pool, opts.membership === true, opts.impact) : ''}<section aria-labelledby="modes">
<div class="wrap">
<h2 id="modes">Two ways to use it</h2>
<p class="sub">One sign-in, two levels of control. Switch between them any time; each keeps its own conversations.</p>
<div class="grid two">
<article class="card mode learn">
<h3>Learn</h3>
<p class="for">For students and the curious. Nothing to set up.</p>
<ul>
${learnItems(opts)
  .map((item) => `<li>${item}</li>`)
  .join('\n')}
</ul>
<a class="btn primary" href="/learn/login">${free ? 'Start learning free' : 'Start learning'}</a>
</article>
<article class="card mode">
<h3>Power</h3>
<p class="for">For tinkerers and self-hosters.${opts.membership ? ' Using your own keys here needs a yearly membership; credit you already have works without one.' : ''}</p>
<ul>
${powerItems(opts)
  .map((item) => `<li>${item}</li>`)
  .join('\n')}
</ul>
<a class="btn" href="/login">Power sign in</a>
</article>
</div>
</div>
</section>
</main>
<footer>
<div class="wrap">
<span>${escapeHtml(copyrightNotice(opts.operator))}</span>
<nav aria-label="Footer"><a href="/learn/demo">Try the demo</a><a href="/learn/login">Sign in to Learn</a><a href="/login">Power sign in</a><a href="/welcome">About Tangent</a><a href="/pricing">Pricing</a><a href="/pool">Open pool</a><a href="/privacy">Privacy</a><a href="/terms">Terms</a></nav>
</div>
</footer>
</body>
</html>
`;
}

/** Base64 SHA-256 of `text`: a CSP source hash. */
export async function sha256Base64(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  let bin = '';
  for (const b of new Uint8Array(digest)) bin += String.fromCharCode(b);
  return btoa(bin);
}

const cspByStyle = new Map<string, Promise<string>>();

/**
 * Content-Security-Policy of a static page (landing, legal): nothing but its
 * one hashed inline stylesheet and same-origin or data: images (the favicon).
 * Memoized per stylesheet.
 */
export function styleCsp(style: string): Promise<string> {
  let csp = cspByStyle.get(style);
  if (!csp) {
    csp = sha256Base64(style).then(
      (hash) =>
        `default-src 'none'; style-src 'sha256-${hash}'; img-src 'self' data:; ` +
        "base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      (err: unknown) => {
        cspByStyle.delete(style);
        throw err;
      },
    );
    cspByStyle.set(style, csp);
  }
  return csp;
}

/** The landing page's Content-Security-Policy. */
export function landingCsp(): Promise<string> {
  return styleCsp(LANDING_STYLE);
}

/** The pool meter while the pool is on; omitted when it is off or can't be read (the page still renders). */
async function landingPool(c: Context<AppBindings>): Promise<PoolStatusResponse | undefined> {
  try {
    const status = await cachedPoolStatus(c.env, waitUntilOf(c));
    return status.enabled ? status : undefined;
  } catch (err) {
    console.warn('Landing page: the pool meter could not be read', err);
    return undefined;
  }
}

/** The landing page; `headers` adds to (or overrides) the common ones. */
async function landingResponse(
  c: Context<AppBindings>,
  headers: Record<string, string>,
): Promise<Response> {
  const canonicalUrl = new URL('/', authBaseUrl(c.env, c.req.raw)).toString();
  const { operator, sharing } = legalInfo(c.env, c.req.raw);
  const pool = await landingPool(c);
  const impact = pool ? await latestImpactForPage(c.env) : undefined;
  const membership = membershipRequired(c.env);
  const offer = learnOffer(c.env);
  // Learn can't search when its provider has no web search, whatever GROUNDING says.
  const grounding = offer?.search ? groundingPolicy(c.env) : 'off';
  const credit = creditSold(c.env)
    ? { markupBps: appConfig(c.env).billing.markupBps, openRouter: offer?.openRouter ?? false }
    : undefined;
  const providers = ownKeyProviders(c.env).map((p) => p.label);
  const tiers = offer?.tiers.map((t) => t.label) ?? [];
  const page = renderLandingPage({
    canonicalUrl,
    operator,
    sharing,
    pool,
    impact,
    membership,
    grounding,
    credit,
    providers,
    tiers,
  });
  return new Response(page, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': await landingCsp(),
      'Referrer-Policy': 'same-origin',
      'X-Content-Type-Options': 'nosniff',
      ...headers,
    },
  });
}

/**
 * The landing page (PLAN §14), mounted at the root by `createApp`.
 * - `GET /welcome` always serves it.
 * - `GET /` serves it to anonymous visitors only: no Better Auth session
 *   cookie and not the dev bypass. Everyone else gets the power app's
 *   index.html from ASSETS, with the headers `_headers` gives it (they don't
 *   apply to Worker responses). A stale cookie lands in the app, which sends
 *   the visitor to sign in, so presence is enough and no D1 lookup is needed.
 * `/` varies by cookie, so it is never cached as is (`no-cache` + `Vary`):
 * after signing in, `/` must be the app at once. HEAD is answered by Hono
 * through the GET handlers; other methods fall through.
 */
export function landingRoutes(): Hono<AppBindings> {
  const app = new Hono<AppBindings>();

  app.get('/welcome', (c) => landingResponse(c, { 'Cache-Control': 'public, max-age=300' }));

  app.get('/', async (c) => {
    if (!devBypass(c.env) && !hasSessionCookie(c.req.header('Cookie'))) {
      return landingResponse(c, { 'Cache-Control': 'no-cache', Vary: 'Cookie' });
    }
    const res = await c.env.ASSETS.fetch(c.req.raw);
    const out = new Response(res.body, res);
    out.headers.set('Content-Security-Policy', LEARN_APP_CSP);
    for (const [name, value] of Object.entries(LEARN_COMMON_HEADERS)) out.headers.set(name, value);
    out.headers.append('Vary', 'Cookie');
    return out;
  });

  return app;
}
