-- The offline fake provider ("Fake (offline)", id `fake`) is no longer one of power mode's
-- default providers (docs/DECISIONS.md "Fake reply removed"). A branch left on it would
-- fail every send with "Unknown provider". It moves to OpenRouter on the user's own key
-- (`openrouter`, the one key both apps share), with that provider's default model in
-- wrangler.jsonc (SIMPLE_SMART_MODEL; power's OpenRouter takes any model id). Never
-- Tangent credit: nobody chose to pay for these branches. Without a key, the next send
-- asks for one (401 key_required), and the branch's settings can pick another provider.
--
-- Replies keep the provider they ran on (`nodes.provider_id`): that is history, like the
-- usage rows. Cached summaries made by the fake (`summaries.provider_id`) are keyed by its
-- model, so nothing reads them again; they are left alone.
UPDATE `branches`
  SET `provider_id` = 'openrouter', `model` = 'deepseek/deepseek-v4-pro', `funding` = 'own-key'
  WHERE `provider_id` = 'fake';
