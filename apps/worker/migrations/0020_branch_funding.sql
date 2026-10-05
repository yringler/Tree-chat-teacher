ALTER TABLE `branches` ADD `funding` text DEFAULT 'own-key' NOT NULL;--> statement-breakpoint
-- Funding apart from the provider (docs/DECISIONS.md): a provider id names only the
-- endpoint, and `branches.funding` says who pays in power mode. The built-in provider's
-- id was `tangent`; it is now the endpoint `openrouter`.
--
-- A power branch on `tangent` was on Tangent credit, by the meaning `tangent` had in
-- power: it keeps credit. Everything else keeps the default `own-key`:
-- - Learn branches on `tangent`: Learn paid per request (its payment header), never per
--   branch, so the row doesn't say who paid; Learn ignores a branch's funding and writes
--   `own-key`, the value that never spends credit.
-- - Branches of trees whose account row is missing or not `power`: unreachable or not
--   power, so the same safe value.
UPDATE `branches` SET `funding` = 'credit'
  WHERE `provider_id` = 'tangent'
    AND `tree_id` IN (
      SELECT t.`id` FROM `trees` t JOIN `accounts` a ON a.`id` = t.`account_id`
      WHERE a.`mode` = 'power'
    );--> statement-breakpoint
UPDATE `branches` SET `provider_id` = 'openrouter' WHERE `provider_id` = 'tangent';--> statement-breakpoint
-- Which endpoint produced a reply, and a summary's provider: informational, same rename.
-- Usage rows (`usage_events.provider_id`) are billing history and keep what they recorded.
UPDATE `nodes` SET `provider_id` = 'openrouter' WHERE `provider_id` = 'tangent';--> statement-breakpoint
UPDATE `summaries` SET `provider_id` = 'openrouter' WHERE `provider_id` = 'tangent';
