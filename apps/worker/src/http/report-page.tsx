import { REPORT_CATEGORIES, type ReportCategory, type Share } from '@tangent/shared';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { Child } from 'hono/jsx';
import { z } from 'zod';
import { authBaseUrl, turnstileHostname, type AuthDeps } from '../auth/auth.js';
import { clientIp, networkKey, userIdOfAccount } from '../auth/account.js';
import { optionalIdentity } from '../auth/session.js';
import { canShare } from '../availability.js';
import { sameOriginOnly } from '../byok/guard.js';
import { appConfig } from '../config.js';
import type { AppBindings } from '../env.js';
import { turnstileConfigured, verifyTurnstile } from '../pool/turnstile.js';
import { shareService } from '../registries.js';
import { goneSharePage, rateLimitedSharePage } from '../routes/share.js';
import { checkShareRateLimit } from '../share/rate-limit.js';
import { fileReport, reporterKeyOf } from '../share/reports.js';
import { pageResponse } from './layout.js';
import { REPORT_STYLE } from './page-styles.js';

/**
 * The report form a share page links to: `GET` and `POST /s/:token/report`.
 * Server-rendered with no script of our own, like `/verify`: Cloudflare's
 * Turnstile widget when it is configured, a form that posts back here, and
 * a thank-you. Anyone may report, signed in or not. Only a link that is up
 * can be reported; any other answers as a gone link does, so the form says
 * nothing about why a link is down.
 */

const DETAILS_MAX = 4000;
/**
 * The largest form body read: the fields at their longest, percent-encoded,
 * and Turnstile's token fit well inside it. Anything bigger isn't a report,
 * and a refused form echoes back what was typed.
 */
const BODY_MAX_BYTES = 64 * 1024;
/** The Turnstile widget's action on the report form. */
const REPORT_ACTION = 'share-report';

const LABELS: Record<ReportCategory, string> = {
  copyright: 'It copies someone’s work without permission (copyright)',
  defamation: 'It makes false claims about a real person',
  violent_or_illegal: 'It threatens or plans violence, or another crime',
  csam: 'It sexualises children',
  harassment_privacy: 'It harasses someone or exposes their personal information',
  other: 'Something else',
};

const reportForm = z.object({
  category: z.enum(REPORT_CATEGORIES, { error: 'Choose what is wrong with the conversation.' }),
  details: z
    .string()
    .trim()
    .min(1, 'Say what is wrong, and where in the conversation.')
    .max(DETAILS_MAX, `Keep the details under ${DETAILS_MAX.toLocaleString('en-US')} characters.`),
  email: z.union([
    z.literal(''),
    z.email({ error: 'That email address doesn’t look right.' }).max(254),
  ]),
});

interface FormValues {
  category: string;
  details: string;
  email: string;
}

interface ReportProps {
  action: string;
  siteKey: string | null;
  values: FormValues;
  error: string | null;
}

function ReportForm(props: ReportProps) {
  return (
    <main class="wrap doc report">
      <h1>Report this conversation</h1>
      <p>
        Tell us what is wrong with this shared conversation. We review every report, and take a link
        down at once when it may break the law.
      </p>
      <p class="hint">If someone is in immediate danger, contact your local emergency services.</p>
      {props.error && (
        <p class="error" role="alert">
          {props.error}
        </p>
      )}
      <form method="post" action={props.action}>
        <fieldset>
          <legend>What is wrong?</legend>
          {REPORT_CATEGORIES.map((category) => (
            <label class="choice">
              <input
                type="radio"
                name="category"
                value={category}
                required
                checked={props.values.category === category}
              />
              {LABELS[category]}
            </label>
          ))}
        </fieldset>
        <label class="field">
          <span>Details</span>
          <textarea name="details" required maxlength={DETAILS_MAX}>
            {props.values.details}
          </textarea>
        </label>
        <label class="field">
          <span>Your email (optional)</span>
          <input type="email" name="email" maxlength={254} value={props.values.email} />
          <span class="hint">
            Only if you want a reply. The conversation’s owner never sees it.
          </span>
        </label>
        {props.siteKey && (
          <div class="cf-turnstile" data-sitekey={props.siteKey} data-action={REPORT_ACTION}></div>
        )}
        <button class="btn primary" type="submit">
          Send report
        </button>
      </form>
    </main>
  );
}

