# Legal and compliance checklist

What running Tangent publicly requires, what the code base already does about each item, and what only the operator can do. This is an engineering checklist, not legal advice. Have a lawyer read the privacy policy and terms before you rely on them, and especially before charging money in a new country.

Status: **done** = handled in code; **you** = an action for the operator (outside the code); **later** = needed only if the product or user base changes as described.

## 1. Public privacy policy and terms of service

| Item                                                              | Status                              | Where                                                                                                 |
| ----------------------------------------------------------------- | ----------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Privacy policy at a public URL (`/privacy`)                       | done                                | `apps/worker/src/http/legal.ts`                                                                       |
| Terms of service at a public URL (`/terms`)                       | done                                | same                                                                                                  |
| Linked from the landing page footer, sign-in page, all three apps | done                                | `landing.ts`, `login-page.ts`, account dialog / account menu                                          |
| Sign-in shows "you agree to the Terms and Privacy policy"         | done                                | `packages/web-shared/src/login/login-page.ts`                                                         |
| Operator name, contact mailbox, governing law                     | done (Yehuda Ringler, Pennsylvania) | `LEGAL_OPERATOR`, `LEGAL_CONTACT_EMAIL`, `LEGAL_JURISDICTION` in `wrangler.jsonc`                     |
| A real mailbox at the contact address                             | done (`yrappdev@gmail.com` for now) | later, a `privacy@tangentailearning.com` address via Cloudflare Email Routing looks more professional |

Set to Yehuda Ringler, governed by the laws of the Commonwealth of Pennsylvania, USA. If you form an LLC, change `LEGAL_OPERATOR` to it and assign it the trademark.

**Keep the policy true.** It describes what the code does: which tables hold what, which cookies exist, which services receive data. When a change adds a table, a cookie, a log, an analytics script or a new service provider, update `renderPrivacyPage` and bump `LEGAL_UPDATED` in the same change. The policy currently promises:

- no analytics, advertising or tracking cookies (adding any means a cookie-consent banner for EU visitors);
- API keys never stored server-side and never logged (see the BYOK section of the README);
- no sale of personal data, no training of models by us;
- message content never in logs.

## 2. Account deletion

| Item                                                                            | Status          | Where                                               |
| ------------------------------------------------------------------------------- | --------------- | --------------------------------------------------- |
| In-app "Delete account" (Power: Account dialog; Learn and Canvas: account menu) | done            | `packages/web-shared/src/account/delete-account.ts` |
| `DELETE /api/account`, confirmed by retyping the email, same-origin only        | done            | `apps/worker/src/auth/delete-account.ts`            |
| Deletes both accounts' trees, branches, messages, summaries, shares, settings   | done            | one D1 batch; `ON DELETE CASCADE` does the children |
| Deletes the user, sessions, OAuth links, passkeys, plan rows                    | done            | same                                                |
| Deletes the Stripe customer (Stripe cancels its subscriptions)                  | done            | same; a Stripe failure aborts the deletion          |
| Clears session and API-key cookies                                              | done            | same                                                |
| Keeps the billing ledger (`credit_grants`, `usage_events`)                      | done, by design | tax and accounting records; no content, no email    |

Residual copies, disclosed in the policy: D1 Time Travel keeps point-in-time recovery for 30 days (7 on the free plan; the policy says "up to 30 days"), shared pages may stay in other colos' edge cache for up to 24 hours (`SNAPSHOT_TTL_SECONDS`), and expired sign-in-link rows in `auth_verifications` (they hold the email for 15 minutes).

**You:** if you ever turn billing off (`STRIPE_SECRET_KEY` unset) while customers exist, deletion can't reach Stripe; it logs the customer id and you must delete it in the Stripe dashboard.

**Later:** a one-click "export all my data" (today each conversation exports separately, which satisfies GDPR portability but is tedious for heavy users).

## 3. Name, logo and copyright

Copyright and trademark protect different things:

- **Copyright** covers original creative works: the source code, the page text, the logo artwork. It exists automatically when the work is created; no registration is needed (in the US, registration is needed only to sue and to claim statutory damages). It does **not** protect names, titles or short phrases.
- **Trademark** protects a name or logo as a brand for particular goods and services. This is what protects "Tangent" and the logo.

