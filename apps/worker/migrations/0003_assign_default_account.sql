-- Sign-in is open to anyone and each user gets their own account (their
-- Better Auth user id). Data written while the app was single-user belongs to
-- the seeded `default` account; hand it to the first user who signed up (the
-- owner). With no users yet it stays on `default`, which only the local dev
-- bypass uses.
UPDATE `trees` SET `account_id` = (SELECT `id` FROM `auth_users` ORDER BY `created_at`, `id` LIMIT 1)
WHERE `account_id` = 'default' AND EXISTS (SELECT 1 FROM `auth_users`);
--> statement-breakpoint
UPDATE `shares` SET `account_id` = (SELECT `id` FROM `auth_users` ORDER BY `created_at`, `id` LIMIT 1)
WHERE `account_id` = 'default' AND EXISTS (SELECT 1 FROM `auth_users`);