function Thanks() {
  return (
    <main class="wrap doc report">
      <h1>Thank you</h1>
      <p>We’ve received your report and will review it.</p>
    </main>
  );
}

function page(c: Context<AppBindings>, body: Child, status: 200 | 400): Promise<Response> {
  return pageResponse(
    {
      path: c.req.path,
      origin: authBaseUrl(c.env, c.req.raw),
      title: 'Report a shared conversation · Tangent',
      noindex: true,
      style: REPORT_STYLE,
      turnstile: turnstileConfigured(c.env),
      form: true,
    },
    body,
    {
      status,
      headers: {
        'Cache-Control': 'no-store',
        'X-Robots-Tag': 'noindex, nofollow',
        'Referrer-Policy': 'no-referrer',
      },
    },
  );
}

function formPage(
  c: Context<AppBindings>,
  values: FormValues,
  error: string | null,
): Promise<Response> {
  const siteKey = turnstileConfigured(c.env) ? appConfig(c.env).auth.turnstileSiteKey : null;
  return page(
    c,
    <ReportForm action={c.req.path} siteKey={siteKey} values={values} error={error} />,
    error ? 400 : 200,
  );
}

/** The share at `token` when its link is up (the share route's rules), else null. */
async function reportable(c: Context<AppBindings>, token: string): Promise<Share | null> {
  const check = await shareService(c.env, c.req.url).checkPublic(token);
  if (!check.ok) return null;
  return (await canShare(c.env, userIdOfAccount(check.share.accountId))) ? check.share : null;
}

const text = (v: unknown): string => (typeof v === 'string' ? v : '');

/** `GET` and `POST /:token/report`, mounted at `/s` by `createApp`. */
export function reportPageRoutes(deps: AuthDeps = {}): Hono<AppBindings> {
  const r = new Hono<AppBindings>();

  r.get('/:token/report', async (c) => {
    if (!(await checkShareRateLimit(c.env, c.req.raw))) return rateLimitedSharePage();
    if (!(await reportable(c, c.req.param('token')))) return goneSharePage();
    return formPage(c, { category: '', details: '', email: '' }, null);
  });

  const limited = bodyLimit({
    maxSize: BODY_MAX_BYTES,
    onError: (c) => c.text('This report is too large.', 413, { 'Cache-Control': 'no-store' }),
  });
  r.post('/:token/report', sameOriginOnly, limited, async (c) => {
    if (!(await checkShareRateLimit(c.env, c.req.raw))) return rateLimitedSharePage();
    const share = await reportable(c, c.req.param('token'));
    if (!share) return goneSharePage();
    const form = await c.req.parseBody();
    const values = {
      category: text(form.category),
      details: text(form.details),
      email: text(form.email).trim(),
    };
    const parsed = reportForm.safeParse(values);
    if (!parsed.success) return formPage(c, values, parsed.error.issues[0]?.message ?? null);
    const ip = clientIp(c.req.raw.headers);
    if (turnstileConfigured(c.env)) {
      const token = text(form['cf-turnstile-response']);
      const passed = await verifyTurnstile(c.env, token, ip, {
        action: REPORT_ACTION,
        hostname: turnstileHostname(c.env, c.req.raw),
      });
      if (!passed) return formPage(c, values, 'That check didn’t go through. Please try again.');
    }
    const userId = (await optionalIdentity(c.env, c.req.raw, deps))?.userId ?? null;
    await fileReport(c.env, authBaseUrl(c.env, c.req.raw), {
      share,
      category: parsed.data.category,
      details: parsed.data.details,
      reporterEmail: parsed.data.email || null,
      reporterKey: reporterKeyOf(userId, await networkKey(c.env, ip)),
      reporterUserId: userId,
    });
    return page(c, <Thanks />, 200);
  });

  return r;
}
