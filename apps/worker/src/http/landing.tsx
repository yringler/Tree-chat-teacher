import {
  formatBps,
  formatCents,
  formatMicros,
  POOL_AT_COST_TEXT,
  POOL_EMPTY_TEXT,
  POOL_MOTTO,
  poolModelText,
  poolSessionsHeadline,
  type PoolStatusResponse,
} from '@tangent/shared';
import { Hono, type Context } from 'hono';
import type { Child } from 'hono/jsx';
import { authConfigured } from '../auth/auth.js';
import { appConfig } from '../config.js';
import type { AppBindings, AppEnv } from '../env.js';
import { logEvent } from '../log.js';
import { cachedPoolStatus } from '../pool/status.js';
import { waitUntilOf } from '../routes/pool.js';
import { joinList, offerOf, PoolSteps, type Offer } from './copy.js';
import { pageResponse } from './layout.js';
import { LEARN_APP_CSP, LEARN_COMMON_HEADERS } from './learn-app.js';
import { legalInfo } from './legal-info.js';
import { LANDING_STYLE } from './page-styles.js';

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
  return !authConfigured(env) && appConfig(env).auth.devAllowNoAuth;
}

/** A 20×20 stroke icon for a feature card. */
function Icon(props: { children: Child }) {
  return (
    <span class="icon">
      <svg
        width="20"
        height="20"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        {props.children}
      </svg>
    </span>
  );
}

/** What the landing page states: the deployment's offer, and the pool's meter while the pool is on. */
interface Landing extends Offer {
  /** The open pool's meter; absent when the pool is off or couldn't be read. */
  pool?: PoolStatusResponse;
}

/** True when the pool is on and can cover at least one more learning session: only then is "free" promised. */
function poolOpen(pool: PoolStatusResponse | undefined): pool is PoolStatusResponse {
  return pool !== undefined && pool.sessionsRemaining > 0;
}

/**
 * The open pool section: why it exists, where its credit comes from and the
 * meter. It is Tangent's own commitment, funded by the operator's admin
 * adjustments: nothing here is for sale, and nothing asks the visitor to pay
 * for anyone else. The free sign-up button shows only while the pool has
 * credit.
 */
function PoolSection(props: { pool: PoolStatusResponse; page: Landing }) {
  const { pool } = props;
  return (
    <section aria-labelledby="pool">
      <div class="wrap">
        <p class="eyebrow">The open pool</p>
        <h2 id="pool">Curiosity shouldn’t need a credit card</h2>
        <p class="sub">
          Every AI reply costs real money, so good AI tutoring usually sits behind a paywall.{' '}
          {POOL_MOTTO} Here’s how:
        </p>
        <div class="pool">
          <PoolSteps offer={props.page} />
          <p class="meter">
            {pool.sessionsRemaining > 0
              ? `${poolSessionsHeadline(pool.sessionsRemaining)} left`
              : POOL_EMPTY_TEXT}
            <small>{formatMicros(pool.availableMicros)} in the pool</small>
          </p>
          <div class="ctas">
            {poolOpen(pool) && (
              <a class="btn primary" href="/learn/login">
                Start learning free
              </a>
            )}
            <a class="btn" href="/pool">
              How the pool works
            </a>
          </div>
          <p class="fee">{POOL_AT_COST_TEXT}</p>
        </div>
      </div>
    </section>
  );
}

/**
 * The feature card on web-search grounding, worded for the operator's ceiling: offered when a reply
 * likely needs it and the model decides (`auto`, `always-offer`), or only on
 * request (`explicit`). Never promises that every answer is checked, and,
 * while the pool is shown, says that pool replies don't search.
 */
