import {
  formatBps,
  formatCents,
  formatMicros,
  OPENROUTER_PROVIDER_ID,
  POOL_FUNDING_TEXT,
  POOL_MOTTO,
  poolModelDifferences,
  poolModelText,
  roughWords,
  type PoolModelInfo,
} from '@tangent/shared';
import { Hono, type Context } from 'hono';
import type { Child } from 'hono/jsx';
import { poolAvailable } from '../availability.js';
import { appConfig, type PoolDailyCaps } from '../config.js';
import type { AppBindings, AppEnv } from '../env.js';
import { logEvent } from '../log.js';
import { cachedPoolStatus, poolModelInfo } from '../pool/status.js';
import { waitUntilOf } from '../routes/pool.js';
import { joinList, offerOf, PoolSteps, type Offer } from './copy.js';
import { pageResponse } from './layout.js';
import { legalInfo } from './legal-info.js';
import { PRICING_STYLE } from './page-styles.js';

/**
 * `/pricing`: what each way to pay gets you, as a pricing chart. Plan cards up
 * top say it in a line or two, a comparison table spells it out row by row,
 * and numbered notes under the table carry the fine print (fees, tax, limits,
 * what needs a membership). Static and script-free like the landing page, and
 * every number but the pool's balance comes from the config, so it describes
 * what this deployment actually sells, one column each: Free always (the open
 * pool, and the user's own keys while no membership is required); Pay as you
 * go while credit is sold, which anyone may buy, member or not; Your own key
 * while the membership is required, which own keys need in Learn and power
 * mode alike. The open pool has the same limits for everyone, so every column
 * shows the same pool line. The pool is free credit Tangent provides; nothing
 * here offers it for sale or calls it a donation. Each pool line on the plan
 * cards says the replies last only while the pool has credit, with its
 * balance from the landing page's cached meter.
 */

/** Everything the page states, resolved from the config (one place, for the tests too). */
export interface PricingFacts extends Offer {
  /** The open pool, while Learn may spend from it (`poolAvailable`). */
  pool: {
    /** The pool's model and how it is asked against the tier that runs it (`poolModelInfo`). */
    model: PoolModelInfo;
    maxOutputTokens: number;
    /** Each learner's daily caps, the same for everyone. */
    caps: PoolDailyCaps;
    /** What the pool can spend right now (the meter's `availableMicros`); null when it couldn't be read. */
    availableMicros: number | null;
  } | null;
}

export function pricingFacts(
  env: AppEnv,
  sharing: boolean,
  poolAvailableMicros: number | null = null,
): PricingFacts {
  const { pool } = appConfig(env);
  return {
    ...offerOf(env, sharing),
    pool: poolAvailable(env)
      ? {
          model: poolModelInfo(env),
          maxOutputTokens: pool.maxOutputTokens,
          caps: pool.caps.user,
          availableMicros: poolAvailableMicros,
        }
      : null,
  };
}

/**
 * The pool's model as a noun phrase: "the Normal model" when the pool asks
 * the tier's model the same way (or runs a model of its own), else "Normal's
 * model with lighter thinking and shorter replies" (`poolModelText`).
 */
function poolModelNoun(model: PoolModelInfo, opts: { replies?: boolean } = {}): string {
  return poolModelDifferences(model, opts).length === 0
    ? `the ${model.label} model`
    : poolModelText(model, opts);
}

type NoteId = 'pool' | 'own-key' | 'credit' | 'top-up' | 'membership' | 'power-read' | 'search';

/**
 * Numbered notes, numbered in the order the page renders their citations
 * (Hono renders a page top to bottom, and the list comes last). The first
 * citation of a note carries the anchor its back link returns to; a note
 * never cited isn't listed.
 */
function footnotes(texts: Partial<Record<NoteId, Child>>) {
  const cited: NoteId[] = [];
  return {
    Ref(props: { id: NoteId }) {
      const { id } = props;
      if (texts[id] === undefined) throw new Error(`pricing: no text for note ${id}`);
      const first = !cited.includes(id);
      if (first) cited.push(id);
      const n = cited.indexOf(id) + 1;
      return (
        <sup class="fn">
          <a href={`#note-${id}`} id={first ? `ref-${id}` : undefined} aria-label={`Note ${n}`}>
            {n}
          </a>
        </sup>
      );
    },
    List() {
      return (
        <ol>
          {cited.map((id) => (
            <li id={`note-${id}`}>
              {texts[id]}{' '}
              <a class="back" href={`#ref-${id}`} aria-label="Back to the text">
                ↩
              </a>
            </li>
          ))}
        </ol>
      );
    },
  };
}

