# Shipping the sharing safeguards

Owner actions needed to ship the sharing safeguards to production, in order. Commands run from `apps/worker` after `npx wrangler login` with access to the account that holds the database `tangent`.

## Before deploying

### 1. Check the sharing switch

`DMCA_AGENT_REGISTERED` is gone; `SHARING` replaces it ([configuration.md](../configuration.md)) and defaults to `allowlist`, which is what production runs today. If the dashboard sets `DMCA_AGENT_REGISTERED` as a var, delete it there. Set `SHARING` only to change who may share.

### 2. Set the moderation key before opening sharing

`SHARING=everyone` now needs `MODERATION_API_KEY`; without it, it acts as `allowlist`. Before setting `SHARING` to `everyone` (now or later), check OpenAI's data terms for the moderation endpoint ([LEGAL.md](../LEGAL.md) §8), then:

```bash
npx wrangler secret put MODERATION_API_KEY
```

Once it is set, every publish is screened, admins' and allowed users' included, and a classifier outage refuses publishing. After the deploy, publish a test link from your account and check for a `share_screened` row:

```bash
npx wrangler d1 execute tangent --remote --command "SELECT at, data FROM audit_events WHERE kind = 'share_screened' ORDER BY at DESC LIMIT 1"
```

Alerts go to `LEGAL_CONTACT_EMAIL` through the sign-in email setup; make sure that mailbox accepts mail from `EMAIL_FROM`.

### 3. Remove the live share links

Shares are snapshots only now. A live link has no stored snapshot, so after the deploy it answers "no longer available" while its owner still sees it as active. Delete the live links first, so they are gone from owners' lists too:

```bash
npx wrangler d1 execute tangent --remote --command "SELECT count(*) FROM shares WHERE mode = 'live'"
npx wrangler d1 execute tangent --remote --command "DELETE FROM shares WHERE mode = 'live'"
```

Their owners can share those conversations again once the deploy is out.
