-- Converts a database at migrations 0000–0026 to migrations/0000_baseline.sql, once
-- (docs/runbooks/d1-baseline.md). Take the backup first. Run it from apps/worker:
--   npx wrangler d1 execute tangent --remote --file scripts/d1-baseline/convert.sql
--
-- D1 runs a file as one unit: if any statement fails, nothing in it is applied. The
-- guards below make every surprise such a failure, so the script never guesses:
-- it refuses a database that is not at exactly 0000–0026 (which also makes a second
-- run a no-op that only reports the guard), and one holding ledger values it has
-- no rule for. A failed guard reads "CHECK constraint failed: <guard> = 1".
--
-- Money is moved or relabelled, never deleted, so the balance of every ledger is the
-- same afterwards (verify.sql). Undo: the backup, or D1 Time Travel.

CREATE TABLE `baseline_guard` (
  `old_migrations_applied` integer CHECK (`old_migrations_applied` = 1),
  `ledger_values_known` integer CHECK (`ledger_values_known` = 1)
);

INSERT INTO `baseline_guard` (`old_migrations_applied`)
  SELECT COUNT(*) = 27 AND COUNT(*) = (
    SELECT COUNT(*) FROM `d1_migrations` WHERE `name` IN (
      '0000_init.sql', '0001_accounts.sql', '0002_auth.sql', '0003_billing.sql',
      '0004_fees.sql', '0005_accounts_per_mode.sql', '0006_account_settings.sql',
      '0007_membership.sql', '0008_drop_oauth_tokens.sql', '0009_share_allowed.sql',
      '0010_pool_ledger.sql', '0011_pool_access.sql', '0012_pool_consent_tags.sql',
      '0013_pool_impact.sql', '0014_model_prices.sql', '0015_polar_neutral.sql',
      '0016_drop_stripe.sql', '0017_pool_revenue_share.sql', '0018_payment_ref.sql',
      '0019_member_tier.sql', '0020_branch_funding.sql', '0021_retire_fake_provider.sql',
      '0022_grounding.sql', '0023_node_links.sql', '0024_model_cache_prices.sql',
      '0025_learn_tiers.sql', '0026_model_windows.sql'
    )
  )
  FROM `d1_migrations`;

INSERT INTO `baseline_guard` (`ledger_values_known`)
  SELECT NOT EXISTS (
      SELECT 1 FROM `credit_grants`
      WHERE `kind` NOT IN ('purchase', 'refund', 'adjustment', 'subscription', 'contribution')
    ) AND NOT EXISTS (
      SELECT 1 FROM `usage_events`
      WHERE `purpose` NOT IN ('reply', 'summary', 'title', 'review', 'other', 'tagging')
    );

-- Dispute markers: zero-amount adjustments keyed `<disputeRef>:ignored` / `:lost`
-- (on the ledger of the buyer or `payment-markers`) become rows of their own table, which
-- billing/payments/apply.ts now reads. They carry no money.
CREATE TABLE `billing_markers` (
	`ref` text PRIMARY KEY NOT NULL,
	`created_at` text NOT NULL
);

INSERT INTO `billing_markers` (`ref`, `created_at`)
  SELECT `provider_ref`, `created_at` FROM `credit_grants`
  WHERE `kind` = 'adjustment' AND `amount_micros` = 0
    AND (`provider_ref` LIKE '%:dispute:%:ignored' OR `provider_ref` LIKE '%:dispute:%:lost');

DELETE FROM `credit_grants`
  WHERE `kind` = 'adjustment' AND `amount_micros` = 0
    AND `provider_ref` IN (SELECT `ref` FROM `billing_markers`);

-- `contribution` (the revenue share of the pool and its reversals) and `subscription`
-- (membership credit) are real money that the code no longer mints. A grant or debit by an
-- operator is `adjustment` (routes/admin.ts, PoolBank.debit), and nothing reads
-- the kind of a non-purchase row except to treat it as "not a purchase", which both
-- old kinds already were, so they become adjustments with the same amount. The note
-- keeps the old kind.
UPDATE `credit_grants`
  SET `note` = COALESCE(`note` || ' ', '') || '(kind was ' || `kind` || ')',
      `kind` = 'adjustment'
  WHERE `kind` IN ('contribution', 'subscription');

-- The calls of the topic classifier are what the pool paid for them: deleting them would
-- hand that spend back to the balance of the pool (and disagree with the balance
-- checkpoint PoolBank stores). They stay as `other`.
UPDATE `usage_events` SET `purpose` = 'other' WHERE `purpose` = 'tagging';

-- Indexes first: SQLite cannot drop a column an index uses.
DROP INDEX IF EXISTS `accounts_user_mode_uq`;
DROP INDEX IF EXISTS `pool_topic_tags_topic_idx`;
DROP INDEX IF EXISTS `usage_events_pool_tier_idx`;
DROP INDEX IF EXISTS `usage_events_branch_idx`;
DROP INDEX IF EXISTS `usage_events_personal_settled_idx`;

DROP TABLE IF EXISTS `accounts`;
DROP TABLE IF EXISTS `pool_consents`;
DROP TABLE IF EXISTS `pool_topic_tags`;
DROP TABLE IF EXISTS `pool_impact_snapshots`;
DROP TABLE IF EXISTS `pool_impact_topics`;
DROP TABLE IF EXISTS `pool_topic_reviews`;
DROP TABLE IF EXISTS `model_price_history`;

ALTER TABLE `usage_events` DROP COLUMN `tier`;
ALTER TABLE `credit_grants` DROP COLUMN `margin_bps`;

-- The record wrangler keeps of applied migrations now holds exactly the baseline, so
-- `wrangler d1 migrations apply` (the deploy job) finds nothing to apply.
DELETE FROM `d1_migrations`;
INSERT INTO `d1_migrations` (`name`) VALUES ('0000_baseline.sql');

DROP TABLE `baseline_guard`;
