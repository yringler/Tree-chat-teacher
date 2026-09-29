CREATE TABLE `accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
ALTER TABLE `shares` ADD `account_id` text DEFAULT 'default' NOT NULL;--> statement-breakpoint
CREATE INDEX `shares_account_idx` ON `shares` (`account_id`);--> statement-breakpoint
ALTER TABLE `trees` ADD `account_id` text DEFAULT 'default' NOT NULL;--> statement-breakpoint
CREATE INDEX `trees_account_idx` ON `trees` (`account_id`,`updated_at`);--> statement-breakpoint
-- The single built-in account. Existing and new rows belong to it until multi-user exists.
INSERT INTO `accounts` (`id`, `name`, `created_at`) VALUES ('default', 'Default account', '2026-09-29T00:00:00.000Z');