| Item                                                                                                                                                                                                                                                                                                                                                                              | Status         |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| Footer line "© {year} {operator}. Tangent and the Tangent logo are trademarks of {operator}." on the landing and legal pages                                                                                                                                                                                                                                                      | done           |
| Terms §9 reserves the software, name and logo                                                                                                                                                                                                                                                                                                                                     | done           |
| **Trademark search** before investing more in the name: "Tangent" is a common English word and likely already registered by other software and education companies (USPTO classes 9 and 42 for software, 41 for education). Search the USPTO trademark database, EUIPO, and app stores. A conflict found now costs a rename; one found later costs a rebrand and possibly damages | **you**        |
| Using "™" needs no registration. "®" only after registration. US registration costs roughly $350 per class at the USPTO; consider registering a more distinctive name or the logo                                                                                                                                                                                                 | **you**        |
| The logo is a simple geometric mark. It may be too simple for copyright, which is another reason trademark is the relevant protection                                                                                                                                                                                                                                             | note           |
| **Repository license**: MIT (`LICENSE`, © 2026 Yehuda Ringler). It covers the code only; the README and terms §9 say the name and logo are not licensed, so self-hosted copies must rebrand                                                                                                                                                                                       | done           |
| Dependency licenses: production dependencies are MIT, Apache-2.0, BSD, ISC, PSF-2.0 and MPL-2.0 (`pnpm licenses list --prod`). None is copyleft for a hosted service. If you distribute the code, keep their notices                                                                                                                                                              | done (checked) |
| AI output: in most jurisdictions purely AI-generated text has no copyright owner. The terms say we claim no rights in replies, which is the safe position                                                                                                                                                                                                                         | done           |

## 4. Payments, credit and tax

