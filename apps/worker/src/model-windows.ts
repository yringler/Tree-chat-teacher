// The real context windows of OpenRouter models. A provider config names the
// windows it knows; any other OpenRouter model (power's open model list, on
// the user's key or on Tangent credit) was budgeted with the provider kind's
// 128,000-token default, too small for most current models and too large for
// a few. The daily price sync stores the window and output limit of every
// model OpenRouter lists (`model_windows`, from the same `/api/v1/models`
// response), and the registries the Worker builds look a model up there
// before ChatService budgets a call (`withModelWindows`).
//
// Which window a model gets: a priced model's price entry (`modelPrice`: the
// configured window, lowered by the synced one), else its synced row, else
// the config's (or the kind's default). A configured window is never raised:
// Tangent credit's and the pool's windows bound the size of their holds and
// their input caps, so they stay the lower of theirs and the model's. An
// output limit OpenRouter reports only ever lowers the configured one.
import { decorateProvider } from '@tangent/providers';
import type {
  LlmProvider,
  ProviderCapabilities,
  ProviderConfig,
  ProviderRegistry,
} from '@tangent/shared';
import type { AppEnv } from './env.js';
import { modelPrice } from './pool/price-table.js';
import { isOpenRouter } from './simple-mode.js';
import { logEvent } from './log.js';

