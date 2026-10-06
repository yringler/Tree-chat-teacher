ALTER TABLE `credit_grants` ADD `margin_bps` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `credit_grants` ADD `user_id` text;--> statement-breakpoint
CREATE INDEX `credit_grants_user_idx` ON `credit_grants` (`user_id`,`kind`);--> statement-breakpoint
CREATE INDEX `credit_grants_account_created_idx` ON `credit_grants` (`account_id`,`created_at`);--> statement-breakpoint
ALTER TABLE `usage_events` ADD `branch_id` text;--> statement-breakpoint
ALTER TABLE `usage_events` ADD `user_id` text;--> statement-breakpoint
ALTER TABLE `usage_events` ADD `funding` text DEFAULT 'personal' NOT NULL;--> statement-breakpoint
ALTER TABLE `usage_events` ADD `ip_key` text;--> statement-breakpoint
ALTER TABLE `usage_events` ADD `tier` text;--> statement-breakpoint
ALTER TABLE `usage_events` ADD `overage_micros` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `usage_events` ADD `settle_reason` text;--> statement-breakpoint
ALTER TABLE `usage_events` ADD `dispatched_at` text;--> statement-breakpoint
CREATE INDEX `usage_events_account_status_idx` ON `usage_events` (`account_id`,`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `usage_events_pool_user_idx` ON `usage_events` (`account_id`,`user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `usage_events_pool_ip_idx` ON `usage_events` (`account_id`,`ip_key`,`created_at`);--> statement-breakpoint
CREATE INDEX `usage_events_pool_tier_idx` ON `usage_events` (`account_id`,`tier`,`created_at`);