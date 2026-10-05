-- Payments moved to a provider port (docs/polar-migration/03-architecture.md §4): the
-- Better Auth Stripe plugin's membership table and the Stripe customer id on users go.
-- Pre-launch, these hold test-mode data at most (02-stripe-to-polar-mapping.md §1, §6 step 0).
DROP TABLE `auth_subscriptions`;--> statement-breakpoint
DROP INDEX `auth_users_stripe_customer_idx`;--> statement-breakpoint
ALTER TABLE `auth_users` DROP COLUMN `stripe_customer_id`;