/** A model's real limits, as OpenRouter lists them. */
export interface ModelWindow {
  /** `context_length`: input plus output. */
  contextTokens: number;
  /** `top_provider.max_completion_tokens`; null when not reported. */
  maxOutputTokens: number | null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function positiveInt(v: unknown): number | null {
  return typeof v === 'number' && Number.isSafeInteger(v) && v > 0 ? v : null;
}

/**
 * The windows in a `GET /api/v1/models` body, by model id: every listed model
 * with a usable `context_length`, priced or not. Throws on a body without `data`.
 */
export function parseModelWindows(body: unknown): Map<string, ModelWindow> {
  const data = isRecord(body) ? body['data'] : undefined;
  if (!Array.isArray(data)) throw new Error('OpenRouter models list has no data array');
  const windows = new Map<string, ModelWindow>();
  for (const entry of data) {
    if (!isRecord(entry) || typeof entry['id'] !== 'string') continue;
    const context = positiveInt(entry['context_length']);
    if (context === null) continue;
    const top = entry['top_provider'];
    windows.set(entry['id'], {
      contextTokens: context,
      maxOutputTokens: isRecord(top) ? positiveInt(top['max_completion_tokens']) : null,
    });
  }
  return windows;
}

interface WindowRow {
  model: string;
  context_tokens: number;
  max_output_tokens: number | null;
}

/** D1 binds at most 100 parameters a statement; four per row. */
const ROWS_PER_INSERT = 25;

/**
 * Stores the windows of a `GET /api/v1/models` body: new and changed rows
 * only (a few hundred models, most unchanged from day to day). Returns how
 * many were written. Throws when D1 can't be read or written.
 */
export async function syncModelWindows(
  env: AppEnv,
  now: Date,
  body: unknown,
): Promise<{ listed: number; changed: number }> {
  const listed = parseModelWindows(body);
  const { results } = await env.DB.prepare(
    'SELECT model, context_tokens, max_output_tokens FROM model_windows',
  ).all<WindowRow>();
  const stored = new Map(results.map((r) => [r.model, r]));
  const changed = [...listed].filter(([model, w]) => {
    const row = stored.get(model);
    return (
      !row || row.context_tokens !== w.contextTokens || row.max_output_tokens !== w.maxOutputTokens
    );
  });
  const at = now.toISOString();
  const writes: D1PreparedStatement[] = [];
  for (let i = 0; i < changed.length; i += ROWS_PER_INSERT) {
    const chunk = changed.slice(i, i + ROWS_PER_INSERT);
    writes.push(
      env.DB.prepare(
        `INSERT INTO model_windows (model, context_tokens, max_output_tokens, updated_at)
         VALUES ${chunk.map(() => '(?, ?, ?, ?)').join(', ')}
         ON CONFLICT (model) DO UPDATE SET context_tokens = excluded.context_tokens,
           max_output_tokens = excluded.max_output_tokens, updated_at = excluded.updated_at`,
      ).bind(...chunk.flatMap(([model, w]) => [model, w.contextTokens, w.maxOutputTokens, at])),
    );
  }
  if (writes.length > 0) await env.DB.batch(writes);
  const result = { listed: listed.size, changed: changed.length };
  logEvent('info', 'window_sync', result);
  return result;
}

/** The synced window of `model`, or null when OpenRouter never listed one. */
export async function storedWindow(db: D1Database, model: string): Promise<ModelWindow | null> {
  const row = await db
    .prepare('SELECT model, context_tokens, max_output_tokens FROM model_windows WHERE model = ?1')
    .bind(model)
    .first<WindowRow>();
  return row ? { contextTokens: row.context_tokens, maxOutputTokens: row.max_output_tokens } : null;
}

/**
 * `model`'s real limits (see the header): the price entry's window where the
 * model is priced (and the synced output limit), else the synced row; null
 * when neither knows it. A failed D1 read is logged and counts as unknown,
 * so a call falls back to the config's window rather than failing.
 */
export async function modelWindow(env: AppEnv, model: string): Promise<ModelWindow | null> {
  const [price, synced] = await Promise.all([
    modelPrice(env, model).catch((err: unknown) => {
      logEvent('error', 'price_read_failed', { model, error: err });
      return null;
    }),
    storedWindow(env.DB, model).catch((err: unknown) => {
      logEvent('error', 'window_read_failed', { model, error: err });
      return null;
    }),
  ]);
  if (price)
    return { contextTokens: price.contextTokens, maxOutputTokens: synced?.maxOutputTokens ?? null };
  return synced;
}

/**
 * `base` (a provider's capabilities from its config) with the model's real
 * limits: an unconfigured window becomes the real one, a configured one is
 * lowered to it, and the output limit is lowered to the reported one.
 */
export function withWindow(
  base: ProviderCapabilities,
  window: ModelWindow | null,
  configured: boolean,
): ProviderCapabilities {
  if (!window) return base;
  return {
    ...base,
    maxContextTokens: configured
      ? Math.min(base.maxContextTokens, window.contextTokens)
      : window.contextTokens,
    maxOutputTokens:
      window.maxOutputTokens !== null
        ? Math.min(base.maxOutputTokens, window.maxOutputTokens)
        : base.maxOutputTokens,
  };
}

/** Whether `config` names a window for `model` (the model's own, or the provider's). */
function windowConfigured(config: ProviderConfig, model: string): boolean {
  const listed = config.models.find((m) => m.id === model);
  return listed?.maxContextTokens !== undefined || config.maxContextTokens !== undefined;
}

/**
 * `registry` with each OpenRouter provider (`configs`, by id) able to
 * resolve a model's real limits (`LlmProvider.resolveCapabilities`, which
 * ChatService budgets with), looked up once per model (`lookup`, default
 * `modelWindow`). Other providers pass through: their model ids aren't
 * OpenRouter's.
 */
export function withModelWindows(
  registry: ProviderRegistry,
  configs: readonly ProviderConfig[],
  env: AppEnv,
  lookup: (model: string) => Promise<ModelWindow | null> = (model) => modelWindow(env, model),
): ProviderRegistry {
  const openRouter = new Map(
    configs
      .filter((c) => c.kind === 'openai-compatible' && isOpenRouter(c.baseUrl))
      .map((c) => [c.id, c]),
  );
  if (openRouter.size === 0) return registry;
  const looked = new Map<string, Promise<ModelWindow | null>>();
  const windowOf = (model: string) => {
    let found = looked.get(model);
    if (!found) {
      found = lookup(model);
      looked.set(model, found);
    }
    return found;
  };
  const wrapped = new Map<string, LlmProvider>();
  return {
    get(providerId) {
      const provider = registry.get(providerId);
      const config = openRouter.get(providerId);
      if (!provider || !config) return provider;
      let windowed = wrapped.get(providerId);
      if (!windowed) {
        const inner = provider;
        windowed = decorateProvider(inner, {
          resolveCapabilities: async (model) =>
            withWindow(
              inner.capabilities(model),
              await windowOf(model),
              windowConfigured(config, model),
            ),
        });
        wrapped.set(providerId, windowed);
      }
      return windowed;
    },
    list: () => registry.list(),
    defaultProviderId: () => registry.defaultProviderId(),
  };
}
