ALTER TABLE `pool_identities` ADD `deleted_at` text;--> statement-breakpoint
ALTER TABLE `pool_identities` ADD `deleted_day_requests` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `pool_identities` ADD `deleted_day_spend_micros` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
-- One-time backfill: what accounts deleted before this migration left behind loses its user id and network key, as account deletion now does, and their pool identities are kept POOL_IDENTITY_RETENTION_DAYS from now.
UPDATE `usage_events` SET `user_id` = NULL, `ip_key` = NULL WHERE `user_id` IS NOT NULL AND `user_id` NOT IN (SELECT `id` FROM `auth_users`);--> statement-breakpoint
UPDATE `credit_grants` SET `user_id` = NULL WHERE `user_id` IS NOT NULL AND `user_id` NOT IN (SELECT `id` FROM `auth_users`) AND `account_id` <> 'u_' || `user_id`;--> statement-breakpoint
DELETE FROM `pool_identity_holders` WHERE `user_id` NOT IN (SELECT `id` FROM `auth_users`);--> statement-breakpoint
UPDATE `pool_identities` SET `deleted_at` = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE `identity` NOT IN (SELECT `pool_identity` FROM `auth_users` WHERE `pool_identity` IS NOT NULL);
