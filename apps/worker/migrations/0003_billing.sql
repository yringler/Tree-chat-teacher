CREATE TABLE `auth_subscriptions` (
	`id` text PRIMARY KEY NOT NULL,
	`plan` text NOT NULL,
	`reference_id` text NOT NULL,
	`stripe_customer_id` text,
	`stripe_subscription_id` text,
	`status` text DEFAULT 'incomplete' NOT NULL,
	`period_start` integer,
	`period_end` integer,
	`trial_start` integer,
	`trial_end` integer,
	`cancel_at_period_end` integer DEFAULT false NOT NULL,
	`cancel_at` integer,
	`canceled_at` integer,
	`ended_at` integer,
	`seats` integer,
	`billing_interval` text,
	`stripe_schedule_id` text
);
--> statement-breakpoint
CREATE INDEX `auth_subscriptions_reference_idx` ON `auth_subscriptions` (`reference_id`);--> statement-breakpoint
CREATE INDEX `auth_subscriptions_stripe_sub_idx` ON `auth_subscriptions` (`stripe_subscription_id`);--> statement-breakpoint
CREATE TABLE `credit_grants` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`kind` text NOT NULL,
	`amount_micros` integer NOT NULL,
	`stripe_ref` text,
	`note` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `credit_grants_stripe_ref_unique` ON `credit_grants` (`stripe_ref`);--> statement-breakpoint
CREATE INDEX `credit_grants_account_idx` ON `credit_grants` (`account_id`);--> statement-breakpoint
CREATE TABLE `usage_events` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`tree_id` text,
	`node_id` text,
	`purpose` text NOT NULL,
	`provider_id` text NOT NULL,
	`model` text NOT NULL,
	`generation_id` text,
	`status` text NOT NULL,
	`hold_micros` integer NOT NULL,
	`markup_bps` integer NOT NULL,
	`cost_nanos` integer,
	`charge_micros` integer,
	`input_tokens` integer,
	`output_tokens` integer,
	`created_at` text NOT NULL,
	`settled_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `usage_events_generation_id_unique` ON `usage_events` (`generation_id`);--> statement-breakpoint
CREATE INDEX `usage_events_account_idx` ON `usage_events` (`account_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `usage_events_pending_idx` ON `usage_events` (`created_at`) WHERE status = 'pending';--> statement-breakpoint
ALTER TABLE `accounts` ADD `user_id` text;--> statement-breakpoint
ALTER TABLE `accounts` ADD `mode` text DEFAULT 'power' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `accounts_user_uq` ON `accounts` (`user_id`);--> statement-breakpoint
ALTER TABLE `auth_users` ADD `stripe_customer_id` text;--> statement-breakpoint
CREATE INDEX `auth_users_stripe_customer_idx` ON `auth_users` (`stripe_customer_id`);