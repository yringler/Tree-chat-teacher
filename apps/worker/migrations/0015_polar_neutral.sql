-- Payments behind a provider port (docs/polar-migration/03-architecture.md §4):
-- the ledger's idempotency key gets a provider-neutral name, and two new
-- provider-neutral tables (unused until the domain switches to the port).
ALTER TABLE `credit_grants` RENAME COLUMN `stripe_ref` TO `provider_ref`;--> statement-breakpoint
DROP INDEX `credit_grants_stripe_ref_unique`;--> statement-breakpoint
CREATE UNIQUE INDEX `credit_grants_provider_ref_unique` ON `credit_grants` (`provider_ref`);--> statement-breakpoint
CREATE TABLE `billing_customers` (
	`provider` text NOT NULL,
	`user_id` text NOT NULL,
	`customer_ref` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`provider`, `user_id`)
);
--> statement-breakpoint
CREATE INDEX `billing_customers_ref_idx` ON `billing_customers` (`provider`,`customer_ref`);--> statement-breakpoint
CREATE TABLE `billing_subscriptions` (
	`ref` text PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,
	`user_id` text NOT NULL,
	`kind` text NOT NULL,
	`status` text NOT NULL,
	`provider_status` text NOT NULL,
	`current_period_end` text,
	`cancel_at_period_end` integer DEFAULT false NOT NULL,
	`ended_at` text,
	`version` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `billing_subscriptions_user_idx` ON `billing_subscriptions` (`user_id`,`kind`);