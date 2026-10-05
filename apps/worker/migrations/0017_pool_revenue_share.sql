-- The community pool is revenue-funded (docs/polar-migration/05-pool-framing.md, D1): nobody buys
-- pool credit; the cron adds a share of each UTC day's markup on personal credit
-- (src/pool/revenue-share.ts), summing the personal charges settled that day. The new
-- `credit_grants.kind` value `contribution` needs no DDL (the column is plain text).
CREATE INDEX `usage_events_personal_settled_idx` ON `usage_events` (`settled_at`) WHERE funding = 'personal' AND status = 'settled';