CREATE TABLE `account_settings` (
	`account_id` text PRIMARY KEY NOT NULL,
	`system_prompt` text,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `auth_accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`account_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`access_token` text,
	`refresh_token` text,
	`id_token` text,
	`access_token_expires_at` integer,
	`refresh_token_expires_at` integer,
	`scope` text,
	`password` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `auth_users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `auth_accounts_user_idx` ON `auth_accounts` (`user_id`);--> statement-breakpoint
CREATE TABLE `auth_passkeys` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text,
	`public_key` text NOT NULL,
	`user_id` text NOT NULL,
	`credential_id` text NOT NULL,
	`counter` integer NOT NULL,
	`device_type` text NOT NULL,
	`backed_up` integer NOT NULL,
	`transports` text,
	`created_at` integer,
	`aaguid` text,
	FOREIGN KEY (`user_id`) REFERENCES `auth_users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `auth_passkeys_user_idx` ON `auth_passkeys` (`user_id`);--> statement-breakpoint
CREATE INDEX `auth_passkeys_credential_idx` ON `auth_passkeys` (`credential_id`);--> statement-breakpoint
CREATE TABLE `auth_rate_limits` (
	`id` text PRIMARY KEY NOT NULL,
	`key` text NOT NULL,
	`count` integer NOT NULL,
	`last_request` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `auth_rate_limits_key_unique` ON `auth_rate_limits` (`key`);--> statement-breakpoint
CREATE TABLE `auth_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`token` text NOT NULL,
	`user_id` text NOT NULL,
	`expires_at` integer NOT NULL,
	`ip_address` text,
	`user_agent` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `auth_users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `auth_sessions_token_unique` ON `auth_sessions` (`token`);--> statement-breakpoint
CREATE INDEX `auth_sessions_user_idx` ON `auth_sessions` (`user_id`);--> statement-breakpoint
CREATE TABLE `auth_users` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`email` text NOT NULL,
	`email_verified` integer DEFAULT false NOT NULL,
	`image` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`membership_waived` integer DEFAULT false NOT NULL,
	`membership_waived_at` text,
	`share_allowed` integer DEFAULT false NOT NULL,
	`pool_suspended` integer DEFAULT false NOT NULL,
	`pool_verified_at` text,
	`pool_identity` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `auth_users_email_unique` ON `auth_users` (`email`);--> statement-breakpoint
CREATE UNIQUE INDEX `auth_users_pool_identity_idx` ON `auth_users` (`pool_identity`) WHERE "auth_users"."pool_identity" IS NOT NULL;--> statement-breakpoint
CREATE TABLE `auth_verifications` (
	`id` text PRIMARY KEY NOT NULL,
	`identifier` text NOT NULL,
	`value` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `auth_verifications_identifier_idx` ON `auth_verifications` (`identifier`);--> statement-breakpoint
CREATE TABLE `billing_customers` (
	`provider` text NOT NULL,
	`user_id` text NOT NULL,
	`customer_ref` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`provider`, `user_id`)
);
--> statement-breakpoint
CREATE INDEX `billing_customers_ref_idx` ON `billing_customers` (`provider`,`customer_ref`);--> statement-breakpoint
CREATE TABLE `billing_markers` (
	`ref` text PRIMARY KEY NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
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
CREATE INDEX `billing_subscriptions_user_idx` ON `billing_subscriptions` (`user_id`,`kind`);--> statement-breakpoint
CREATE TABLE `branches` (
	`id` text PRIMARY KEY NOT NULL,
	`tree_id` text NOT NULL,
	`parent_branch_id` text,
	`branch_point_node_id` text,
	`context_mode` text NOT NULL,
	`anchor_quote` text,
	`title` text NOT NULL,
	`title_source` text NOT NULL,
	`is_private` integer DEFAULT false NOT NULL,
	`provider_id` text NOT NULL,
	`model` text NOT NULL,
	`funding` text DEFAULT 'own-key' NOT NULL,
	`grounding` text DEFAULT 'auto' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`tree_id`) REFERENCES `trees`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `branches_tree_idx` ON `branches` (`tree_id`);--> statement-breakpoint
CREATE INDEX `branches_parent_idx` ON `branches` (`parent_branch_id`);--> statement-breakpoint
CREATE INDEX `branches_point_idx` ON `branches` (`branch_point_node_id`);--> statement-breakpoint
CREATE TABLE `credit_grants` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`kind` text NOT NULL,
	`amount_micros` integer NOT NULL,
	`gross_micros` integer,
	`fee_micros` integer DEFAULT 0 NOT NULL,
	`user_id` text,
	`provider_ref` text,
	`payment_ref` text,
	`note` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `credit_grants_provider_ref_unique` ON `credit_grants` (`provider_ref`);--> statement-breakpoint
CREATE INDEX `credit_grants_account_idx` ON `credit_grants` (`account_id`);--> statement-breakpoint
CREATE INDEX `credit_grants_user_idx` ON `credit_grants` (`user_id`,`kind`);--> statement-breakpoint
CREATE INDEX `credit_grants_account_created_idx` ON `credit_grants` (`account_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `credit_grants_payment_idx` ON `credit_grants` (`payment_ref`);--> statement-breakpoint
CREATE TABLE `model_prices` (
	`model` text PRIMARY KEY NOT NULL,
	`in_micros_per_mtok` integer NOT NULL,
	`out_micros_per_mtok` integer NOT NULL,
	`context_tokens` integer,
	`cache_read_micros_per_mtok` integer,
	`cache_write_micros_per_mtok` integer,
	`fetched_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `model_windows` (
	`model` text PRIMARY KEY NOT NULL,
	`context_tokens` integer NOT NULL,
	`max_output_tokens` integer,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `node_links` (
	`id` text PRIMARY KEY NOT NULL,
	`tree_id` text NOT NULL,
	`source_node_id` text NOT NULL,
	`target_node_id` text NOT NULL,
	`pair_key` text NOT NULL,
	`note` text,
	`origin` text DEFAULT 'user' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`tree_id`) REFERENCES `trees`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_node_id`) REFERENCES `nodes`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`target_node_id`) REFERENCES `nodes`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "node_links_distinct_ends" CHECK(source_node_id <> target_node_id)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `node_links_pair_uq` ON `node_links` (`pair_key`);--> statement-breakpoint
CREATE INDEX `node_links_tree_idx` ON `node_links` (`tree_id`);--> statement-breakpoint
CREATE INDEX `node_links_source_idx` ON `node_links` (`source_node_id`);--> statement-breakpoint
CREATE INDEX `node_links_target_idx` ON `node_links` (`target_node_id`);--> statement-breakpoint
CREATE TABLE `nodes` (
	`id` text PRIMARY KEY NOT NULL,
	`tree_id` text NOT NULL,
	`branch_id` text NOT NULL,
	`parent_id` text,
	`seq` integer NOT NULL,
	`role` text NOT NULL,
	`content` text NOT NULL,
	`status` text NOT NULL,
	`error` text,
	`provider_id` text,
	`model` text,
	`input_tokens` integer,
	`output_tokens` integer,
	`sources` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`tree_id`) REFERENCES `trees`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`branch_id`) REFERENCES `branches`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `nodes_branch_seq_uq` ON `nodes` (`branch_id`,`seq`);--> statement-breakpoint
CREATE INDEX `nodes_tree_idx` ON `nodes` (`tree_id`);--> statement-breakpoint
CREATE INDEX `nodes_parent_idx` ON `nodes` (`parent_id`);--> statement-breakpoint
CREATE INDEX `nodes_streaming_idx` ON `nodes` (`tree_id`) WHERE status = 'streaming';--> statement-breakpoint
CREATE TABLE `pool_identities` (
	`identity` text PRIMARY KEY NOT NULL,
	`suspended` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE `pool_identity_holders` (
	`user_id` text PRIMARY KEY NOT NULL,
	`identity` text NOT NULL,
	`claimed_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `pool_identity_holders_identity_idx` ON `pool_identity_holders` (`identity`);--> statement-breakpoint
CREATE TABLE `share_snapshots` (
	`share_id` text NOT NULL,
	`chunk` integer NOT NULL,
	`data` text NOT NULL,
	PRIMARY KEY(`share_id`, `chunk`),
	FOREIGN KEY (`share_id`) REFERENCES `shares`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `shares` (
	`id` text PRIMARY KEY NOT NULL,
	`token` text NOT NULL,
	`account_id` text DEFAULT 'default' NOT NULL,
	`tree_id` text NOT NULL,
	`scope` text NOT NULL,
	`target_node_id` text,
	`include_ancestors` integer DEFAULT false NOT NULL,
	`mode` text NOT NULL,
	`title` text,
	`expires_at` text,
	`revoked_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`published_at` text,
	`version` integer DEFAULT 1 NOT NULL,
	`view_count` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`tree_id`) REFERENCES `trees`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `shares_token_uq` ON `shares` (`token`);--> statement-breakpoint
CREATE INDEX `shares_tree_idx` ON `shares` (`tree_id`);--> statement-breakpoint
CREATE INDEX `shares_account_idx` ON `shares` (`account_id`);--> statement-breakpoint
CREATE TABLE `summaries` (
	`anchor_node_id` text NOT NULL,
	`source_hash` text NOT NULL,
	`model` text NOT NULL,
	`provider_id` text NOT NULL,
	`tree_id` text NOT NULL,
	`content` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`anchor_node_id`, `source_hash`, `model`),
	FOREIGN KEY (`tree_id`) REFERENCES `trees`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `summaries_tree_idx` ON `summaries` (`tree_id`);--> statement-breakpoint
CREATE TABLE `trees` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`system_prompt` text,
	`trunk_branch_id` text NOT NULL,
	`account_id` text DEFAULT 'default' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `trees_account_idx` ON `trees` (`account_id`,`updated_at`);--> statement-breakpoint
CREATE TABLE `usage_events` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`tree_id` text,
	`node_id` text,
	`branch_id` text,
	`user_id` text,
	`funding` text DEFAULT 'personal' NOT NULL,
	`ip_key` text,
	`purpose` text NOT NULL,
	`provider_id` text NOT NULL,
	`model` text NOT NULL,
	`generation_id` text,
	`status` text NOT NULL,
	`hold_micros` integer NOT NULL,
	`markup_bps` integer NOT NULL,
	`fee_bps` integer DEFAULT 0 NOT NULL,
	`cost_nanos` integer,
	`charge_micros` integer,
	`overage_micros` integer DEFAULT 0 NOT NULL,
	`settle_reason` text,
	`input_tokens` integer,
	`output_tokens` integer,
	`web_searches` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`dispatched_at` text,
	`settled_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `usage_events_generation_id_unique` ON `usage_events` (`generation_id`);--> statement-breakpoint
CREATE INDEX `usage_events_account_idx` ON `usage_events` (`account_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `usage_events_pending_idx` ON `usage_events` (`created_at`) WHERE status = 'pending';--> statement-breakpoint
CREATE INDEX `usage_events_account_status_idx` ON `usage_events` (`account_id`,`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `usage_events_pool_user_idx` ON `usage_events` (`account_id`,`user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `usage_events_pool_ip_idx` ON `usage_events` (`account_id`,`ip_key`,`created_at`);