/** What the reader pays per 1¢ of the provider's price on credit: `1.16` for a 5.5% fee and a 10% markup. */
function perCent(credit: NonNullable<PricingFacts['credit']>): string {
  return (((10_000 + credit.openRouterFeeBps) * (10_000 + credit.markupBps)) / 1e8).toFixed(2);
}

/** The notes' fine print, for the features this deployment offers. */
function noteTexts(f: PricingFacts): Partial<Record<NoteId, Child>> {
  const { pool, credit, membership } = f;
  const searches = f.grounding !== 'off';
  // The power-mode providers other than Learn's (OpenRouter), as `Anthropic and OpenAI`.
  const others = joinList(
    f.providers.filter((p) => p.id !== OPENROUTER_PROVIDER_ID).map((p) => p.label),
    'and',
  );
  const texts: Partial<Record<NoteId, Child>> = {
    'own-key': `With your own key, the AI provider bills you directly, at its own prices, and Tangent adds nothing to that bill. Learn takes an OpenRouter key${searches ? ', which also works for web search' : ''}${others ? `; power mode also takes ${others} keys` : ''}.${membership ? ' Your own keys need the membership, in Learn and in power mode alike.' : ''}`,
  };
  if (pool) {
    texts.pool = (
      <>
        {POOL_FUNDING_TEXT} Pool replies use {poolModelNoun(pool.model, { replies: false })}, are at
        most {pool.maxOutputTokens.toLocaleString('en-US')} tokens long (roughly{' '}
        {roughWords(pool.maxOutputTokens)} words) and don’t search the web. While the pool has
        credit, each learner can use up to {pool.caps.requestsPerDay.toLocaleString('en-US')}{' '}
        replies or {formatMicros(pool.caps.spendMicrosPerDay)} of AI cost a day, whichever comes
        first. The limits are the same for everyone, whatever else they pay for, and reset at 00:00
        UTC. You need to be signed in and pass a quick check that you’re human, with one account per
        email address. <a href="/pool">How the pool works, with every limit</a>.
      </>
    );
  }
  if (credit) {
    const fee =
      credit.openRouterFeeBps > 0
        ? ` plus the ${formatBps(credit.openRouterFeeBps)} fee OpenRouter charges on credit purchases`
        : '';
    texts.credit = `You pay what each reply costs Tangent, plus Tangent’s ${formatBps(credit.markupBps)} markup. Tangent’s cost is OpenRouter’s price${fee}. So for every 1¢ OpenRouter charges, you pay about ${perCent(credit)}¢. Summaries and titles made on credit are charged the same way, and your billing page lists every charge.`;
    texts['top-up'] = (
      <>
        Top up {formatCents(credit.minTopUpCents)} to {formatCents(credit.maxTopUpCents)} at a time.
        Tax is added at checkout. The payment processor’s fee (a percentage plus a fixed amount)
        comes out of the credit you receive, so larger top-ups lose a smaller share to it. Credit
        doesn’t expire while your account exists. It can’t be transferred, and it isn’t refundable,
        except where the law requires it or Polar’s terms for buyers allow it. Polar, our merchant
        of record, handles checkout, tax and receipts (<a href="/terms">terms</a>, section 7).
        {membership && ' Buying and spending credit never needs a membership.'}
      </>
    );
  }
  if (membership) {
    texts.membership = (
      <>
        {formatCents(membership.priceCents)} a year plus tax. It renews every year until you cancel,
        and one membership covers your own keys in both Learn and power mode.
        {credit && ' Credit is separate: anyone can buy it, member or not.'} Cancel any time under{' '}
        <strong>Manage billing</strong>; your membership lasts until the end of the year you paid
        for.
      </>
    );
    // A copy in Learn can only get replies without a membership on the pool or on credit.
    const learnOn =
      pool && credit
        ? 'the open pool or on Tangent credit'
        : pool
          ? 'the open pool'
          : credit
            ? 'Tangent credit'
            : '';
    texts['power-read'] = (
      <>
        Without a membership, you can still open, read and export everything you made on your own
        keys
        {learnOn && (
          <>
            , and use <strong>Create a copy in Learn</strong> to continue a power-mode conversation
            there, on {learnOn}
          </>
        )}
        .{credit && ' Power mode on Tangent credit needs no membership.'}
      </>
    );
  }
  if (searches) {
    const when =
      f.grounding === 'explicit' ? (
        <>
          On request: choose <strong>Check sources</strong> under an answer, and the tutor searches
          the web, rechecks what it said and cites what it found.
        </>
      ) : (
        <>
          {f.grounding === 'always-offer'
            ? 'On any reply'
            : 'When a reply probably needs checking (a specific date or figure, something recent, a few tangents deep, or when you ask for sources)'}
          , the tutor may search the web once and list its sources under the answer. Or choose{' '}
          <strong>Check sources</strong> under an answer to search on demand.
        </>
      );
    // About 1¢ is OpenRouter's Exa price with up to 10 results; other engines and more results differ.
    const price = f.searchAboutOneCent
      ? 'A search adds about 1¢ to the cost of that reply.'
      : 'A search adds to the cost of that reply.';
    const capped = credit && f.grounding !== 'explicit' && f.searchDailyCap > 0;
    // The power-mode providers that can't search the web, as `OpenAI` or `OpenAI or Mistral`.
    const unable = joinList(
      f.providers.filter((p) => !p.search).map((p) => p.label),
      'or',
    );
    const where = unable
      ? ` It isn’t available with ${unable} keys${pool ? ', and it’s off on the open pool' : ''}.`
      : pool
        ? ' It’s off on the open pool.'
        : '';
    texts.search = (
      <>
        {when} {price}
        {capped && (
          <>
            {' '}
            On credit, automatic searches stop after {f.searchDailyCap.toLocaleString('en-US')} a
            day; <strong>Check sources</strong> always works.
          </>
        )}
        {where}
      </>
    );
  }
  return texts;
}