function GroundingCard(props: { page: Landing }) {
  const { grounding, pool, credit } = props.page;
  if (grounding === 'off') return null;
  const notPool = pool
    ? ` Web search works on your own OpenRouter key${credit ? ' or prepaid credit' : ''}, not on the free open pool.`
    : '';
  const icon = (
    <Icon>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5M8 11l2 2 4-4" />
    </Icon>
  );
  if (grounding === 'explicit') {
    return (
      <article class="card">
        {icon}
        <h3>Check any answer against the web</h3>
        <p>
          Not sure about a detail? Choose <strong>Check sources</strong> under an answer, and the
          tutor searches the web, rechecks what it said and cites what it found.{notPool}
        </p>
      </article>
    );
  }
  return (
    <article class="card">
      {icon}
      <h3>Checked against the web when you go deep</h3>
      <p>
        The further down a tangent you go, the likelier an AI is to get a detail wrong. So when a
        reply needs it (a specific date or figure, something recent, a few branches deep, or when
        you ask for sources), the tutor can search the web and list its sources under the answer. An
        answer from the tutor’s own knowledge says so, and <strong>Check sources</strong> has the
        tutor look it up.{notPool}
      </p>
    </article>
  );
}

/**
 * The card on how replies are paid for: the open pool while it is on,
 * prepaid credit while it is sold (to anyone, no membership needed), and the
 * user's own OpenRouter key always (with the yearly membership, when one is
 * required, so the own key alone is "free" only where none is).
 */
function PayCard(props: { page: Landing }) {
  const { pool, credit, membership } = props.page;
  const title = pool
    ? credit
      ? 'Free, your key, or pay as you go'
      : 'Free, or on your own key'
    : credit
      ? 'Your key, or pay as you go'
      : membership
        ? 'On your own key'
        : 'Free on your own key';
  const parts: string[] = [];
  if (pool) parts.push('Learn free on the open pool, within daily limits, while it has credit.');
  parts.push(
    `${pool ? 'Or use' : 'Use'} your own OpenRouter key: you pay OpenRouter directly, and ${membership ? `a ${formatCents(membership.priceCents)} yearly membership covers Tangent` : 'Tangent charges nothing'}.`,
  );
  if (credit)
    parts.push(
      `Or buy prepaid credit and pay for each reply at what it costs Tangent, plus ${formatBps(credit.markupBps)}${membership ? ', with no membership needed' : ''}.`,
    );
  return (
    <article class="card">
      <Icon>
        <circle cx="12" cy="12" r="9" />
        <path d="M15 9.5c-.5-1-1.6-1.5-3-1.5-1.8 0-3 .9-3 2s1 1.7 3 2 3 .9 3 2-1.2 2-3 2c-1.4 0-2.5-.5-3-1.5M12 6.5V8M12 16v1.5" />
      </Icon>
      <h3>{title}</h3>
      <p>
        {parts.join(' ')} <a href="/pricing">See exactly what’s free and what’s paid</a>
      </p>
    </article>
  );
}

/** The Learn card's list: what Learn does, then the ways to pay for it. */
function LearnItems(props: { page: Landing }) {
  const { pool, credit, membership, tiers } = props.page;
  return (
    <ul>
      <li>Straight answers that explain how things work, ready the moment you sign in</li>
      <li>Suggested tangents after each full answer, one tap away</li>
      <li>
        Side questions about any phrase with <strong>Ask about this</strong>
      </li>
      {tiers && (
        <li>
          Two tiers: {tiers.normal} for everyday learning, {tiers.max} for the hardest questions
          {pool && ` (the free pool uses ${poolModelText(pool.model)})`}
        </li>
      )}
      {pool && (
        <li>Learn free on the open pool, within daily limits, on credit Tangent provides</li>
      )}
      <li>
        {pool ? 'Or use your' : 'Your'} own OpenRouter key,{' '}
        {membership
          ? `with a ${formatCents(membership.priceCents)} yearly membership and nothing charged per reply`
          : 'with nothing charged by Tangent'}
      </li>
      {credit && (
        <li>Or pay per reply from prepaid credit{membership && ', no membership needed'}</li>
      )}
    </ul>
  );
}

