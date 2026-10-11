# Shipping the sharing safeguards

Owner actions to ship the sharing safeguards and then open share links to everyone (`SHARING=everyone`), in order. Do them top to bottom and tick each off. Steps 1 to 4 ship the code with sharing still on `allowlist`; steps 5 to 10 are what must be true before anyone outside the allowlist can publish. Commands run from `apps/worker` after `npx wrangler login` with access to the account that holds the Worker `tangent` and the database `tangent`.

## Ship the code

### 1. Check the sharing switch

`DMCA_AGENT_REGISTERED` is gone; `SHARING` replaces it ([configuration.md](../configuration.md)) and defaults to `allowlist`, which is what production runs today. If the dashboard sets `DMCA_AGENT_REGISTERED` as a var, delete it there. Leave `SHARING` unset until step 10.

### 2. Apply the migrations

The deploy applies new migrations itself ([operating.md](../operating.md#deploying-from-github)); applying them first is safe, since they only add tables and columns the running code ignores, and lets you check them before the code lands:

```bash
npx wrangler d1 migrations apply DB --remote
npx wrangler d1 migrations list DB --remote   # nothing left to apply
```

### 3. Remove the live share links

Shares are snapshots only now. A live link has no stored snapshot, so after the deploy it answers "no longer available" while its owner still sees it as active. Delete the live links right before the deploy, so they are gone from owners' lists too:

```bash
npx wrangler d1 execute tangent --remote --command "SELECT count(*) FROM shares WHERE mode = 'live'"
npx wrangler d1 execute tangent --remote --command "DELETE FROM shares WHERE mode = 'live'"
```

Their owners can share those conversations again once the deploy is out.

### 4. Deploy

Merge to `master` and approve the deploy. On `/admin/`, check that the page says `SHARING` is `allowlist` and that the **Reports** and **Legal holds** sections load.

## Before opening sharing to everyone

### 5. Set the moderation key

Check OpenAI's data terms for the moderation endpoint first ([LEGAL.md](../LEGAL.md#8-user-content-and-share-links)). Without the key `SHARING=everyone` acts as `allowlist`, so strangers never publish unscreened.

```bash
npx wrangler secret put MODERATION_API_KEY
```

From then on every publish is screened, admins' and allowed users' included, and a classifier outage refuses publishing ([operating.md](../operating.md#admin)). Publish a test link from your account and check for its `share_screened` row:

```bash
npx wrangler d1 execute tangent --remote --command "SELECT at, data FROM audit_events WHERE kind = 'share_screened' ORDER BY at DESC LIMIT 1"
```

The privacy page and terms now name the screening; check `/privacy` lists OpenAI.

### 6. Check Turnstile on the report form

The report form at `/s/<token>/report` uses the sign-in Turnstile keys (`TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY`, [configuration.md](../configuration.md)); without them it is only rate-limited per IP. Open the report link of your test share and check that the human check shows. Don't submit it unless you want a report in the queue (a copyright report takes the link down).

### 7. Make sure alerts reach you

CSAM and violent or illegal reports, and screening refusals as possible CSAM, email `LEGAL_CONTACT_EMAIL` (`privacy@tangentailearning.com`) through the sign-in email setup ([operating.md](../operating.md#admin)). Check that the mailbox exists, accepts mail from `EMAIL_FROM` (send yourself a magic link from that address to see where it lands), and that you read it daily. Watch Workers Logs for `alert_failed`.

### 8. Register with NCMEC

Register as an electronic service provider for CyberTipline reports ([LEGAL.md](../LEGAL.md#8-user-content-and-share-links)), and read [csam.md](csam.md) so you know the steps before you need them.

### 9. Have a lawyer review the terms

The share terms and the exposure from hosting AI-written replies ([LEGAL.md](../LEGAL.md#8-user-content-and-share-links)). Change the terms if they ask; a change in substance bumps `LEGAL_UPDATED` in `apps/worker/src/http/legal.tsx`.

### 10. Open sharing

Set `"SHARING": "everyone"` in `wrangler.jsonc` `vars` and deploy. Check that `/admin/` says `everyone`, that `/privacy` and `/terms` no longer say share links are limited, and that an account you never allowed, older than a day, can publish. Plan to review the **Reports** queue within 24 to 48 hours from now on.

To take every link down at once, set `SHARING` to `off` and deploy; `allowlist` goes back to admins and allowed users only.
