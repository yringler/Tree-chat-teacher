import { isOpenRouterBaseUrl } from '@tangent/providers';
import type { ProviderConfig } from '@tangent/shared';
import type { AppEnv } from '../env.js';
import { poolModel, poolRequest } from '../pool/params.js';
import { builtInAvailable, poolAvailable } from '../availability.js';
import { simpleFastModel, simpleProviderConfig } from '../simple-mode.js';

/**
 * Who handles the text of a request paid by Tangent (credit or the open
 * pool), as the privacy policy names them: worked out from the deployment's
 * config (the built-in provider, its tier models and pinned hosts, the pool
 * model), so the policy stays true when the operator changes a model or a
 * host. Nothing here is a claim about how a host treats the data.
 */
export interface HostedAi {
  /** The built-in endpoint is OpenRouter (directly or through Cloudflare's AI Gateway). */
  openRouter: boolean;
  /** Reached through Cloudflare's AI Gateway. */
  gateway: boolean;
  /** Who runs the endpoint when it isn't OpenRouter: a company name or a host name. */
  endpoint: string;
  /** Each model Tangent pays for, with what uses it and where OpenRouter sends it. */
  models: HostedModel[];
  /** Power mode offers Tangent credit, on any model the user picks. */
  powerCredit: boolean;
}

export interface HostedModel {
  /** The model id, e.g. `deepseek/deepseek-v4.1-flash`. */
  id: string;
  /** Who made it (from the id's vendor prefix), or null when the id has none. */
  maker: string | null;
  /** What uses it, e.g. "Learn's Normal tier", in the order they are listed. */
  uses: string[];
  /** The hosts it is pinned to, first choice first (OpenRouter's `provider.order`); empty = OpenRouter picks. */
  hosts: string[];
  /** OpenRouter may send it to another host when the pinned ones can't take it (`allow_fallbacks`). */
  fallbacks: boolean;
}

/**
 * Display names of OpenRouter's vendor and provider slugs (`deepseek/…`,
 * `streamlake/fp8`). A slug not listed is shown as it is.
 */
const COMPANY_NAMES: Readonly<Record<string, string>> = {
  anthropic: 'Anthropic',
  'amazon-bedrock': 'Amazon Bedrock',
  azure: 'Microsoft Azure',
  baseten: 'Baseten',
  deepinfra: 'DeepInfra',
  deepseek: 'DeepSeek',
  fireworks: 'Fireworks',
  google: 'Google',
  'google-vertex': 'Google Vertex AI',
  groq: 'Groq',
  'meta-llama': 'Meta',
  minimax: 'MiniMax',
  mistralai: 'Mistral AI',
  moonshotai: 'Moonshot AI',
  novita: 'Novita AI',
  openai: 'OpenAI',
  qwen: 'Qwen (Alibaba)',
  streamlake: 'StreamLake',
  together: 'Together AI',
  'x-ai': 'xAI',
  'z-ai': 'Z.ai',
};

/** The company behind an OpenRouter slug: `streamlake/fp8` → StreamLake. */
export function companyName(slug: string): string {
  const base = slug.split('/')[0]!.trim().toLowerCase();
  return COMPANY_NAMES[base] ?? base;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** The host name of `url`, or null when it isn't one. */
function hostOf(url: string | undefined): string | null {
  try {
    return new URL(url ?? '').hostname;
  } catch {
    return null;
  }
}

/** Who runs a non-OpenRouter endpoint, for the policy. */
function endpointName(config: ProviderConfig): string {
  if (config.kind === 'anthropic') return 'Anthropic';
  return hostOf(config.baseUrl ?? 'https://api.openai.com/v1') ?? config.label;
}

/**
 * What the privacy policy says about the models Tangent pays for, from
 * `env`; null when the built-in provider's config can't be read (the policy
 * then names no model).
 */
export function hostedAi(env: AppEnv): HostedAi | null {
  let config: ProviderConfig;
  try {
    config = simpleProviderConfig(env);
  } catch {
    return null;
  }
  const openRouter = config.kind === 'openai-compatible' && isOpenRouterBaseUrl(config.baseUrl);
  const routing = asRecord(asRecord(config.options?.['extraBody'])['provider']);
  // The operator's explicit `allow_fallbacks` wins over the pinning's default (openai-compatible.ts).
  const fallbacks = routing['allow_fallbacks'] !== false;
  const models: HostedModel[] = [];
  const add = (id: string, use: string, hosts: readonly string[]) => {
    const pinned = openRouter ? hosts.map(companyName) : [];
    const same = models.find((m) => m.id === id && m.hosts.join() === pinned.join());
    if (same) {
      if (!same.uses.includes(use)) same.uses.push(use);
      return;
    }
    const vendor = id.includes('/') ? id.split('/')[0]! : null;
    models.push({
      id,
      maker: vendor ? companyName(vendor) : null,
      uses: [use],
      hosts: pinned,
      fallbacks,
    });
  };

  const credit = builtInAvailable(env);
  const pool = poolAvailable(env);
  if (credit) {
    for (const m of config.models) {
      add(
        m.id,
        m.tier ? `Learn's ${m.label} tier` : `Learn's ${m.label} model`,
        m.providerOrder ?? [],
      );
    }
  }
  if (pool) {
    const id = poolModel(env);
    add(id, 'the open pool', poolRequest(env, id).providerOrder);
  }
  if (credit) {
    // Summaries and titles run on the background model's listing in Learn's config (if any).
    const fast = simpleFastModel(env, config);
    add(
      fast,
      'summaries and titles of conversations',
      config.models.find((m) => m.id === fast)?.providerOrder ?? [],
    );
  }
  const gateway = openRouter && hostOf(config.baseUrl) === 'gateway.ai.cloudflare.com';
  return {
    openRouter,
    gateway,
    endpoint: openRouter ? 'OpenRouter' : endpointName(config),
    models,
    powerCredit: credit,
  };
}
