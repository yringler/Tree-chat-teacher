CREATE TABLE `pool_identities` (
	`identity` text PRIMARY KEY NOT NULL,
	`suspended` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE `pool_identity_holders` (
	`user_id` text PRIMARY KEY NOT NULL,
	`identity` text NOT NULL,
	`claimed_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `pool_identity_holders_identity_idx` ON `pool_identity_holders` (`identity`);--> statement-breakpoint
ALTER TABLE `auth_users` ADD `pool_suspended` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `auth_users` ADD `pool_verified_at` text;--> statement-breakpoint
ALTER TABLE `auth_users` ADD `pool_identity` text;--> statement-breakpoint
CREATE UNIQUE INDEX `auth_users_pool_identity_idx` ON `auth_users` (`pool_identity`) WHERE "auth_users"."pool_identity" IS NOT NULL;