import { escapeHtml } from '@tangent/render';
import { CANDIDATE_TTL_MS } from '@tangent/shared';
import { Hono, type Context } from 'hono';
import type { AppBindings } from '../env.js';
import { hostedAi, type HostedAi } from './hosted-ai.js';
import { joinList, LANDING_STYLE, MARK, styleCsp } from './landing.js';
import { copyrightNotice, legalInfo, type LegalInfo } from './legal-info.js';

/**
 * The public legal pages: `/privacy` (privacy policy) and `/terms` (terms of
 * service). Static, script-free documents styled like the landing page, so
 * they need no sign-in and work for app-store, OAuth-consent-screen and
 * payment-provider account review links.
 *
 * Who runs the service and how to reach them come from the LEGAL_* vars in
 * wrangler.jsonc. Everything else describes what this code base actually does
 * with data: when the code changes what it stores or who it sends data to,
 * update PRIVACY below (and docs/LEGAL.md) in the same change.
 */

/** Bump when either document changes in substance. */
export const LEGAL_UPDATED = '8 October 2026';

/** Extra rules for long-form text, on top of the landing page's stylesheet. Hashed for the CSP. */
export const LEGAL_STYLE =
  LANDING_STYLE +
  `
.doc{max-width:46rem;padding-top:16px;padding-bottom:64px}
.doc h1{font-size:clamp(1.8rem,6vw,2.4rem)}
.doc h2{margin:40px 0 8px;font-size:1.3rem}
.doc h3{margin:24px 0 6px;font-size:1.05rem}
.doc p,.doc li{color:var(--fg)}
.doc ul{padding-left:20px}
.doc li{margin:0 0 6px}
.doc .updated{margin:8px 0 24px;color:var(--muted);font-size:.92rem}
.doc .summary{margin:0 0 8px;padding:16px 20px;border:1px solid var(--border);border-radius:14px;background:var(--bg-elev)}
.doc table{width:100%;border-collapse:collapse;font-size:.92rem}
.doc th,.doc td{padding:8px 10px;border-bottom:1px solid var(--border);text-align:left;vertical-align:top}
.doc code{font-size:.88em}
.doc .weeks{display:flex;flex-wrap:wrap;gap:6px 16px;padding:0;list-style:none}
.doc .weeks a[aria-current]{font-weight:700}
@media (max-width:479px){.top nav a+a{display:inline}}
`;

