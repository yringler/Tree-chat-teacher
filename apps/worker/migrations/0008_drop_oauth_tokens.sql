-- OAuth tokens are no longer stored (auth/auth.ts, NO_OAUTH_TOKENS): clear the ones already kept.
UPDATE `auth_accounts` SET `access_token` = NULL, `refresh_token` = NULL, `id_token` = NULL, `access_token_expires_at` = NULL, `refresh_token_expires_at` = NULL;
