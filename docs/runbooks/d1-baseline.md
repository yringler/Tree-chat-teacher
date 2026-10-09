# Converting production D1 to the baseline migration

The 27 migrations `0000_init` … `0026_model_windows` were squashed into one, `apps/worker/migrations/0000_baseline.sql`, which creates the current schema from nothing. The production database `tangent` already has the old 27 applied, so it is converted once, by hand, with `apps/worker/scripts/d1-baseline/convert.sql`. That script:

- moves the dispute markers (`<dispute>:ignored`, `<dispute>:lost`) out of `credit_grants` into the new `billing_markers` table;
- relabels ledger rows of removed kinds as `adjustment` (`contribution`, `subscription`) and usage rows of the removed `tagging` purpose as `other`, keeping every amount, so every balance stays the same;
- drops what the removed features left: the tables `accounts`, `pool_consents`, `pool_topic_tags`, `pool_impact_snapshots`, `pool_impact_topics`, `pool_topic_reviews` and `model_price_history`, the columns `usage_events.tier` and `credit_grants.margin_bps`, and their indexes;
- rewrites wrangler's `d1_migrations` table to hold exactly `0000_baseline.sql`, so the deploy job's `wrangler d1 migrations apply` skips the baseline and applies only the two migrations written after it, `0001_node_error_kind.sql` and `0002_pool_identity_deleted_at.sql`.

The result is the same schema the baseline builds from scratch (column order aside, which nothing depends on). The order is: convert by hand, then the deploy job applies `0001` and `0002`, then it deploys the new code.

