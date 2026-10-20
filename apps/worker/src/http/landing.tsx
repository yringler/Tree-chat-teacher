import {
  androidAppStoreUrl,
  formatCents,
  formatMicros,
  formatServiceFee,
  HELP_TITLE,
  joinList,
  POOL_AT_COST_TEXT,
  POOL_EMPTY_TEXT,
  POOL_MOTTO,
  poolSessionsHeadline,
  type PoolStatusResponse,
} from '@tangent/shared';
import { Hono, type Context } from 'hono';
import type { Child } from 'hono/jsx';
import { authConfigured, socialProviderFlags, type SocialProviderFlags } from '../auth/auth.js';
import { appConfig } from '../config.js';
import type { AppBindings, AppEnv } from '../env.js';
import { logEvent } from '../log.js';
import { cachedPoolStatus } from '../pool/status.js';
import { waitUntilOf } from '../routes/pool.js';
import { offerOf, PoolSteps, type Offer } from './copy.js';
import { LandingDemo } from './landing-demo.js';
import { pageResponse } from './layout.js';
import { LEARN_APP_CSP, LEARN_COMMON_HEADERS } from './learn-app.js';
import { legalInfo } from './legal-info.js';
import { LANDING_STYLE } from './page-styles.js';
import { TangentHelpCard } from './tangent-help.js';

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

