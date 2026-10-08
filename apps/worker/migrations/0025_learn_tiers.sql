-- Learn's tiers are now Normal (deepseek/deepseek-v4.1-flash, the default) and
-- Max (anthropic/claude-sonnet-5.5) (docs/DECISIONS.md "Learn tiers: Normal and
-- Max" and "Hosted models from the eval"). The old tiers' DeepSeek models,
-- deepseek/deepseek-v4-flash (the old cheaper tier) and deepseek/deepseek-v4-pro
-- (the old default tier), are no longer Learn models, so a Learn branch left on
-- either would fail every send with a 400 (the model isn't allowed). Both move
-- to Normal: the old default tier's lessons keep the everyday tier, and the
-- cheaper tier's get the one that replaced it.
--
-- Only Learn's branches: trees of `simple` accounts. Power branches on these
-- models (Tangent credit and power's OpenRouter take any model id) are left
-- alone. Replies keep the model they ran on (`nodes.model`), like the usage rows
-- and cached summaries: that is history.
UPDATE `branches` SET `model` = 'deepseek/deepseek-v4.1-flash'
  WHERE `provider_id` = 'openrouter'
    AND `model` IN ('deepseek/deepseek-v4-flash', 'deepseek/deepseek-v4-pro')
    AND `tree_id` IN (
      SELECT t.`id` FROM `trees` t JOIN `accounts` a ON a.`id` = t.`account_id`
      WHERE a.`mode` = 'simple'
    );
