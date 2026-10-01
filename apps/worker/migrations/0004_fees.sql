ALTER TABLE `credit_grants` ADD `gross_micros` integer;--> statement-breakpoint
ALTER TABLE `credit_grants` ADD `fee_micros` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `usage_events` ADD `fee_bps` integer DEFAULT 0 NOT NULL;