/** The Power card's list. */
function PowerItems(props: { page: Landing }) {
  const { providers, credit, sharing } = props.page;
  return (
    <ul>
      <li>
        Your own API keys for{' '}
        {providers.length
          ? joinList(
              providers.map((p) => p.label),
              'or',
            )
          : 'any provider this server offers'}
      </li>
      {credit && <li>Any OpenRouter model, on prepaid credit</li>}
      <li>Every control: context modes, the context inspector, a reviewer and system prompts</li>
      <li>
        {sharing ? 'Read-only share links, and Markdown or HTML export' : 'Markdown or HTML export'}
      </li>
      <li>Self-host it on your own Cloudflare account</li>
    </ul>
  );
}

/** The landing page's body: the hero, the features, the pool and the two modes. */
function LandingBody(props: { page: Landing }) {
  const { page } = props;
  const free = poolOpen(page.pool);
  const start = free ? 'Start learning free' : 'Start learning';
  return (
    <main>
      <div class="wrap hero">
        <div>
          <p class="eyebrow">An AI tutor built for rabbit holes</p>
          <h1>Follow every tangent. Never lose the thread.</h1>
          <p class="lede">
            Ask anything and get a straight answer that explains how it actually works. Then pick a
            tangent to follow. Each one opens in its own branch, so you can wander as far as you
            like and come back to the main thread right where you left it.
          </p>
          <div class="ctas">
            <a class="btn primary" href="/learn/demo">
              Try the demo
            </a>
            <a class="btn" href="/learn/login">
              {start}
            </a>
          </div>
          {free && (
            <p class="free">
              <strong>No credit card needed.</strong> Tangent provides free credit in the open pool,
              so anyone signed in can learn here free, within daily limits.{' '}
              <a href="#pool">How it works</a>
            </p>
          )}
          <p class="note">
            The demo needs no sign-up and runs entirely in your browser. No AI is involved, so its
            replies and sources are playful nonsense: it’s there to show you how branching works.
          </p>
          <p class="power">
            <a href="/login">Power users: sign in</a> ·{' '}
            <a href="/canvas/demo">Feeling brave? Try Canvas</a>, an experimental map of a whole
            conversation
          </p>
        </div>
        <figure
          class="demo"
          aria-label="Example: an answer, its tangents, and a side question branching off it"
        >
          <p class="msg you">Why does ice float?</p>
          <p class="msg tutor">
            Because water expands when it freezes. In the liquid, molecules tumble past each other;
            in ice, each one locks into a hexagonal lattice held open by <mark>hydrogen bonds</mark>
            , with more empty space than the liquid had. Same mass, more volume, lower density.
          </p>
          <div class="next">
            <span class="tag">Where next?</span>
            <span class="on">
              <b>Why lakes freeze from the top down</b>{' '}
              <i>— the same fact, seen from a fish's point of view</i>
            </span>
            <span>
              <b>The other substances that expand on freezing</b>{' '}
              <i>— silicon, gallium, and why they are rare</i>
            </span>
            <span>
              <b>What a hydrogen bond actually is</b> <i>— one layer down</i>
            </span>
          </div>
          <div class="side">
            <span class="tag">Ask about this</span>
            <p>Why hexagonal?</p>
            <p>
              A side question about a highlighted phrase. It opens in its own branch, and the main
              thread stays as it was.
            </p>
          </div>
        </figure>
      </div>
      <section aria-labelledby="features">
        <div class="wrap">
          <h2 id="features">Learning that follows your curiosity</h2>
          <p class="sub">
            Every lesson is a tree of branches, so the conversation stays easy to follow however
            many detours you take.
          </p>
          <div class="grid four">
            <article class="card">
              <Icon>
                <circle cx="12" cy="12" r="9" />
                <path d="m15.5 8.5-2.2 5-5 2.2 2.2-5z" />
              </Icon>
              <h3>Answers first, tangents next</h3>
              <p>
                Ask a question and the tutor answers it straight away, explaining how and why it
                works instead of quizzing you. Full answers end with a few tangents worth following,
                and one tap opens any of them in its own branch.
              </p>
            </article>
            <article class="card">
              <Icon>
                <circle cx="6" cy="5" r="2" />
                <circle cx="6" cy="19" r="2" />
                <circle cx="18" cy="9" r="2" />
                <path d="M6 7v10M18 11c0 4-6 3-11.5 6.5" />
              </Icon>
              <h3>Branch from any message</h3>
              <p>
                Highlight a phrase and choose <strong>Ask about this</strong>. Your side question
                opens in its own branch, so detours never clutter the main thread, and every branch
                stays one click away.
              </p>
            </article>
            <article class="card">
              <Icon>
                <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z" />
                <circle cx="12" cy="12" r="3" />
              </Icon>
              <h3>See exactly what the model sees</h3>
              <p>
                In power mode, choose how much each branch inherits: the whole conversation so far,
                a summary of it, or just the passage you branched from. The context inspector shows
                the exact prompt before it’s sent.
              </p>
            </article>
            <PayCard page={page} />
            <GroundingCard page={page} />
          </div>
        </div>
      </section>
      {page.pool && <PoolSection pool={page.pool} page={page} />}
      <section aria-labelledby="modes">
        <div class="wrap">
          <h2 id="modes">Two ways to use it</h2>
          <p class="sub">
            Learn and Power share one sign-in. Switch between them any time; each keeps its own
            conversations.
          </p>
          <div class="grid two">
            <article class="card mode learn">
              <h3>Learn</h3>
              <p class="for">For students and the curious. Nothing to set up.</p>
              <LearnItems page={page} />
              <a class="btn primary" href="/learn/login">
                {start}
              </a>
            </article>
            <article class="card mode">
              <h3>Power</h3>
              <p class="for">
                For tinkerers and self-hosters.
                {page.membership &&
                  ` Your own keys need the ${formatCents(page.membership.priceCents)} yearly membership, here as in Learn${page.credit ? '; prepaid credit needs none' : ''}.`}
              </p>
              <PowerItems page={page} />
              <a class="btn" href="/login">
                Power sign in
              </a>
            </article>
          </div>
        </div>
      </section>
    </main>
  );
}

