-- Read-only. Run after convert.sql (docs/runbooks/d1-baseline.md, step 6), from apps/worker:
--   npx wrangler d1 execute tangent --remote --command="$(cat scripts/d1-baseline/verify.sql)"

-- Exactly one row, 0000_baseline.sql, until the deploy job applies the later migrations.
SELECT id, name, applied_at FROM d1_migrations ORDER BY id;

-- Nothing the baseline lacks: expect no rows.
SELECT type, name FROM sqlite_master
  WHERE name IN (
    'accounts', 'pool_consents', 'pool_topic_tags', 'pool_impact_snapshots',
    'pool_impact_topics', 'pool_topic_reviews', 'model_price_history', 'baseline_guard',
    'accounts_user_mode_uq', 'pool_topic_tags_topic_idx', 'usage_events_pool_tier_idx',
    'usage_events_branch_idx', 'usage_events_personal_settled_idx'
  )
  OR (name IN ('usage_events', 'credit_grants') AND (sql LIKE '%`tier`%' OR sql LIKE '%margin_bps%'));

-- The moved dispute markers.
SELECT ref, created_at FROM billing_markers ORDER BY created_at;

-- The balance of every ledger: the same lines as precheck.sql printed before converting.
SELECT account_id,
       SUM(granted) - SUM(settled) AS balance_micros,
       SUM(held) AS held_micros
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
