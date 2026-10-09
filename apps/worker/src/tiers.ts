// Normal and Max (@tangent/shared tiers.ts): how much more a Max reply uses,
// as `ModelInfo.usageFactor` on the Max model of every provider entry that
// lists both tiers. Computed per request from the price table (live D1
// prices, `modelPrice`), so it follows OpenRouter's list prices as the daily
// sync updates them; the clients only display it (`maxUsageNote`).
import {
  MAX_USAGE_FACTOR_FALLBACK,
  tierModel,
  usageFactorOf,
  type ProviderInfo,
} from '@tangent/shared';
import type { ModelPrice } from './config.js';
import type { AppEnv } from './env.js';
import { modelPrice } from './pool/price-table.js';
import { logEvent } from './log.js';

/**
 * `providers` with `usageFactor` set on the Max model of each entry that lists
 * both a Normal and a Max model: `usageFactorOf` their prices, else (a model
 * without a price, or a price that can't tell) `MAX_USAGE_FACTOR_FALLBACK`.
 * Each model is priced at most once per call. Never throws: a failed price
 * read means the fallback.
 */
export async function withUsageFactors(
  env: AppEnv,
  providers: ProviderInfo[],
): Promise<ProviderInfo[]> {
  const prices = new Map<string, Promise<ModelPrice | null>>();
  const priceOf = (model: string) => {
    let price = prices.get(model);
    if (!price) {
      price = modelPrice(env, model).catch((err: unknown) => {
        logEvent('error', 'price_read_failed', { model, fallback: 'usage_factor', error: err });
        return null;
      });
      prices.set(model, price);
    }
    return price;
  };
  return Promise.all(
    providers.map(async (provider) => {
      const normal = tierModel(provider.models, 'normal');
      const max = tierModel(provider.models, 'max');
      if (!normal || !max) return provider;
      const [normalPrice, maxPrice] = await Promise.all([priceOf(normal.id), priceOf(max.id)]);
      const usageFactor =
        (normalPrice && maxPrice && usageFactorOf(normalPrice, maxPrice)) ||
        MAX_USAGE_FACTOR_FALLBACK;
      return {
        ...provider,
        models: provider.models.map((m) => (m === max ? { ...m, usageFactor } : m)),
      };
    }),
  );
}