/** The pool meter while the pool is on; omitted when it is off or can't be read (the page still renders). */
async function landingPool(c: Context<AppBindings>): Promise<PoolStatusResponse | undefined> {
  try {
    const status = await cachedPoolStatus(c.env, waitUntilOf(c));
    return status.enabled ? status : undefined;
  } catch (err) {
    logEvent('warn', 'pool_meter_unreadable', { page: 'landing', error: err });
    return undefined;
  }
}

/**
 * The landing page for anonymous visitors: no script, one constant
 * stylesheet allowed by hash; `headers` sets its caching.
 */
async function landingResponse(
  c: Context<AppBindings>,
  headers: Record<string, string>,
): Promise<Response> {
  const info = legalInfo(c.env, c.req.raw);
  const page: Landing = { ...offerOf(c.env, info.sharing), pool: await landingPool(c) };
  return pageResponse(
    {
      path: '/',
      origin: info.origin,
      title: 'Tangent: follow your curiosity, one branch at a time',
      description:
        'An AI tutor for rabbit holes. Ask anything, get a straight answer, then follow any tangent in its own branch without losing the main thread.',
      social: true,
      style: LANDING_STYLE,
      nav: { label: 'Site', links: ['learn', 'power', 'pricing'] },
      footer: {
        operator: info.operator,
        links: ['demo', 'learn', 'power', 'about', 'pricing', 'pool', 'privacy', 'terms'],
      },
    },
    <LandingBody page={page} />,
    { headers },
  );
}

/**
 * The landing page, mounted at the root by `createApp`.
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