/** What the landing page states: the deployment's offer, and the pool's meter while the pool is on. */
interface Landing extends Offer {
  /** The open pool's meter; absent when the pool is off or couldn't be read. */
  pool?: PoolStatusResponse;
  /** Which OAuth providers this deployment signs in with. */
  social: SocialProviderFlags;
  /** The Play Store id of this deployment's Android app (`ANDROID_APP_ID`); null = none. */
  androidAppId: string | null;
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
 * credit. `others` is how else replies are paid for, under the pool.
 */
function PoolSection(props: { pool: PoolStatusResponse; page: Landing; others: Child }) {
  const { pool } = props;
  return (
    <section aria-labelledby="pool">
      <div class="wrap">
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
        <p class="after">{props.others}</p>
      </div>
    </section>
  );
}

/**
 * What replies cost, in one section: the open pool while it is on, then the
 * user's own OpenRouter key always (with the yearly membership, when one is
 * required, so the own key alone is "free" only where none is), and prepaid
 * credit while it is sold (to anyone, no membership needed).
 */
function CostSection(props: { page: Landing }) {
  const { pool, credit, membership } = props.page;
  const parts = [
    `${pool ? 'Or use' : 'Use'} your own OpenRouter key: you pay OpenRouter directly, and ${membership ? `a ${formatCents(membership.priceCents)} yearly membership covers Tangent` : 'Tangent charges nothing'}.`,
  ];
  if (credit)
    parts.push(
      `Or buy prepaid credit${membership ? ', with no membership needed,' : ''} and pay each reply’s list price, plus a ${formatServiceFee(credit.serviceFee)} service fee on each top-up.`,
    );
  const others = (
    <>
      {parts.join(' ')} <a href="/pricing">See exactly what’s free and what’s paid</a>
    </>
  );
  if (pool) return <PoolSection pool={pool} page={props.page} others={others} />;
  const title = credit
    ? 'Your key, or pay as you go'
    : membership
      ? 'On your own key'
      : 'Free on your own key';
  return (
    <section aria-labelledby="cost">
      <div class="wrap">
        <h2 id="cost">{title}</h2>
        <p class="sub">{others}</p>
      </div>
    </section>
  );
}

/** Power mode and Canvas, for the visitor who wants more than Learn. */
function MoreWays(props: { page: Landing }) {
  const { providers, sharing } = props.page;
  return (
    <section aria-labelledby="modes">
      <div class="wrap">
        <h2 id="modes">More ways in</h2>
        <p class="sub">Learn, Power and Canvas share one sign-in.</p>
        <div class="grid two">
          <article class="card">
            <h3>Want every control?</h3>
            <p>
              Power mode takes your own API keys for{' '}
              {providers.length
                ? joinList(
                    providers.map((p) => p.label),
                    'or',
                  )
                : 'any provider this server offers'}
              , and adds context modes, the context inspector and a reviewer
              {sharing && ', plus read-only share links'}. <a href="/login">Power sign in</a>
            </p>
          </article>
          <article class="card">
            <h3>Feeling brave?</h3>
            <p>
              Canvas lays out a whole conversation as a map, every tangent at once. It’s
              experimental. <a href="/canvas/demo">Try Canvas</a>
            </p>
          </article>
        </div>
      </div>
    </section>
  );
}

/**
 * How signing in works and what it shares, linking the privacy policy: Google's
 * OAuth verification asks the home page to say why the app requests user data.
 */
function AccountSection(props: { social: SocialProviderFlags }) {
  const { google, github } = props.social;
  const methods = [
    'your email address',
    ...(google ? ['Google'] : []),
    ...(github ? ['GitHub'] : []),
  ];
  return (
    <section aria-labelledby="account">
      <div class="wrap">
        <h2 id="account">Your account and your data</h2>
        <p class="sub">
          Sign in with {joinList(methods, 'or')}.
          {google &&
            ' If you sign in with Google, Tangent receives your name, email address and profile picture, and uses them only to create your account and sign you in.'}{' '}
          We never sell your data, show ads, or train AI models on your conversations.{' '}
          <a href="/privacy">Privacy policy</a> · <a href="/terms">Terms of service</a>
        </p>
      </div>
    </section>
  );
}

/**
 * One problem and its fix, as one card: stacked and labeled on a phone, side
 * by side under the column heads on a wide screen, so each fix reads as the
 * answer to its own problem at every width.
 */
function Pair(props: { problem: string; fix: string }) {
  return (
    <div class="pair">
      <dt>
        <span class="tag">Regular AI chat</span>
        {props.problem}
      </dt>
      <dd>
        <span class="tag">Tangent</span>
        {props.fix}
      </dd>
    </div>
  );
}

/**
 * The closing call to action, for the visitor who read to the end, and the
 * Android app's store page, which every visitor gets since a computer's Play
 * page installs on the visitor's phone.
 */
function StartSection(props: { page: Landing }) {
  const { page } = props;
  return (
    <section aria-labelledby="start">
      <div class="wrap">
        <h2 id="start">Ask your first question</h2>
        <div class="ctas">
          <a class="btn primary" href="/learn/login">
            {poolOpen(page.pool) ? 'Start learning free' : 'Start learning'}
          </a>
          <a class="btn" href="/learn/demo">
            Try the demo
          </a>
        </div>
        {page.androidAppId && (
          <p class="note">
            On Android? Learn is an app too, made for your phone.{' '}
            <a href={androidAppStoreUrl(page.androidAppId, 'landing')}>Get it on Google Play</a>
          </p>
        )}
      </div>
    </section>
  );
}

/**
 * The landing page's body, in the order a visitor's questions come: what it
 * is (the hero and its demo), why (the problem and fix), how to use it (how
 * tangents work), what it costs, what else there is, what happens to their
 * data, and where to start. The hero stays short so the demo starts near the
 * top of a phone's screen.
 */
function LandingBody(props: { page: Landing }) {
  const { page } = props;
  const free = poolOpen(page.pool);
  return (
    <main>
      <div class="wrap hero">
        <div>
          <h1>Go off on a tangent. Without losing your place.</h1>
          <p class="lede">An AI tutor where any follow-up question can go on its own tangent.</p>
          <div class="ctas">
            <a class="btn primary" href="/learn/demo">
              Try the demo
            </a>
            <a class="btn" href="/learn/login">
              {free ? 'Start learning free' : 'Start learning'}
            </a>
          </div>
          <p class="note">
            The demo needs no sign-up and no AI: its replies are playful nonsense that show how
            tangents work.
          </p>
          {free && (
            <p class="free">
              <strong>No credit card needed.</strong> Learn free on the open pool, within daily
              limits. <a href="#pool">How it works</a>
            </p>
          )}
          <a class="help-link" href="#how-tangents">
            {HELP_TITLE}
          </a>
        </div>
        <LandingDemo />
      </div>
      <section aria-labelledby="fix">
        <div class="wrap">
          <h2 id="fix">What happens to your follow-up questions</h2>
          <p class="sub">In a regular AI chat, then in Tangent.</p>
          <div class="pairs-head" aria-hidden="true">
            <span>Regular AI chat</span>
            <span>Tangent</span>
          </div>
          <dl class="pairs">
            <Pair
              problem="The answer raises three more questions."
              fix="Each one opens as its own tangent."
            />
            <Pair
              problem="You chase one, then another. Your first answer is now 40 messages up."
              fix="Your first answer stays exactly where you left it."
            />
            <Pair
              problem="You scroll back past what you already know and what you don’t care about."
              fix="You see only the thread you’re on. Your tangents wait until you want them."
            />
          </dl>
          <p class="after">
            Not sure what to ask next? Full answers end with a way to keep going and a few tangents
            worth following, one tap away.
          </p>
        </div>
      </section>
      <TangentHelpCard />
      <CostSection page={page} />
      <MoreWays page={page} />
      <AccountSection social={page.social} />
      <StartSection page={page} />
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
  const page: Landing = {
    ...offerOf(c.env, info.sharing),
    pool: await landingPool(c),
    social: socialProviderFlags(c.env),
    androidAppId: appConfig(c.env).site.androidAppId,
  };
  return pageResponse(
    {
      path: '/',
      origin: info.origin,
      title: 'Tangent: go off on a tangent without losing your place',
      description:
        'An AI tutor where every side trip is a tangent, so your main lesson stays right where you left it.',
      social: true,
      style: LANDING_STYLE,
      nav: { label: 'Site', links: ['learn', 'help', 'power', 'pricing'] },
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
