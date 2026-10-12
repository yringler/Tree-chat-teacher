import { loginUrl } from '@tangent/shared';
import { Hono } from 'hono';
import type { AppBindings } from '../env.js';
import { POOL_IDENTITY_RETENTION_DAYS } from '../pool/identity.js';
import { LEARN_BASE } from './learn-app.js';
import { docResponse } from './legal.js';
import { legalInfo, type LegalInfo } from './legal-info.js';

/**
 * `/delete-account`: the public page app stores ask for, which says how to
 * delete an account, what goes and what is kept. It is the same for every
 * visitor and checks no session, so a store's checker always gets a 200
 * page with content. The deletion itself is Learn's page, behind sign-in:
 * the button signs the visitor in (or, already signed in, goes straight on)
 * and lands there.
 */

const DELETE_PAGE = `${LEARN_BASE}delete-account`;
const SIGN_IN_TO_DELETE = loginUrl(`${LEARN_BASE}login`, { returnTo: DELETE_PAGE });

function DeleteAccountPage(props: { info: LegalInfo }) {
  const email = props.info.contactEmail;
  return (
    <>
      <h1>Delete your Tangent account</h1>
      <p class="lede">
        You can delete your account, with everything in it, at any time. One account covers
        Tangent's Power, Learn and Canvas apps and the Tangent phone app, so this deletes it for all
        of them.
      </p>
      <p class="ctas">
        <a class="btn primary" href={SIGN_IN_TO_DELETE}>
          Sign in to delete your account
        </a>
      </p>

      <h2>How</h2>
      <ol>
        <li>Sign in with the account you want to delete (the button above).</li>
        <li>
          Type your email address to confirm, and choose <strong>Delete my account</strong>. The
          deletion is immediate and can't be undone.
        </li>
      </ol>
      <p>
        Already signed in? <strong>Delete account</strong> is also in the account menu of the web
        apps. Download backups of any conversations you want to keep first.
      </p>

      <h2>What is deleted</h2>
      <ul>
        <li>Every conversation and lesson, share link and setting.</li>
        <li>
          Your sign-in: your email address, linked Google or GitHub sign-in, passkeys and sessions.
        </li>
        <li>
          Your customer record at our payment provider (anonymised), which cancels your membership.
          Unused credit is forfeited.
        </li>
      </ul>

      <h2>What is kept, and for how long</h2>
      <ul>
        <li>
          Payment records (purchases, refunds, usage charges): for as long as tax and accounting law
          requires, typically up to 7 years. They hold no message content and are no longer linked
          to your email.
        </li>
        <li>
          Open pool records: usage totals without your user id, and a one-way hash of your email
          address for {POOL_IDENTITY_RETENTION_DAYS} days, so deleting and signing up again doesn't
          reset the pool's limits.
        </li>
        <li>
          Records of changes to share links and of reports about them: ids and dates, no message
          content.
        </li>
        <li>
          Our hosting provider's database recovery history: up to 30 days, then gone for good.
        </li>
      </ul>
      <p>
        The <a href="/privacy">privacy policy</a> has the details, including the rare case of
        content we are legally required to preserve.
      </p>

      <h2>Can't sign in?</h2>
      <p>
        Email <a href={`mailto:${email}`}>{email}</a> from the address on the account and we will
        delete it for you.
      </p>
    </>
  );
}

export function deleteAccountPageRoutes(): Hono<AppBindings> {
  const app = new Hono<AppBindings>();
  app.get('/delete-account', (c) => {
    const info = legalInfo(c.env, c.req.raw);
    return docResponse(
      info,
      '/delete-account',
      'Delete your account',
      <DeleteAccountPage info={info} />,
    );
  });
  return app;
}
