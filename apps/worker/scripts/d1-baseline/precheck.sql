-- Read-only. Run before convert.sql, on the database still at migrations 0000–0026
-- (docs/runbooks/d1-baseline.md, step 3), from apps/worker:
--   npx wrangler d1 execute tangent --remote --command="$(cat scripts/d1-baseline/precheck.sql)"
-- (`--file` would run it through the D1 import, which prints no query results; the `=`
-- keeps wrangler from reading the leading `--` comment as an option.)

-- 1. Rows in the tables convert.sql drops: removed features, expected to be thrown away.
SELECT
  (SELECT COUNT(*) FROM accounts) AS accounts,
  (SELECT COUNT(*) FROM pool_consents) AS pool_consents,
  (SELECT COUNT(*) FROM pool_topic_tags) AS pool_topic_tags,
  (SELECT COUNT(*) FROM pool_impact_snapshots) AS pool_impact_snapshots,
  (SELECT COUNT(*) FROM pool_impact_topics) AS pool_impact_topics,
  (SELECT COUNT(*) FROM pool_topic_reviews) AS pool_topic_reviews,
  (SELECT COUNT(*) FROM model_price_history) AS model_price_history;

-- 2. Values in the columns convert.sql drops.
SELECT
  (SELECT COUNT(*) FROM usage_events WHERE tier IS NOT NULL) AS usage_tier_set,
  (SELECT COUNT(*) FROM credit_grants WHERE margin_bps <> 0) AS grant_margin_set;

-- 3. Ledger rows convert.sql moves or relabels. `markers` is expected if a dispute was
-- ever seen. Anything else non-zero here: stop and send this output to Claude first.
SELECT
  (SELECT COUNT(*) FROM credit_grants
    WHERE kind = 'adjustment' AND amount_micros = 0
      AND (provider_ref LIKE '%:dispute:%:ignored' OR provider_ref LIKE '%:dispute:%:lost')) AS markers,
  (SELECT COUNT(*) FROM credit_grants WHERE kind = 'contribution') AS contribution_grants,
  (SELECT COUNT(*) FROM credit_grants WHERE kind = 'subscription') AS subscription_grants,
  (SELECT COUNT(*) FROM usage_events WHERE purpose = 'tagging') AS tagging_usage;

-- 4. Must be 0, or stop and send this output to Claude. Purchases on a ledger that
-- is not a user ledger (`u_<userId>`), e.g. older pool purchases: a refund or dispute of one
-- would now be debited outside the PoolBank lock. Unknown kinds and purposes: convert.sql
-- refuses to run on them.
SELECT
  (SELECT COUNT(*) FROM credit_grants
    WHERE kind = 'purchase' AND account_id NOT LIKE 'u\_%' ESCAPE '\') AS non_user_purchases,
  (SELECT COUNT(*) FROM credit_grants
    WHERE kind NOT IN ('purchase', 'refund', 'adjustment', 'subscription', 'contribution')) AS unknown_kinds,
  (SELECT COUNT(*) FROM usage_events
    WHERE purpose NOT IN ('reply', 'summary', 'title', 'review', 'other', 'tagging')) AS unknown_purposes;

-- 5. The rows behind sections 3 and 4, one by one.
SELECT id, account_id, kind, amount_micros, provider_ref, payment_ref, note, created_at
  FROM credit_grants
  WHERE kind IN ('contribution', 'subscription')
     OR (kind = 'purchase' AND account_id NOT LIKE 'u\_%' ESCAPE '\')
     OR (kind = 'adjustment' AND amount_micros = 0
         AND (provider_ref LIKE '%:dispute:%:ignored' OR provider_ref LIKE '%:dispute:%:lost'))
  ORDER BY created_at;

-- 6. Tagging calls by ledger and status: what the pool paid for the removed classifier.
SELECT account_id, funding, status, COUNT(*) AS calls,
       COALESCE(SUM(charge_micros), 0) AS charged_micros, COALESCE(SUM(hold_micros), 0) AS held_micros
  FROM usage_events WHERE purpose = 'tagging'
  GROUP BY account_id, funding, status;

-- 7. The balance of every ledger (billing/ledger.ts): verify.sql prints the same after converting.
SELECT account_id, SUM(granted) - SUM(settled) AS balance_micros, SUM(held) AS held_micros
  FROM (
    SELECT account_id, amount_micros AS granted, 0 AS settled, 0 AS held FROM credit_grants
    UNION ALL
    SELECT account_id, 0,
           CASE WHEN status = 'settled' THEN COALESCE(charge_micros, 0) ELSE 0 END,
           CASE WHEN status = 'pending' THEN hold_micros ELSE 0 END
      FROM usage_events
  )
  GROUP BY account_id
  ORDER BY account_id;

-- 8. What wrangler has recorded as applied: convert.sql expects exactly 0000–0026.
SELECT id, name, applied_at FROM d1_migrations ORDER BY id;
