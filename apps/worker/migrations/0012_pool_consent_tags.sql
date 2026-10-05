CREATE TABLE `pool_consents` (
	`user_id` text NOT NULL,
	`notice_version` integer NOT NULL,
	`acknowledged_at` text NOT NULL,
	PRIMARY KEY(`user_id`, `notice_version`)
);
--> statement-breakpoint
CREATE TABLE `pool_topic_tags` (
	`branch_id` text PRIMARY KEY NOT NULL,
	`topic_id` text NOT NULL,
	`branch_depth` integer NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `pool_topic_tags_topic_idx` ON `pool_topic_tags` (`topic_id`,`created_at`);