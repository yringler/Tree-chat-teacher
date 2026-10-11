import { escapeHtml } from '@tangent/render';
import type { EmailMessage } from './types.js';

export function magicLinkEmail(to: string, url: string, expiresInMinutes: number): EmailMessage {
  const href = escapeHtml(url);
  return {
    to,
    subject: 'Sign in to Tangent',
    text: [
      'Open this link to sign in to Tangent:',
      '',
      url,
      '',
      `It works once and expires in ${expiresInMinutes} minutes.`,
      "If you didn't ask to sign in, ignore this email.",
    ].join('\n'),
    html: `<!doctype html>
<html><body style="font-family:system-ui,sans-serif;line-height:1.5;color:#1f2328">
<p>Open this link to sign in to Tangent:</p>
<p><a href="${href}" style="display:inline-block;padding:10px 16px;background:#2f6feb;color:#fff;border-radius:6px;text-decoration:none">Sign in</a></p>
<p style="font-size:13px;color:#59636e">It works once and expires in ${expiresInMinutes} minutes. If you didn't ask to sign in, ignore this email.</p>
<p style="font-size:12px;color:#59636e;word-break:break-all">${href}</p>
</body></html>`,
  };
}

/**
 * An alert to the operator (alerts.ts): what happened, the ids to look up and
 * a link to the admin page. Callers pass ids and fixed text only, never a
 * conversation's content.
 */
export function alertEmail(
  to: string,
  alert: { title: string; summary: string; facts: readonly (readonly [string, string])[] },
  adminUrl: string,
): EmailMessage {
  const facts = alert.facts.map(([label, value]) => `${label}: ${value}`);
  return {
    to,
    subject: `Tangent alert: ${alert.title}`,
    text: [alert.summary, '', ...facts, '', `Admin: ${adminUrl}`].join('\n'),
    html: `<!doctype html>
<html><body style="font-family:system-ui,sans-serif;line-height:1.5;color:#1f2328">
<p>${escapeHtml(alert.summary)}</p>
<ul>${alert.facts.map(([label, value]) => `<li>${escapeHtml(label)}: <code>${escapeHtml(value)}</code></li>`).join('')}</ul>
<p><a href="${escapeHtml(adminUrl)}">Open the admin page</a></p>
</body></html>`,
  };
}

/** To someone on the waitlist, once the operator has made room. */
export function waitlistInviteEmail(to: string, url: string): EmailMessage {
  const href = escapeHtml(url);
  return {
    to,
    subject: "There's room on Tangent now",
    text: [
      'You asked to hear when Tangent opens up: there is room now.',
      '',
      `Sign up here, with this email address: ${url}`,
      '',
      'Places go to whoever signs up first, so it may fill again.',
      "If you've changed your mind, ignore this email: we won't send another.",
    ].join('\n'),
    html: `<!doctype html>
<html><body style="font-family:system-ui,sans-serif;line-height:1.5;color:#1f2328">
<p>You asked to hear when Tangent opens up: there is room now.</p>
<p><a href="${href}" style="display:inline-block;padding:10px 16px;background:#2f6feb;color:#fff;border-radius:6px;text-decoration:none">Sign up</a></p>
<p style="font-size:13px;color:#59636e">Sign up with this email address. Places go to whoever signs up first, so it may fill again. If you've changed your mind, ignore this email: we won't send another.</p>
</body></html>`,
  };
}