/** A long-form public page (the legal pages, `/pool`) in the landing page's look. */
export function page(info: LegalInfo, path: string, title: string, body: string): string {
  const canonical = escapeHtml(new URL(path, info.origin).toString());
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${escapeHtml(title)} · Tangent</title>
<link rel="canonical" href="${canonical}">
<style>${LEGAL_STYLE}</style>
</head>
<body>
<header class="wrap top">
<a class="brand" href="/welcome">${MARK}Tangent</a>
<nav aria-label="Legal"><a href="/privacy">Privacy</a><a href="/terms">Terms</a></nav>
</header>
<main class="wrap doc">
${body}
</main>
<footer>
<div class="wrap">
<span>${escapeHtml(copyrightNotice(info.operator))}</span>
<nav aria-label="Footer"><a href="/welcome">About Tangent</a><a href="/pricing">Pricing</a><a href="/pool">Open pool</a><a href="/privacy">Privacy</a><a href="/terms">Terms</a></nav>
</div>
</footer>
</body>
</html>
`;
}

function mailto(email: string): string {
  const e = escapeHtml(email);
  return `<a href="mailto:${e}">${e}</a>`;
}

/** "A and B", "A, B, and C" (the items may contain "and"), escaped. */
function list(items: readonly string[]): string {
  const joined =
    items.length <= 2
      ? joinList(items, 'and')
      : `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`;
  return escapeHtml(joined);
}

/** The first letter of `text` in upper case (a list item that starts with a use). */
function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Where OpenRouter sends `model`'s requests. */
function hostsText(model: HostedAi['models'][number]): string {
  const [first, ...rest] = model.hosts.map(escapeHtml);
  if (first === undefined) return 'on a host OpenRouter chooses';
  const order =
    rest.length === 0
      ? `sent to ${first}`
      : `sent first to ${first}, ${rest.map((h) => `then to ${h}`).join(', ')}`;
  return model.fallbacks
    ? `${order}, and to another host only if ${rest.length === 0 ? 'it is' : 'they are'} unavailable`
    : `${order} only`;
}

/**
 * The privacy policy's item on Tangent-paid AI calls (credit and the open
 * pool): who receives the text, and which models and hosts the deployment
 * uses today, from its config (`hostedAi`), so it stays true when a model or
 * a pinned host changes. Without the config it names no model.
 */
function hostedAiItem(ai: HostedAi | null): string {
  const who = ai?.gateway
    ? "OpenRouter (USA), reached through Cloudflare's AI Gateway,"
    : !ai || ai.openRouter
      ? 'OpenRouter (USA),'
      : `${escapeHtml(ai.endpoint)},`;
  const intro =
    !ai || ai.openRouter
      ? `${who} which forwards each request to a company that hosts the model: the company that made it or another hosting company, which may be in the USA, China or elsewhere.`
      : `${who} which runs the models.`;
  if (!ai || (ai.models.length === 0 && !ai.powerCredit))
    return `<li>Tangent credit and the open pool: ${intro}</li>`;
  const items = ai.models.map((m) => {
    const made = m.maker ? ` (made by ${escapeHtml(m.maker)})` : '';
    const where = ai.openRouter ? `, ${hostsText(m)}` : '';
    return `<li>${capitalize(list(m.uses))}: <code>${escapeHtml(m.id)}</code>${made}${where}.</li>`;
  });
  if (ai.powerCredit)
    items.push(
      `<li>Power mode on Tangent credit: the model you choose${ai.openRouter ? ', on a host OpenRouter chooses' : ''}.</li>`,
    );
  return `<li>Tangent credit and the open pool: ${intro} The models and hosts can change; at the moment:
<ul>
${items.join('\n')}
</ul></li>`;
}

export function renderPrivacyPage(info: LegalInfo, ai: HostedAi | null = null): string {
  const op = escapeHtml(info.operator);
  const contact = mailto(info.contactEmail);
  const candidateMinutes = CANDIDATE_TTL_MS / 60_000;
  // Wording follows DMCA_AGENT_REGISTERED (LegalInfo.sharing): links for everyone, or only where enabled.
  const visibility = info.sharing
    ? "other users can't see them unless you publish a share link."
    : "other users can't see them unless you publish a share link, which only accounts we have enabled it for can do.";
  const shareIntro = info.sharing
    ? ''
    : "<p>Share links are not generally available: only accounts we have enabled them for can create them, and links from other accounts don't open. To show someone a conversation, export it as Markdown or HTML and send or host the file yourself; we don't host or see those copies.</p>\n";
  return page(
    info,
    '/privacy',
    'Privacy policy',
    `<h1>Privacy policy</h1>
<p class="updated">Last updated ${LEGAL_UPDATED}</p>
<div class="summary">
<p><strong>The short version.</strong> We keep what you need to use Tangent: your email address, your conversations and your settings. Your conversations are private to your account: ${visibility} They are not end-to-end encrypted, so they are readable by the service itself (which is how it sends them to the AI model) and by the operator with database access, who looks at them only to keep the service running, investigate abuse, or when the law requires it. We don't sell your data, show ads, use tracking cookies, or train models on your conversations. Messages you send go to the AI provider that writes the reply. You can export any conversation and delete your account, with everything in it, at any time.</p>
</div>

<h2>Who we are</h2>
<p>Tangent (${escapeHtml(info.origin)}) is run by ${op} ("we", "us"), the controller of the personal data described here. Questions and requests: ${contact}.</p>

<h2>What we collect, and why</h2>
<table>
<thead><tr><th>Data</th><th>What it is</th><th>Why</th></tr></thead>
<tbody>
<tr><td>Account</td><td>Your email address. If you sign in with Google or GitHub: the name and profile picture URL they share, and your account id there. We don't keep the access tokens they issue. Passkeys: the public key and device type (never your fingerprint or face, which stay on your device).</td><td>To sign you in and tell your accounts apart.</td></tr>
<tr><td>Sessions</td><td>For each signed-in browser: the IP address and browser user agent at sign-in, and when the session expires.</td><td>Security: to keep you signed in and to spot misuse.</td></tr>
<tr><td>Your content</td><td>Conversations (messages, replies, branch titles, summaries), system prompts, settings, and share links you create.</td><td>This is the service. Stored in our database until you delete it.</td></tr>
<tr><td>AI provider API keys</td><td>If you add your own key, it is encrypted into a cookie that only your browser holds. We never store it on our servers; it is decrypted in memory for each request and never logged.</td><td>To call the provider on your behalf.</td></tr>
<tr><td>Billing (paid credit only)</td><td>Your customer id at our payment provider, credit purchases and refunds, membership status, and for each paid reply: the model, token counts, cost and time. Card numbers, billing addresses and tax details go to Polar, our merchant of record, and never reach us.</td><td>To charge for what you use, show you your usage, and keep the records tax law requires.</td></tr>
<tr><td>Open pool (only if you use it)</td><td>That you acknowledged the pool notice: which version, and when.</td><td>To show the notice again only when it changes.</td></tr>
<tr><td>Technical logs</td><td>Errors and request metadata (time, path, status, IP address) kept by our hosting provider's logs for a short time. Rate-limit counters per IP address. Never message content or API keys.</td><td>Security, abuse prevention and fixing bugs.</td></tr>
</tbody>
</table>
<p>Legal bases (for users in the EEA and UK): performing our contract with you (account, content, billing), our legitimate interests in keeping the service secure and free of abuse (sessions, logs, rate limits), and legal obligations (keeping payment records).</p>

<h2>Who your data goes to</h2>
<p>We use these service providers ("subprocessors"), each only for the purpose listed:</p>
<ul>
<li><strong>Cloudflare</strong> (USA, global network): hosting, database, the bot check on the sign-in page (Turnstile) and logs. Data is stored on Cloudflare's infrastructure, which encrypts it at rest.</li>
<li><strong>The AI model provider</strong> that writes each reply. Every message you send, together with the conversation context shown in the app's context inspector, is sent to it.
<ul>
${hostedAiItem(ai)}
<li>Your own key: the provider you chose (for example Anthropic, OpenAI or OpenRouter), under your own agreement with them.${!ai || ai.openRouter ? ' In Learn, your OpenRouter key runs the same models, sent to the same hosts, as Learn on Tangent credit.' : ''}</li>
</ul>
These providers handle your messages under their own terms and privacy policies, which may include keeping them for a period for abuse monitoring. Don't put information in a conversation that you wouldn't want an AI provider to process.</li>
<li><strong>Resend</strong> (USA): sends sign-in link emails to your address.</li>
<li><strong>Google and GitHub</strong>: only if you choose to sign in with them.</li>
<li><strong>Polar Software, Inc.</strong> (USA): our reseller and merchant of record for credit and the membership: checkout and payments (through its own payment processor, Stripe), tax, invoices, receipts, refunds and disputes, under Polar's own privacy policy. It receives your email, name and our user id for your account, and what you buy.</li>
</ul>
<p>We also disclose data when the law requires it, or to protect the rights and safety of users and the service. We never sell or rent personal data, and never share it for advertising.</p>
<p>Because these providers are in the USA and elsewhere, your data may be processed outside your country. Where the law requires it, transfers rely on the providers' standard contractual clauses or equivalent safeguards.</p>

<h2>Share links</h2>
${shareIntro}<p>When you create a share link, anyone who has the link can read what it covers, without signing in. Private branches are always left out. Revoking the link or deleting the conversation stops it at once in our database; copies already cached at the network edge expire within 24 hours, and we can't recall copies people already saved.</p>

<h2>Cookies and browser storage</h2>
<p>We use only cookies needed for the service to work, so we don't ask for cookie consent:</p>
<ul>
<li><code>tangent.session_token</code>, <code>tangent.session_data</code>, <code>tangent.dont_remember</code>: keep you signed in (up to 30 days, or until you close the browser if you untick "remember me").</li>
<li><code>tangent-remember</code>: your "remember me" choice while you sign in (15 minutes).</li>
<li><code>__Host-llmkey</code>: your own AI provider keys, encrypted (7 days).</li>
</ul>
<p>The apps also keep a few preferences in your browser's local storage (such as "remember me", how Learn replies are paid for, and the default reviewer model). The sign-in page loads Cloudflare Turnstile, which checks that you're human. There are no analytics, advertising or tracking cookies.</p>

<h2>How long we keep it</h2>
<ul>
<li>Conversations, settings and share links: until you delete them or your account. Deleting is immediate in the app.</li>
<li>Compare answers you haven't picked (with the question they answer): ${candidateMinutes} minutes after they are written, so you can pick one. Deleting the conversation deletes them at once; deleting your account leaves any still held to go when their ${candidateMinutes} minutes are up.</li>
<li>Sessions: until they expire or you sign out. Sign-in links: 15 minutes.</li>
<li>Open pool notice acknowledgments: until your account is deleted.</li>
<li>The weekly open pool snapshots (counts only, nothing about any one person): kept, so past weeks stay browsable.</li>
<li>Payment records (credit purchases, refunds, usage charges): kept after your account is deleted, for as long as tax and accounting law requires (typically up to 7 years). They contain no message content, and nothing in them is linked to your email once your account is gone. Polar, as merchant of record, keeps its own order and tax records under its policy.</li>
<li>Database recovery history: deleted data remains in our hosting provider's point-in-time recovery for up to 30 days, after which it is gone for good.</li>
</ul>

<h2>Your rights and choices</h2>
<ul>
<li><strong>Access and export:</strong> every conversation can be downloaded as a JSON backup, Markdown or HTML from the app. For anything else we hold about you, email ${contact}.</li>
<li><strong>Correction:</strong> rename or delete anything in the app; your email comes from how you sign in.</li>
<li><strong>Deletion:</strong> delete single conversations at any time, or your whole account from the account menu in any of the apps ("Delete account"). That deletes both your Power and Learn accounts (Canvas uses the Power account) with every conversation, share link and setting, your sign-in methods and sessions, and your customer record at Polar (anonymised; Polar keeps the order records tax law requires), which also cancels your membership. Unused credit is forfeited. Payment records are kept as described above.</li>
<li>Depending on where you live (for example the EEA, UK or California) you may also have the right to object to or restrict processing, to data portability, and to complain to your data protection authority. Email ${contact}; we answer within 30 days.</li>
</ul>
<p>We don't sell or share personal information as the California Consumer Privacy Act defines those terms, and we don't use it for profiling or automated decisions with legal effects.</p>

<h2>Children</h2>
<p>Tangent is not for children under 13, and we don't knowingly collect their data. If you are under 18 (or the age of majority where you live), you need a parent's or guardian's permission to use Tangent, and only an adult may buy credit. If you believe a child under 13 has signed up, email ${contact} and we will delete the account.</p>

<h2>Security</h2>
<p>All traffic is encrypted (HTTPS). Sign-in is by email link, Google, GitHub or passkey; there are no passwords to leak. Your API keys are sealed with AES-256-GCM and never stored server-side. Each account's data is only reachable through that account. No system is perfectly secure; if a breach affects your data, we will tell you and the authorities as the law requires.</p>

<h2>Changes</h2>
<p>When this policy changes we update the date at the top; for significant changes we will also tell you in the app or by email before they take effect.</p>

<h2>Contact</h2>
<p>${op}: ${contact}</p>`,
  );
}

export function renderTermsPage(info: LegalInfo): string {
  const op = escapeHtml(info.operator);
  const contact = mailto(info.contactEmail);
  const law = info.jurisdiction
    ? `the laws of ${escapeHtml(info.jurisdiction)}, and its courts have jurisdiction`
    : 'the laws of the place where the operator is established, and its courts have jurisdiction';
  const shareTerms = info.sharing
    ? ''
    : ' Share links are available only to accounts we enable them for. Anyone can export a conversation and share the file; where you put it is up to you, and so is the responsibility for it.';
  return page(
    info,
    '/terms',
    'Terms of service',
    `<h1>Terms of service</h1>
<p class="updated">Last updated ${LEGAL_UPDATED}</p>
<p>These terms are an agreement between you and ${op} ("we", "us") for using Tangent at ${escapeHtml(info.origin)}. By signing in you accept them and our <a href="/privacy">privacy policy</a>. If you don't agree, don't use Tangent.</p>

<h2>1. Who may use Tangent</h2>
<p>You must be at least 13. If you are under 18 (or the age of majority where you live), a parent or guardian must agree to these terms for you, and only an adult may buy credit or a plan. You may not use Tangent where the law forbids it.</p>

<h2>2. Your account</h2>
<p>You sign in with an email address you control, Google, GitHub or a passkey. You are responsible for what happens under your account; tell us at ${contact} if you think someone else has access to it. You can delete your account at any time from the account menu.</p>

<h2>3. AI-generated content</h2>
<p>Replies in Tangent are written by AI models, not people. They can be wrong, incomplete, out of date or biased, even when they sound confident. Don't rely on them for medical, legal, financial, safety or other important decisions without checking with a qualified person. You are responsible for how you use what Tangent produces.</p>

<h2>4. Your content</h2>
<p>You keep all rights to what you write, and, as far as we're concerned, to the replies generated for you. You give us the permission we need to run the service: to store your content, send it to the AI provider that writes the reply, and show it to the people you share it with. That permission ends when you delete the content, except for copies already shared or cached as the privacy policy describes.</p>
<p>You are responsible for your content and for any share link you publish. Only share what you have the right to share.${shareTerms}</p>

<h2>5. Acceptable use</h2>
<p>Don't use Tangent to:</p>
<ul>
<li>break the law or infringe anyone's rights, including copyright and privacy;</li>
<li>create or share sexual content involving minors, content that harasses, threatens or incites violence against people, or malware;</li>
<li>break the usage policies of the AI provider handling your request (for example OpenRouter's and the model maker's);</li>
<li>get around rate limits, billing or security, probe other users' data, or overload the service;</li>
<li>resell access, or use automated means to scrape or bulk-generate content outside the app.</li>
</ul>
<p>We may remove content or suspend accounts that break these rules, and report illegal content to the authorities.</p>

<h2>6. Your own API keys</h2>
<p>If you add your own AI provider key, your use of that provider is between you and them: their terms apply and they bill you directly. We don't charge for replies on your own key.</p>

<h2>7. Membership and paid credit</h2>
<ul>
<li>Credit and the membership are sold through Polar Software, Inc., our reseller and merchant of record: you buy from Polar, which processes the payment, calculates and collects tax, issues invoices and receipts, and handles refunds and disputes. Polar's terms for buyers also apply to your purchase.</li>
<li>Prices for paid replies are the AI provider's cost (including its credit-purchase fee) plus a markup shown in the app. Polar's processing fee comes out of each purchase, and tax is added at checkout.</li>
<li>Credit is prepaid and is used up as you send messages. It has no cash value and can't be transferred, to another account or to the open pool. It doesn't expire while your account exists. Deleting your account forfeits any credit left.</li>
<li>Where the service requires a membership to generate replies, it renews automatically each year until you cancel it under "Manage billing". Cancelling stops future renewals; the membership runs to the end of the paid year, and credit already granted stays usable.</li>
<li>Credit and the membership are not refundable, except where the law requires it or under Polar's terms for buyers: as merchant of record, Polar may refund a purchase (for example, to prevent a chargeback). Refunded credit is removed from your balance, and a refunded membership payment takes back the credit it included. If you're a consumer in the EU or UK, you agree that credit is delivered right away and acknowledge that, once you start using it, you lose the 14-day right of withdrawal for the part used.</li>
<li>The <a href="/pool">open pool</a> is free credit we provide, at our discretion, that any signed-in learner may use within its limits. We fund it from our own revenue, as described on the pool page; pool credit isn't for sale. Replies from the pool cost you nothing. We may change the pool's funding, model, limits and availability, or end it, and it may be empty.</li>
<li>We may change prices; changes apply to credit bought or membership periods starting after the change.</li>
</ul>

<h2>8. Copyright complaints</h2>
<p>If you believe content shared through Tangent infringes your copyright, send a notice to ${contact} with: your contact details, the work you claim is infringed, the share link, a statement that you believe in good faith the use isn't authorized, and a statement under penalty of perjury that your notice is accurate and that you are the owner or authorized to act for them, with your physical or electronic signature. We remove infringing content and close the accounts of repeat infringers.</p>

<h2>9. Our rights</h2>
<p>Tangent's source code is open source under the MIT License, which governs your use of the code itself. The hosted service, its design, and the name and logo belong to ${op}. "Tangent" and the Tangent logo are our trademarks; neither these terms nor the MIT License give you any right to use them, so a copy you run yourself must use a different name and logo.</p>

<h2>10. Changes and availability</h2>
<p>We may change, suspend or stop all or part of Tangent. We'll give reasonable notice of significant changes to these terms (in the app or by email); continuing to use Tangent after they take effect means you accept them. If we shut Tangent down we will give you time to export your conversations.</p>

<h2>11. Ending the agreement</h2>
<p>You can stop at any time and delete your account. We may suspend or close your account if you break these terms or if the law requires it, and will tell you why unless the law forbids it.</p>

<h2>12. Disclaimers</h2>
<p>Tangent is provided "as is" and "as available". To the extent the law allows, we disclaim all warranties, express or implied, including fitness for a particular purpose, accuracy and uninterrupted availability.</p>

<h2>13. Limitation of liability</h2>
<p>To the extent the law allows, we aren't liable for indirect, incidental, special, consequential or punitive damages, or for lost data, profits or goodwill, and our total liability for any claim is limited to the greater of what you paid us in the 12 months before the claim and US$50. Nothing in these terms limits liability that can't be limited by law, or your rights as a consumer under mandatory law where you live.</p>

<h2>14. Indemnity</h2>
<p>If someone makes a claim against us because of your content or your breach of these terms, you agree to cover our reasonable costs of it, to the extent the law allows.</p>

<h2>15. Governing law</h2>
<p>These terms are governed by ${law}, except where mandatory consumer law where you live says otherwise.</p>

<h2>16. Contact</h2>
<p>${op}: ${contact}</p>`,
  );
}

/** A public page styled by LEGAL_STYLE, cacheable for five minutes. */
export async function legalResponse(c: Context<AppBindings>, html: string): Promise<Response> {
  return new Response(html, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': await styleCsp(LEGAL_STYLE),
      'Referrer-Policy': 'same-origin',
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'public, max-age=300',
    },
  });
}

/** `GET /privacy` and `GET /terms`, public (mounted at the root by `createApp`). */
export function legalRoutes(): Hono<AppBindings> {
  const app = new Hono<AppBindings>();
  app.get('/privacy', (c) =>
    legalResponse(c, renderPrivacyPage(legalInfo(c.env, c.req.raw), hostedAi(c.env))),
  );
  app.get('/terms', (c) => legalResponse(c, renderTermsPage(legalInfo(c.env, c.req.raw))));
  return app;
}
