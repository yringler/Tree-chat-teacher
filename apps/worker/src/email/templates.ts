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
