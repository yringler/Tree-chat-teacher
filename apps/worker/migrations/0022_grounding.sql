ALTER TABLE `branches` ADD `grounding` text DEFAULT 'auto' NOT NULL;--> statement-breakpoint
ALTER TABLE `nodes` ADD `sources` text;--> statement-breakpoint
ALTER TABLE `usage_events` ADD `web_searches` integer DEFAULT 0 NOT NULL;