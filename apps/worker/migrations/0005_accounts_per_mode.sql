DROP INDEX `accounts_user_uq`;--> statement-breakpoint
CREATE UNIQUE INDEX `accounts_user_mode_uq` ON `accounts` (`user_id`,`mode`);