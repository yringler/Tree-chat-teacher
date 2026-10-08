-- Learn's tiers are now Normal (deepseek/deepseek-v4-pro, the default) and Max
-- (anthropic/claude-sonnet-5.5) (docs/DECISIONS.md "Learn tiers: Normal and Max").
-- The old cheaper tier, deepseek/deepseek-v4-flash, is no longer one of Learn's
-- models (it still writes summaries and titles, and is the open pool's default
-- model), so a Learn branch left on it would fail every send with a 400 (the
-- model isn't allowed). It moves to Normal, the model the old default tier ran on.
--
-- Only Learn's branches: trees of `simple` accounts. Power branches on Flash
-- (Tangent credit and power's OpenRouter take any model id) are left alone.
-- Replies keep the model they ran on (`nodes.model`), like the usage rows and
-- cached summaries: that is history.
UPDATE `branches` SET `model` = 'deepseek/deepseek-v4-pro'
  WHERE `provider_id` = 'openrouter'
    AND `model` = 'deepseek/deepseek-v4-flash'
    AND `tree_id` IN (
      SELECT t.`id` FROM `trees` t JOIN `accounts` a ON a.`id` = t.`account_id`
      WHERE a.`mode` = 'simple'
    );
