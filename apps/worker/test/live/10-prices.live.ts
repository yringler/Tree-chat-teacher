// The daily price sync against OpenRouter's real model list: every model the deployment
// prices is listed with a usable price under the field names the parser reads, and an
// operator's MODEL_PRICES entry still wins over what the sync stores.
import { describe } from 'vitest';
import { appConfig } from '../../src/config.js';
import { syncModelPrices, trackedModels } from '../../src/pool/model-prices.js';
import { modelPrice, storedPrice } from '../../src/pool/price-table.js';
import { env, scenario } from './harness.js';

describe('price sync', () => {
  scenario('syncModelPrices against /api/v1/models', 'openrouter', async () => {
    const result = await syncModelPrices(env, new Date());
    const failures: string[] = [];
    const warnings: string[] = [];
    for (const model of trackedModels(env)) {
      const stored = await storedPrice(env.DB, model);
      if (!stored) failures.push(`${model} has no usable list price`);
      else if (stored.cacheReadMicrosPerMTok === null)
        warnings.push(`${model} lists no input_cache_read price`);
    }
    if (result.missing.length > 0) failures.push(`not listed: ${result.missing.join(', ')}`);
    if (result.anomalies.length > 0) warnings.push(`held back: ${result.anomalies.join(', ')}`);
    return {
      model: null,
      failures,
      warnings,
      notes: [`${result.changed.length + result.unchanged.length} tracked prices stored`],
    };
  });

  scenario('a MODEL_PRICES entry wins over the synced price', 'openrouter', async () => {
    const config = appConfig(env);
    const failures: string[] = [];
    const notes: string[] = [];
    for (const model of config.priceOverrides) {
      const held = await modelPrice(env, model);
      const configured = config.prices[model]!;
      const listed = await storedPrice(env.DB, model);
      notes.push(
        `${model}: held ${held?.inMicrosPerMTok}/${held?.outMicrosPerMTok}, listed ${listed?.inMicrosPerMTok ?? '–'}/${listed?.outMicrosPerMTok ?? '–'} µ$/MTok`,
      );
      if (
        held?.inMicrosPerMTok !== configured.inMicrosPerMTok ||
        held.outMicrosPerMTok !== configured.outMicrosPerMTok
      )
        failures.push(`${model} is held at the synced price, not its MODEL_PRICES entry`);
    }
    return {
      model: null,
      failures,
      warnings: config.priceOverrides.length === 0 ? ['the deployment overrides no price'] : [],
      notes,
    };
  });
});
