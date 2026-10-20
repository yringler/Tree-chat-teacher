ALTER TABLE `account_settings` ADD `tier_normal_provider_id` text;--> statement-breakpoint
ALTER TABLE `account_settings` ADD `tier_normal_funding` text;--> statement-breakpoint
ALTER TABLE `account_settings` ADD `tier_normal_model` text;--> statement-breakpoint
ALTER TABLE `account_settings` ADD `tier_max_provider_id` text;--> statement-breakpoint
ALTER TABLE `account_settings` ADD `tier_max_funding` text;--> statement-breakpoint
ALTER TABLE `account_settings` ADD `tier_max_model` text;--> statement-breakpoint
ALTER TABLE `account_settings` ADD `reviewer_provider_id` text;--> statement-breakpoint
ALTER TABLE `account_settings` ADD `reviewer_funding` text;--> statement-breakpoint
ALTER TABLE `account_settings` ADD `reviewer_model` text;--> statement-breakpoint
ALTER TABLE `account_settings` ADD `max_output_tokens` integer;--> statement-breakpoint
ALTER TABLE `account_settings` ADD `max_input_tokens` integer;--> statement-breakpoint
ALTER TABLE `account_settings` ADD `input_overflow` text;