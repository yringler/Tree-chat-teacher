ALTER TABLE `auth_users` ADD `membership_waived` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `auth_users` ADD `membership_waived_at` text;