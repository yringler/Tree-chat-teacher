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
CREATE INDEX `node_links_target_idx` ON `node_links` (`target_node_id`);