# Shipping the sharing safeguards

Owner actions needed to ship the sharing safeguards to production, in order. Commands run from `apps/worker` after `npx wrangler login` with access to the account that holds the database `tangent`.

## Before deploying

### 1. Check the sharing switch

`DMCA_AGENT_REGISTERED` is gone; `SHARING` replaces it ([configuration.md](../configuration.md)) and defaults to `allowlist`, which is what production runs today. If the dashboard sets `DMCA_AGENT_REGISTERED` as a var, delete it there. Set `SHARING` only to change who may share.

### 2. Remove the live share links

Shares are snapshots only now. A live link has no stored snapshot, so after the deploy it answers "no longer available" while its owner still sees it as active. Delete the live links first, so they are gone from owners' lists too:

```bash
npx wrangler d1 execute tangent --remote --command "SELECT count(*) FROM shares WHERE mode = 'live'"
npx wrangler d1 execute tangent --remote --command "DELETE FROM shares WHERE mode = 'live'"
```

Their owners can share those conversations again once the deploy is out.
