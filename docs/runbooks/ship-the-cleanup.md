# Shipping the October 2026 cleanup

Every owner action needed to ship the cleanup branch (`claude/stoic-rubin-vujfbw`, from the [code health audit](../audits/2026-10-08-code-health.md)) to production, in order. Do them top to bottom, and tick each one off. Commands run from `apps/worker` in a checkout of the cleanup branch, in bash or zsh, after `npx wrangler login` with access to the account that holds the Worker `tangent` and the database `tangent`.

Plan for about an hour, at a quiet time: between step 8 and the end of step 9, signed-in use of the site is down for a few minutes.

## Before merging

### 1. Export your conversations

In the power app, open each conversation you want to keep and use **Export → JSON backup (everything)** in the chat header. In Learn, use the download icon on each lesson. These files import into any Tangent, whatever happens to the database.

### 2. Set the renamed OpenRouter secret

The built-in provider's key is now read as `BUILT_IN_API_KEY`; nothing reads `OPENROUTER_SIMPLE_API_KEY` any more, and there is no fallback. Set the new name to the same value (copy it from where you keep it, or from OpenRouter's keys page):

```bash
npx wrangler secret put BUILT_IN_API_KEY
```

The code still running ignores it, so this is safe now. Without it, the new code offers no Tangent credit and no open pool.

### 3. Create the Cloudflare API token for deploys

Dashboard → **My Profile → API Tokens → Create Token** → **Edit Cloudflare Workers** → **Use template**, then:

- **Permissions** → **+ Add more** → _Account_ · **D1** · **Edit** (the deploy applies migrations; the template lacks it).
- **Account Resources** → _Include_ · your account.
- **Zone Resources** → _Include_ · _Specific zone_ · `tangentailearning.com` (each deploy re-publishes the custom domain, which needs the template's _Zone_ · **Workers Routes** · **Edit** on it).
- **Continue to summary → Create Token**, and copy the token. Cloudflare shows it once.

Also note your **account ID**: on the dashboard's account home, or `npx wrangler whoami`.

### 4. Create the GitHub environment `production`

Repository on GitHub → **Settings → Environments → New environment** → name it `production` → **Configure environment**:

- **Deployment branches and tags** → _Selected branches and tags_ → **Add deployment branch or tag rule** → `master`. Only `master`. This is a security requirement: without it, a pull request from a branch of this repository that edits `ci.yml` could run a job in `production` and read the token.
- **Required reviewers** → tick it, add yourself, **Save protection rules**. Every deploy then waits for your approval, which step 9 relies on.
- **Environment secrets** → **Add environment secret**: `CLOUDFLARE_API_TOKEN` (the token from step 3) and `CLOUDFLARE_ACCOUNT_ID` (the account ID).

Check that **Settings → Rules** has a rule on `master` requiring the **Checks** and **End-to-end** status checks before merging.

### 5. Disconnect Workers Builds

Dashboard → **Workers & Pages → tangent → Settings → Build** → **Disconnect** the repository. Otherwise the merge in step 7 deploys at once, untested, without migrations and before the database is converted.

### 6. Back up the database and run the precheck

Follow [d1-baseline.md](d1-baseline.md) step 2 (export the database, write down the Time Travel bookmark) and step 3 (the read-only precheck, with its stop conditions):

```bash
npx wrangler d1 export tangent --remote --output ../../tangent-before-baseline.sql
npx wrangler d1 time-travel info tangent      # write the bookmark down: it is the rollback
npx wrangler d1 execute tangent --remote --command="$(cat scripts/d1-baseline/precheck.sql)"
```

Keep the precheck's table 7 (every ledger's balance) to compare in step 8. If its tables 3 or 4 say to stop, stop and send the output to Claude.

## Merging and converting

### 7. Merge

Merge the cleanup pull request into `master`. **Checks** and **End-to-end** run again, then **Deploy** shows _Waiting for review_. Leave it waiting: the old code still serves and the database is untouched.

### 8. Convert the database

Only once **Deploy** is waiting (converting earlier makes the outage last as long as CI):

```bash
git checkout master && git pull
npx wrangler d1 execute tangent --remote --file scripts/d1-baseline/convert.sql
npx wrangler d1 execute tangent --remote --command="$(cat scripts/d1-baseline/verify.sql)"
npx wrangler d1 migrations list tangent --remote
```

Answer yes to wrangler's warning that the database is unavailable for a few seconds. Expect what [d1-baseline.md](d1-baseline.md) step 6 describes: one `d1_migrations` row (`0000_baseline.sql`), no leftovers, the balances you kept in step 6, and `migrations list` showing exactly `0001_node_error_kind.sql` and `0002_pool_identity_deleted_at.sql` still to apply. The site is now down for signed-in use until step 9 finishes.

### 9. Approve the deploy and smoke test

On the waiting run: **Review deployments** → tick `production` → **Approve and deploy**. The job applies `0001` and `0002`, then deploys the new code (a few minutes). For the seconds it rolls out, a request can meet an old and a new isolate and answer 500; a retry works. Then:

```bash
npx wrangler d1 migrations list tangent --remote   # ✅ No migrations to apply!
curl -i https://tangentailearning.com/api/me       # 401 unauthorized
curl -i https://tangentailearning.com/pricing      # 200
```

In a browser: sign in, open a power conversation, add your API key again (step 10), send a message and see the reply finish. In Learn, send a message on Tangent credit and see the balance go down, and open the billing page. Open `/admin/` and check the users list and the pool panel.

## After the deploy

### 10. Tell users what changes for them

- **Everyone re-enters their own API keys once.** The key cookie is now sealed for one user, so cookies saved before the deploy open as "no key" and the app asks again.
- **Reload any tab opened before the deploy.** It runs the old app against the new API.
- **A Max reply on Tangent credit needs about $0.37 available** (each reply holds its worst case at its model's price before it starts; Normal needs $0.02). With less, the app says how much it needs.

### 11. Update log filters

The `llm_call` log line now says `funding="credit"` where it said `funding="personal"`. Update any Workers Logs query, alert or saved filter on the old value. (The database column `usage_events.funding` still stores `personal`.)

### 12. Delete the old secret

Once the new code is live and credit works:

```bash
npx wrangler secret delete OPENROUTER_SIMPLE_API_KEY
npx wrangler secret list   # compare with the secrets in docs/configuration.md; delete any other the code no longer reads
```

## If you need to roll back

The new code needs the converted database, and the old code needs the old one, so roll back both together:

```bash
npx wrangler d1 time-travel restore tangent --bookmark=<the bookmark from step 6>
npx wrangler rollback    # pick the version that was live before step 9
```

The restore puts back the database exactly as it was before step 8; anything written since is lost (your exported JSON files from step 1 can be imported again). Then fix forward on a branch: the next deploy from `master` would bring the new code back, so don't approve one until the database is converted again. If the deploy failed before shipping code (**Apply D1 migrations** failed), the old code is still live: see "If something goes wrong" in [d1-baseline.md](d1-baseline.md).
