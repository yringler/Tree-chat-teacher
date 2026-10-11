CREATE TABLE `audit_events` (
	`id` text PRIMARY KEY NOT NULL,
	`at` text NOT NULL,
	`kind` text NOT NULL,
	`actor` text NOT NULL,
	`actor_user_id` text,
	`subject_user_id` text,
	`share_id` text,
	`report_id` text,
	`hold_id` text,
	`data` text
);
--> statement-breakpoint
CREATE INDEX `audit_events_subject_idx` ON `audit_events` (`subject_user_id`,`kind`,`at`);--> statement-breakpoint
CREATE INDEX `audit_events_share_idx` ON `audit_events` (`share_id`);--> statement-breakpoint
CREATE INDEX `audit_events_kind_idx` ON `audit_events` (`kind`,`at`);--> statement-breakpoint
CREATE TABLE `legal_hold_items` (
	`hold_id` text NOT NULL,
	`kind` text NOT NULL,
	`chunk` integer NOT NULL,
	`data` text NOT NULL,
	PRIMARY KEY(`hold_id`, `kind`, `chunk`),
	FOREIGN KEY (`hold_id`) REFERENCES `legal_holds`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `legal_holds` (
	`id` text PRIMARY KEY NOT NULL,
	`reason` text NOT NULL,
	`report_id` text,
	`share_id` text,
	`subject_user_id` text,
	`subject_email` text,
	`created_at` text NOT NULL,
	`created_by` text,
	`released_at` text,
	`released_by` text,
	`notes` text
);
--> statement-breakpoint
CREATE INDEX `legal_holds_share_idx` ON `legal_holds` (`share_id`);--> statement-breakpoint
CREATE INDEX `legal_holds_subject_idx` ON `legal_holds` (`subject_user_id`);--> statement-breakpoint
CREATE TABLE `share_reports` (
	`id` text PRIMARY KEY NOT NULL,
	`share_id` text NOT NULL,
	`share_token` text NOT NULL,
	`owner_account_id` text NOT NULL,
	`category` text NOT NULL,
	`details` text NOT NULL,
	`reporter_email` text,
	`reporter_key` text,
	`reporter_user_id` text,
	`created_at` text NOT NULL,
	`resolution` text DEFAULT 'pending' NOT NULL,
	`resolved_at` text,
	`resolved_by` text,
	`notes` text
);
--> statement-breakpoint
CREATE INDEX `share_reports_queue_idx` ON `share_reports` (`resolution`,`created_at`);--> statement-breakpoint
CREATE INDEX `share_reports_share_idx` ON `share_reports` (`share_id`);--> statement-breakpoint
CREATE INDEX `share_reports_owner_idx` ON `share_reports` (`owner_account_id`);--> statement-breakpoint
ALTER TABLE `auth_users` ADD `sharing_suspended` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `shares` ADD `takedown` text;