`0001` and `0002` only add: a nullable `nodes.error_kind` (backfilled from the stored error messages) and three `pool_identities` columns with defaults (`deleted_at`, and the day's usage of a deleted account), plus a one-time backfill that touches only what already-deleted accounts left behind (their user ids in `usage_events` and `credit_grants`, their `pool_identity_holders` rows). The old code never reads the new columns and has no use for rows of users who no longer exist, so both are safe to apply while it still serves; the new code reads a node without an `error_kind` from its message.

**The pull request that carries the baseline must not deploy before `convert.sql` has run.** Its code reads `billing_markers`, which only the conversion creates: every dispute would fail with `no such table: billing_markers`. The steps below hold the deploy until then, and the deploy job stops on its own if it gets there first (see [If something goes wrong](#if-something-goes-wrong)).

Run every command from `apps/worker`, in a checkout of that pull request's branch (or of `master` once merged), in bash or zsh. You need `npx wrangler login` done, with access to the account that holds `tangent`.

## 1. Export your conversations

In the power app and in Learn, export a JSON backup of every conversation you want to keep (**Export → JSON backup (everything)** in the power app's chat header, the download icon on each lesson in Learn; see [the user guide](../user-guide.md)). Step 2's backup holds them too; these files can be imported into any Tangent, whatever its database.

## 2. Back up the database

```bash
npx wrangler d1 export tangent --remote --output ../../tangent-before-baseline.sql
npx wrangler d1 time-travel info tangent
```

The first writes a full SQL dump (schema and data). The second prints the current Time Travel bookmark: write it down. D1 keeps 30 days of history, so this bookmark is the rollback:

```bash
npx wrangler d1 time-travel restore tangent --bookmark=<the bookmark from above>
# or, without the bookmark, a moment before you converted:
npx wrangler d1 time-travel restore tangent --timestamp=2026-10-09T12:00:00Z
```

A restore puts back the old schema, which only the code from before the baseline runs on: after one, redeploy that code too (`npx wrangler rollback`, or re-run the last good **Deploy** from before the merge).

## 3. Run the precheck

Read-only:

```bash
npx wrangler d1 execute tangent --remote --command="$(cat scripts/d1-baseline/precheck.sql)"
```

(Not `--file`: D1 runs a file as an import, which prints no query results. The `=` stops wrangler reading the file's leading `--` comment as an option.)

It prints eight tables, in the order the file numbers them:

- **Tables 1 and 2**: rows and values in what the conversion drops. Any number is fine: they belong to removed features, and step 2's backup keeps them.
- **Table 3**: `markers` may be any number. **If `contribution_grants`, `subscription_grants` or `tagging_usage` is not 0, stop and send the whole output to Claude** before going on. The script handles them (it relabels them and keeps their amounts), but they are money, so look at them first.
- **Table 4 must be all 0. If any is not, stop and send the whole output to Claude.** `non_user_purchases` counts purchases on a ledger other than a user's `u_<userId>`, such as old pool purchases: a refund or dispute of one would now be debited outside PoolBank's lock. Unknown kinds or purposes make `convert.sql` refuse to run.
- **Tables 5 to 7**: the rows behind those counts, the pool's tagging spend, and every ledger's balance. **Keep table 7** to compare in step 6.
- **Table 8**: `d1_migrations`, 27 rows, `0000_init.sql` to `0026_model_windows.sql`. `convert.sql` refuses any other state.

## 4. Hold the deploy

1. **Disconnect Workers Builds** if it is still connected: in the Cloudflare dashboard, **Workers & Pages → tangent → Settings → Build**, disconnect the repository. Otherwise the merge deploys at once, without the workflow and before the conversion.
2. **Make the Deploy job wait for you**: on GitHub, **Settings → Environments → production → Deployment protection rules**, tick **Required reviewers**, add yourself and save. Every Deploy now waits for your approval. Keep the rule afterwards: it is part of the setup in [operating.md](../operating.md#setting-it-up-once).

## 5. Merge

Merge the pull request. **Checks** and **End-to-end** run; **Deploy** then shows _Waiting for review_. Leave it waiting. The old code is still serving and the database is untouched.

## 6. Convert

```bash
git pull   # on master, if you checked out the branch before
npx wrangler d1 execute tangent --remote --file scripts/d1-baseline/convert.sql
```

Wrangler warns that the database is unavailable while the file runs (a few seconds); answer yes. D1 runs the file as one unit: if anything in it fails, nothing is applied ("your DB will return to its original state") and you can run it again.

Verify:

```bash
npx wrangler d1 execute tangent --remote --command="$(cat scripts/d1-baseline/verify.sql)"
npx wrangler d1 migrations list tangent --remote
```

`verify.sql` prints: one `d1_migrations` row, `0000_baseline.sql`; an empty list (nothing the baseline lacks is left); the moved markers; and every ledger's balance, which must match the table you kept in step 3, except that the `payment-markers` line (always 0) is gone. `migrations list` lists the two migrations still to apply, `0001_node_error_kind.sql` and `0002_pool_identity_deleted_at.sql`, and nothing else. If it lists `0000_baseline.sql`, the conversion didn't take: stop and send the output to Claude.

**From here until step 7 finishes, the site is down for signed-in use.** The old code still serving writes `accounts` on every signed-in request and the dropped columns on every metered call, so those requests answer 500. Nothing is half-written: a failed statement writes nothing. Payment webhooks that fail are retried by the provider, and the crons run again on their schedule. Since you are the only user, a few minutes of this is acceptable; do it at a quiet time.

## 7. Deploy

On the waiting run, **Review deployments → production → Approve and deploy**. Its **Apply D1 migrations** step lists `0001_node_error_kind.sql` and `0002_pool_identity_deleted_at.sql` and applies them (each marked ✅), and **Deploy** ships the new code, which ends the outage (the job takes a few minutes). Afterwards `npx wrangler d1 migrations list tangent --remote` prints `✅ No migrations to apply!`. Open the app, sign in, open a conversation and send a message. The Worker now hands the account to a conversation's Durable Object in a new encoding, so for the few seconds the deploy rolls out a request that meets an old and a new isolate can answer 500: that's expected and harmless, and a retry works.

## If something goes wrong

- **The Deploy ran before `convert.sql`** (approved too early, or no required reviewer): **Apply D1 migrations** tries to run `0000_baseline.sql` on the old tables and fails on its first statement, `table account_settings already exists`. Nothing in the database changes, and the job stops there, before **Deploy** (a failed step skips the ones after it), so the old code keeps serving. Run step 6, then **Re-run failed jobs** on that run.
- **Apply D1 migrations failed on `0001` or `0002` after converting:** the job stops before **Deploy**, so the old code keeps serving (with the outage of step 6). Wrangler rolls back the migration that failed and records only those that succeeded, so a re-run picks up where it stopped. Send the step's log to Claude; once fixed, **Re-run failed jobs**.
- **Workers Builds deployed the new code before `convert.sql`:** the site works, but every dispute webhook and the dispute poller fail with `no such table: billing_markers` until you convert. Run step 6 now; the provider retries the webhooks.
- **`convert.sql` stopped with `CHECK constraint failed: old_migrations_applied`:** the database is not at exactly `0000`–`0026` (or is already converted: run `verify.sql`). With `ledger_values_known`: a ledger row has a kind or purpose the script has no rule for. Nothing was applied either way; send the message and the precheck output to Claude.
- **Anything else after converting:** restore with Time Travel (step 2) and redeploy the code from before the merge.

## Local databases

A local database made by `pnpm dev` or `pnpm db:migrate:local` before the baseline has the same old migrations. Convert it the same way, with `--local` instead of `--remote`, or delete `apps/worker/.wrangler/state` to start empty. The e2e server and the worker tests build their databases from scratch every run.