/** A chart cell: included, not included, or a short phrase. */
type Cell = boolean | Child;

function ChartCell(props: { cell: Cell }) {
  const { cell } = props;
  if (cell === true)
    return (
      <td class="yes">
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2.5"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <path d="M5 12.5l4.5 4.5L19 7.5" />
        </svg>
        <span class="sr-only">Included</span>
      </td>
    );
  if (cell === false)
    return (
      <td class="no">
        <span aria-hidden="true">—</span>
        <span class="sr-only">Not included</span>
      </td>
    );
  return <td>{cell}</td>;
}

/**
 * The pool's condition, stated under each pool line of the plan cards: the
 * replies are there only while the pool has credit, and how much it has now.
 */
function WhilePoolHasCredit(props: { availableMicros: number | null }) {
  const { availableMicros } = props;
  const now =
    availableMicros === null
      ? ''
      : availableMicros > 0
        ? ` · currently ${formatMicros(availableMicros)}`
        : ' · empty right now';
  return <span class="while">While the pool has credit{now}</span>;
}

function perDay(caps: PoolDailyCaps): string {
  return `${caps.requestsPerDay.toLocaleString('en-US')} a day`;
}

/** The headline, for whichever ways to pay this deployment offers. */
function headline(f: PricingFacts): string {
  if (f.membership) {
    const price = formatCents(f.membership.priceCents);
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
      `${pool ? 'For more replies or power mode, buy' : 'Buy'} prepaid credit${membership ? ', with no subscription,' : ''} and pay for each reply at what it costs Tangent, plus ${formatBps(credit.markupBps)}.`,
    );
  if (membership)
    parts.push(
      `${pool || credit ? 'With your own API key, your' : 'Bring your own API key: your'} AI provider bills you directly, and a ${formatCents(membership.priceCents)} yearly membership covers Tangent itself.`,
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
      `A rule of thumb: if you’d spend less than about ${formatCents(breakEven)} a year on AI, credit costs you less; if more, your own key does.`,
    );
  if (!membership) parts.push('No subscription, nothing to cancel.');
  return parts.join(' ');
}

/** The pricing chart's columns, left to right: Free, then each way to pay this deployment offers. */
type Column = 'free' | 'credit' | 'key';

/** One row of the chart: a cell per column (a column the deployment doesn't offer is skipped). */
type Row = { label: Child } & Record<Column, Cell>;

