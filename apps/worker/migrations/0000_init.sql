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
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`tree_id`) REFERENCES `trees`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `branches_tree_idx` ON `branches` (`tree_id`);--> statement-breakpoint
CREATE INDEX `branches_parent_idx` ON `branches` (`parent_branch_id`);--> statement-breakpoint
CREATE INDEX `branches_point_idx` ON `branches` (`branch_point_node_id`);--> statement-breakpoint
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
	`created_at` text NOT NULL,
	FOREIGN KEY (`tree_id`) REFERENCES `trees`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`branch_id`) REFERENCES `branches`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `nodes_branch_seq_uq` ON `nodes` (`branch_id`,`seq`);--> statement-breakpoint
CREATE INDEX `nodes_tree_idx` ON `nodes` (`tree_id`);--> statement-breakpoint
CREATE INDEX `nodes_parent_idx` ON `nodes` (`parent_id`);--> statement-breakpoint
CREATE INDEX `nodes_streaming_idx` ON `nodes` (`tree_id`) WHERE status = 'streaming';--> statement-breakpoint
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
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
