CREATE TABLE `pool_impact_snapshots` (
	`week_start` text PRIMARY KEY NOT NULL,
	`exchanges` integer NOT NULL,
	`learners` integer NOT NULL,
	`topics` integer NOT NULL,
	`avg_depth_milli` integer NOT NULL,
	`max_depth` integer NOT NULL,
	`deepest_topic_id` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `pool_impact_topics` (
	`week_start` text NOT NULL,
	`topic_id` text NOT NULL,
	`learners` integer NOT NULL,
	`exchanges` integer NOT NULL,
	`avg_depth_milli` integer NOT NULL,
	PRIMARY KEY(`week_start`, `topic_id`)
);
--> statement-breakpoint
CREATE TABLE `pool_topic_reviews` (
	`topic_id` text PRIMARY KEY NOT NULL,
	`status` text NOT NULL,
	`first_seen_week` text NOT NULL,
	`decided_at` text,
	`decided_by` text
);
--> statement-breakpoint
CREATE INDEX `usage_events_branch_idx` ON `usage_events` (`branch_id`,`created_at`);