| Item                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Status             |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| Terms §7: prices, markup, fees, tax, prepaid credit with no cash value, no expiry while the account exists, forfeiture on deletion, auto-renewal and cancellation, refunds                                                                                                                                                                                                                                                                                                                                                                                                                                        | done               |
| Stripe Dashboard → Settings → **Public details**: set the terms URL (`/terms`), privacy URL (`/privacy`), support email and a refund policy. Stripe requires them for live payments and shows them at Checkout                                                                                                                                                                                                                                                                                                                                                                                                    | **you**            |
| **EU/UK 14-day right of withdrawal.** Consumers can cancel digital purchases for 14 days unless they _expressly agree_, at checkout, to immediate delivery and acknowledge losing the right. The terms say it; to make it enforceable, once the Stripe terms URL is set, add `consent_collection: { terms_of_service: 'required' }` and `custom_text.terms_of_service_acceptance` to the Checkout Session params (`apps/worker/src/billing/` and the plugin's `getCheckoutSessionParams` in `auth/auth.ts`). Stripe rejects `consent_collection` while no terms URL is configured, so this is not switched on yet | **you**, then code |
| Auto-renewal laws (California and others) require clear terms before purchase, an acknowledgment after, and easy online cancellation. Stripe's receipts and the billing portal ("Manage billing") cover the last two; keep the membership price and "renews yearly until cancelled" visible on the billing page                                                                                                                                                                                                                                                                                                   | done / check       |
| **Sales tax / VAT.** Checkout already runs Stripe Tax and collects addresses and tax ids. Stripe Tax only _calculates_; you must **register** in each US state and country once you pass its threshold (Stripe Tax's threshold monitoring tells you when). EU VAT on digital services applies from the first sale to an EU consumer (use the EU OSS scheme to register once)                                                                                                                                                                                                                                      | **you**            |
| Income tax on the revenue; consider forming an LLC so the business, not you personally, carries liability and holds the Stripe account                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | **you**            |
| Unused prepaid balances: some US states treat long-dormant balances as unclaimed property. Low risk at small scale; don't add expiry dates without advice                                                                                                                                                                                                                                                                                                                                                                                                                                                         | note               |

## 5. AI providers

| Item                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Status  |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------- |
| Policy discloses that messages go to the model provider, including OpenRouter forwarding to hosts that may be in China for DeepSeek models                                                                                                                                                                                                                                                                                                                                           | done    |
| Terms §3: AI output can be wrong, not professional advice                                                                                                                                                                                                                                                                                                                                                                                                                            | done    |
| Terms §5: users must follow the provider's usage policy                                                                                                                                                                                                                                                                                                                                                                                                                              | done    |
| **OpenRouter's terms**: confirm reselling access to models through your own app is allowed under your OpenRouter plan, and follow its usage policy                                                                                                                                                                                                                                                                                                                                   | **you** |
| **Recommended:** stop OpenRouter routing paid Learn requests to providers that store or train on prompts. Either turn off providers that may train on or log inputs in the OpenRouter privacy settings of the account behind `OPENROUTER_SIMPLE_API_KEY`, or set the provider config's `options.extraBody` to `{ "provider": { "data_collection": "deny" } }` (via `SIMPLE_PROVIDER`). Check that DeepSeek models still have a provider afterwards. Then the policy can promise more | **you** |
| EU AI Act Art. 50 (transparency, from August 2026): people must know they are dealing with an AI. Tangent is plainly an AI tutor and the terms say so; keep the UI from presenting replies as a human's                                                                                                                                                                                                                                                                              | done    |

## 6. Children and students

Learn mode is pitched at "students and the curious", which draws children-privacy law into scope.

| Item                                                                                                                                                                                                                              | Status  |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| Policy and terms: not for under 13; under 18 needs a parent's permission; only adults buy                                                                                                                                         | done    |
| Sign-in line: "you confirm you are at least 13"                                                                                                                                                                                   | done    |
| **COPPA** (US, under 13): if you ever market to children, target K-12, or learn a user is under 13, you need verifiable parental consent or must delete the account. The policy commits to deleting on notice; act on such emails | **you** |
| **Schools**: selling to schools brings FERPA, state student-privacy laws (e.g. California SOPIPA) and signed data agreements with each district. Don't market to schools before that work                                         | later   |
| EU: the digital age of consent is 13–16 depending on the country. For EU growth, consider a real age check at sign-up                                                                                                             | later   |

## 7. GDPR / UK GDPR (EU and UK users)

| Item                                                                                                                                                                                                                                                                                   | Status                  |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| Controller identity and contact, legal bases, subprocessors, transfers, retention, rights, complaint right                                                                                                                                                                             | done (policy)           |
| Rights handled: access/export (per-conversation backups), erasure (account deletion), rectification (edit/delete in app), others by email within 30 days                                                                                                                               | done                    |
| Make sure a **Data Processing Agreement** is in place with each provider: Cloudflare and Stripe include theirs in their standard terms; check Resend's and OpenRouter's and accept them where they need a signature. These carry the standard contractual clauses the policy refers to | **you**                 |
| **EU/UK representative** (Art. 27): required for a non-EU operator who targets EU users, unless processing is only occasional and low-risk. At small scale this is often skipped, but it is a real obligation once you market in the EU                                                | later                   |
| Breach notification: notify the authority within 72 hours and affected users without undue delay                                                                                                                                                                                       | **you** (know the duty) |
| Keep a short record of processing (the policy's tables are most of it)                                                                                                                                                                                                                 | **you**                 |
| No cookie banner needed: only strictly necessary cookies. Adding analytics changes that                                                                                                                                                                                                | done                    |

US state privacy laws (California CCPA/CPRA and similar) apply only above revenue or user thresholds (CCPA: $26.6M revenue or 100,000 consumers). The policy already says no sale or sharing.

## 8. User content and share links

Share links publish user content to the internet, which makes Tangent a host of third-party content.

| Item                                                                                                                                                                                                                                                                                                                                                                                     | Status                  |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| Terms §5 acceptable use (illegal content, CSAM, harassment, malware, abuse) and the right to remove and suspend                                                                                                                                                                                                                                                                          | done                    |
| Terms §8: copyright notice procedure and repeat-infringer policy                                                                                                                                                                                                                                                                                                                         | done                    |
| **DMCA designated agent**: register with the US Copyright Office (dmca.copyright.gov, $6, renew every 3 years). Without it you lose the safe harbor for infringing content users share. Until then `DMCA_AGENT_REGISTERED` stays `"false"` in `wrangler.jsonc`, which keeps share links off (nothing is published or served; users can still export). Set it to `"true"` once registered | **you**                 |
| A way to take a share down without the owner: today the operator must revoke it in D1 (`UPDATE shares SET revoked_at = …`). Fine at small scale; an admin action would help later                                                                                                                                                                                                        | later                   |
| EU Digital Services Act: hosting services need a contact point and a notice-and-action mechanism; the contact email covers a small service                                                                                                                                                                                                                                               | done (contact)          |
| If you learn of CSAM: US providers must report it to NCMEC's CyberTipline                                                                                                                                                                                                                                                                                                                | **you** (know the duty) |

## 9. Sign-in providers and email

| Item                                                                                                                                                               | Status  |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------- |
| **Google OAuth consent screen**: needs the homepage, privacy and terms URLs and a verified domain before Google lets non-test users sign in without a warning      | **you** |
| GitHub OAuth app: set the homepage URL; GitHub shows the app name and logo to users                                                                                | **you** |
| Email: magic links are transactional, so CAN-SPAM's marketing rules don't apply. Any newsletter or marketing email later needs opt-in (EU) and an unsubscribe link | later   |

## 10. Accessibility

The European Accessibility Act (in force June 2025) and the ADA (US) apply to consumer e-commerce. Microenterprises (fewer than 10 staff and under €2M turnover) are exempt from the EAA for services. Keep the apps keyboard-navigable and labelled (they largely are); an accessibility statement is good practice but not required at this size.

## 11. Before launch, in order

1. Check `yrappdev@gmail.com` regularly: privacy, deletion and copyright requests arrive there and some have legal deadlines (30 days for privacy requests).
2. Trademark search on "Tangent"; decide whether to keep the name.
3. Stripe public details (terms, privacy, refund policy, support email); then enable Checkout terms consent.
4. Google OAuth consent screen URLs; GitHub app homepage.
5. Check the DPAs (Resend, OpenRouter; Cloudflare's and Stripe's come with their terms).
6. OpenRouter data-collection setting.
7. Register a DMCA agent, then set `DMCA_AGENT_REGISTERED` to `"true"` to turn share links on.
8. Register for sales tax / VAT as Stripe Tax's thresholds are reached; consider an LLC.
9. Lawyer review of `/privacy` and `/terms`.