function PricingBody(props: { facts: PricingFacts }) {
  const f = props.facts;
  const { pool, credit, membership } = f;
  const { Ref, List } = footnotes(noteTexts(f));
  const searches = f.grounding !== 'off';
  const columns: { id: Column; name: string }[] = [
    { id: 'free', name: 'Free' },
    ...(credit ? [{ id: 'credit' as const, name: 'Pay as you go' }] : []),
    ...(membership ? [{ id: 'key' as const, name: 'Your own key' }] : []),
  ];

  const freeCard = (
    <article class={pool ? 'plan featured' : 'plan'}>
      <h3>Free</h3>
      <p class="price">$0</p>
      <p class="for">
        {pool
          ? 'Learn every day on the open pool.'
          : membership
            ? 'See how Tangent works in the demo.'
            : 'Learn on your own OpenRouter key.'}
      </p>
      <ul>
        {pool && (
          <li>
            {pool.caps.requestsPerDay.toLocaleString('en-US')} free replies a day on the open pool
            <Ref id="pool" />
            <WhilePoolHasCredit availableMicros={pool.availableMicros} />
          </li>
        )}
        {!membership && (
          <>
            <li>
              Your own OpenRouter key in Learn, with nothing added by Tangent
              <Ref id="own-key" />
            </li>
            <li>Every power-mode control, on your own keys</li>
          </>
        )}
        <li>The demo, with no sign-up</li>
      </ul>
      <a class={pool ? 'btn primary' : 'btn'} href="/learn/login">
        {pool ? 'Start learning free' : 'Start learning'}
      </a>
    </article>
  );

  const creditCard = credit && (
    <article class="plan">
      <h3>Pay as you go</h3>
      <p class="price">
        At cost<small> + {formatBps(credit.markupBps)} a reply</small>
        <Ref id="credit" />
      </p>
      <p class="for">
        Prepaid credit: no key to manage, no subscription{membership && ', no membership'}.
      </p>
      <ul>
        <li>Everything in Free</li>
        <li>
          {f.tiers ? `The ${f.tiers.max} tier in Learn` : 'Learn on credit'}, and any OpenRouter
          model in power mode
        </li>
        {searches && (
          <li>
            {f.grounding === 'explicit'
              ? 'Web search to check any answer'
              : 'Web search when an answer needs it'}
          </li>
        )}
        <li>
          Top up from {formatCents(credit.minTopUpCents)}; credit doesn’t expire
          <Ref id="top-up" />
        </li>
      </ul>
      <a class="btn" href="/learn/login">
        Sign in to add credit
      </a>
    </article>
  );

  const keyCard = membership && (
    <article class="plan">
      <h3>Your own key</h3>
      <p class="price">
        {formatCents(membership.priceCents)}
        <small> a year + tax</small>
        <Ref id="membership" />
      </p>
      <p class="for">Your AI provider bills you directly; a yearly membership covers Tangent.</p>
      <ul>
        <li>Everything in Free</li>
        <li>
          Learn and power mode on your own API keys
          <Ref id="own-key" />
        </li>
        <li>Nothing added to your AI provider’s bill</li>
      </ul>
      <a class="btn" href="/learn/login">
        Sign in to join
      </a>
    </article>
  );
  const plans = [freeCard, creditCard, keyCard].filter((card) => card !== null);

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
      label: (
        <>
          Free replies on the open pool
          <Ref id="pool" />
        </>
      ),
      free: perDay(pool.caps),
      credit: perDay(pool.caps),
      key: perDay(pool.caps),
    });
  learn.push({
    label: (
      <>
        Your own OpenRouter key
        <Ref id="own-key" />
      </>
    ),
    free: keysFree,
    credit: keysFree,
    key: true,
  });
  if (f.tiers)
    learn.push({
      label: `The ${f.tiers.max} tier, for the hardest questions`,
      free: keysFree && 'On your key',
      credit: true,
      key: true,
    });
  if (searches)
    learn.push({
      label: (
        <>
          Web search, with sources
          <Ref id="search" />
        </>
      ),
      free: keysFree && 'On your key',
      credit: true,
      key: true,
    });

  const power: Row[] = [
    {
      label: 'Every control: context modes, inspector, reviewer, system prompts',
      free: keysFree ? (
        'On your keys'
      ) : (
        <>
          Read and export
          <Ref id="power-read" />
        </>
      ),
      credit: true,
      key: true,
    },
    {
      label: f.providers.length
        ? `Your own ${joinList(
            f.providers.map((p) => p.label),
            'and',
          )} keys`
        : 'Your own API keys',
      free: keysFree,
      credit: keysFree,
      key: true,
    },
  ];
  if (credit)
    power.push({
      label: 'Any OpenRouter model, on prepaid credit',
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
      credit: credit && (
        <>
          At cost + {formatBps(credit.markupBps)}
          <Ref id="credit" />
        </>
      ),
      key: membership && (
        <>
          {formatCents(membership.priceCents)} a year
          <Ref id="membership" />
        </>
      ),
    },
    {
      label: 'Tangent’s charge on your own key',
      free: keysFree && 'Nothing',
      credit: keysFree && 'Nothing',
      key: 'Nothing per reply',
    },
  ];
  if (credit)
    cost.push({
      label: 'Prepaid credit',
      free: false,
      credit: (
        <>
          Top up from {formatCents(credit.minTopUpCents)}
          <Ref id="top-up" />
        </>
      ),
      key: 'Bought separately',
    });

  const group = (title: string, rows: Row[]) => (
    <>
      <tr class="group">
        <th scope="colgroup" colspan={columns.length + 1}>
          {title}
        </th>
      </tr>
      {rows.map((r) => (
        <tr>
          <th scope="row">{r.label}</th>
          {columns.map((col) => (
            <ChartCell cell={r[col.id]} />
          ))}
        </tr>
      ))}
    </>
  );

  return (
    <main>
      <div class="wrap intro">
        <p class="eyebrow">Pricing</p>
        <h1>{headline(f)}</h1>
        <p class="lede">{lede(f)}</p>
      </div>
      <div class="wrap">
        <h2 class="sr-only">Plans</h2>
        <div class={`plans ${['one', 'two', 'three'][plans.length - 1]}`}>{plans}</div>
      </div>
      {pool && (
        // Why there's a free plan: the pool as Tangent's own policy, with its catch (one
        // model, daily limits, only while it has credit), never tied to the reader's
        // purchase: paying for Tangent pays for Tangent, so no sale reads as a donation.
        <section class="why" aria-labelledby="why">
          <div class="wrap">
            <p class="eyebrow">The open pool</p>
            <h2 id="why">Why there’s a free plan</h2>
            <p class="sub">
              {POOL_MOTTO} Free replies come from the open pool: free credit Tangent provides. They
              use {poolModelNoun(pool.model)}, have daily limits and are available only while the
              pool has credit. <a href="/pool">How the pool works</a>
            </p>
            <PoolSteps offer={f} />
          </div>
        </section>
      )}
      <section aria-labelledby="compare">
        <div class="wrap">
          <h2 id="compare">Exactly what you get</h2>
          <p class="sub">The numbered notes under the chart have the details.</p>
          <div class="chart">
            <table>
              <caption class="sr-only">What each plan includes</caption>
              <thead>
                <tr>
                  <td></td>
                  {columns.map((col) => (
                    <th scope="col">{col.name}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {group('Learn', learn)}
                {group('Power mode', power)}
                {group('Cost', cost)}
              </tbody>
            </table>
          </div>
          <div class="notes">
            <h3>Notes</h3>
            <List />
          </div>
        </div>
      </section>
    </main>
  );
}

/** What the pool can spend now, through the meter's edge cache; null while it is off or can't be read. */
async function poolAvailableMicros(c: Context<AppBindings>): Promise<number | null> {
  if (!poolAvailable(c.env)) return null;
  try {
    return (await cachedPoolStatus(c.env, waitUntilOf(c))).availableMicros;
  } catch (err) {
    logEvent('warn', 'pool_meter_unreadable', { page: 'pricing', error: err });
    return null;
  }
}

/** `GET /pricing`, public (mounted at the root by `createApp`; listed in run_worker_first). */
export function pricingPageRoutes(): Hono<AppBindings> {
  const app = new Hono<AppBindings>();
  app.get('/pricing', async (c) => {
    const info = legalInfo(c.env, c.req.raw);
    const facts = pricingFacts(c.env, info.sharing, await poolAvailableMicros(c));
    return pageResponse(
      {
        path: '/pricing',
        origin: info.origin,
        title: 'Pricing · Tangent',
        description: 'What you can do on Tangent for free, and exactly what paying gets you.',
        style: PRICING_STYLE,
        nav: { label: 'Account', links: ['learn', 'power'] },
        footer: {
          operator: info.operator,
          links: ['demo', 'about', 'pricing', 'pool', 'privacy', 'terms'],
        },
      },
      <PricingBody facts={facts} />,
      { headers: { 'Cache-Control': 'public, max-age=300' } },
    );
  });
  return app;
}
