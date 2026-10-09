// The legal pages (http/legal.tsx): who runs the deployment, what it keeps
// and for how long, and who handles the text of Tangent-paid requests
// (http/hosted-ai.ts), each from the config. The CSP, escaping and copy rules
// every public page shares are in public-pages.test.ts.
import { CANDIDATE_TTL_MS } from '@tangent/shared';
import { env as rawEnv } from 'cloudflare:workers';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_BACKGROUND_MODEL,
  DEFAULT_LEARN_MAX_MODEL,
  DEFAULT_LEARN_NORMAL_MODEL,
} from '../src/config.js';
import type { AppBindings, AppEnv } from '../src/env.js';
import { hostedAi } from '../src/http/hosted-ai.js';
import { legalRoutes } from '../src/http/legal.js';
import { POOL_IDENTITY_RETENTION_DAYS } from '../src/pool/identity.js';
import { BASE } from './http.js';
import { shippedEnv } from './mocks/wrangler-vars.js';

const env = rawEnv as unknown as AppEnv;

/** wrangler.jsonc's deployment, Polar's secrets set, with `overrides`. */
function deployment(overrides: Partial<AppEnv> = {}): AppEnv {
  return shippedEnv(env, {
    POLAR_ACCESS_TOKEN: 'oat',
    POLAR_WEBHOOK_SECRET: 'whsec',
    ...overrides,
  });
}

async function page(path: string, overrides: Partial<AppEnv> = {}): Promise<string> {
  const app = new Hono<AppBindings>().route('/', legalRoutes());
  const res = await app.request(`${BASE}${path}`, {}, deployment(overrides));
  expect(res.status).toBe(200);
  return (await res.text()).replace(/&#39;/g, "'");
}

/** A built-in provider config (BUILT_IN_PROVIDER) on the operator's key. */
function builtIn(baseUrl: string, models: object[], options?: object): string {
  return JSON.stringify({
    id: 'openrouter',
    kind: 'openai-compatible',
    label: 'Tangent',
    baseUrl,
    apiKeySecret: 'BUILT_IN_API_KEY',
    defaultModel: 'a/quick',
    models,
    ...(options ? { options } : {}),
  });
}

describe('the legal pages', () => {
  it('name the operator, contact and governing law from the LEGAL_* vars, or the host', async () => {
    const named = { LEGAL_OPERATOR: 'Ada LLC', LEGAL_CONTACT_EMAIL: 'legal@example.org' };
    const privacy = await page('/privacy', named);
    expect(privacy).toContain('run by Ada LLC');
    expect(privacy).toContain('href="mailto:legal@example.org"');
    expect(await page('/terms', { LEGAL_JURISDICTION: 'the State of New York, USA' })).toContain(
      'the laws of the State of New York, USA',
    );
    const unnamed = await page('/privacy', {
      PUBLIC_BASE_URL: 'https://tangent.example.com',
      LEGAL_OPERATOR: '',
      LEGAL_CONTACT_EMAIL: '',
    });
    expect(unnamed).toContain('the operator of tangent.example.com');
    expect(unnamed).toContain('mailto:privacy@tangent.example.com');
    expect(await page('/terms', { LEGAL_JURISDICTION: '' })).toContain(
      'the laws of the place where the operator is established',
    );
  });

  it('state how long what outlives an account deletion is kept, from the code’s constants', async () => {
    const privacy = await page('/privacy');
    expect(privacy).toContain(`${CANDIDATE_TTL_MS / 60_000} minutes after they are written`);
    expect(privacy).toContain(`kept for ${POOL_IDENTITY_RETENTION_DAYS} days after the deletion`);
  });

  it('say share links are limited while DMCA_AGENT_REGISTERED is off', async () => {
    const limited = /Share links are (not generally available|available only to accounts)/;
    for (const path of ['/privacy', '/terms']) {
      expect(await page(path, { DMCA_AGENT_REGISTERED: 'true' })).not.toMatch(limited);
      expect(await page(path, { DMCA_AGENT_REGISTERED: 'false' })).toMatch(limited);
    }
  });
});

describe('who handles Tangent-paid requests (hostedAi)', () => {
  it('as shipped: Normal, the pool and summaries on their pinned hosts; Max and power on OpenRouter’s choice', async () => {
    const ai = hostedAi(deployment());
    expect(ai).toMatchObject({ openRouter: true, gateway: false, powerCredit: true });
    expect(DEFAULT_BACKGROUND_MODEL).toBe(DEFAULT_LEARN_NORMAL_MODEL);
    expect(ai?.models).toEqual([
      {
        id: DEFAULT_LEARN_NORMAL_MODEL,
        maker: 'DeepSeek',
        uses: ["Learn's Normal tier", 'the open pool', 'summaries and titles of conversations'],
        hosts: ['StreamLake', 'DeepInfra'],
        fallbacks: true,
      },
      {
        id: DEFAULT_LEARN_MAX_MODEL,
        maker: 'Anthropic',
        uses: ["Learn's Max tier"],
        hosts: [],
        fallbacks: true,
      },
    ]);
    // The policy names each model and host.
    const privacy = await page('/privacy');
    for (const m of ai!.models) {
      expect(privacy).toContain(`<code>${m.id}</code>`);
      for (const host of m.hosts) expect(privacy).toContain(host);
    }
    expect(privacy).toContain('Power mode on Tangent credit');
  });

  it('follows a changed pinning or pool model', () => {
    const ai = hostedAi(
      deployment({
        LEARN_NORMAL_PROVIDER_ORDER: 'deepinfra/fp8',
        POOL_PROVIDER_ORDER: '',
        POOL_MODEL: DEFAULT_LEARN_MAX_MODEL,
        // Caps that admit a Max reply's ceiling hold, or the pool is off.
        POOL_SPEND_MICROS_PER_DAY: '5000000',
        POOL_IP_SPEND_MICROS_PER_DAY: '5000000',
      }),
    );
    expect(ai?.models.map((m) => [m.id, m.uses, m.hosts])).toEqual([
      [
        DEFAULT_LEARN_NORMAL_MODEL,
        ["Learn's Normal tier", 'summaries and titles of conversations'],
        ['DeepInfra'],
      ],
      [DEFAULT_LEARN_MAX_MODEL, ["Learn's Max tier", 'the open pool'], []],
    ]);
  });

  it('without payments, only the pool', async () => {
    const noPayments = { POLAR_ACCESS_TOKEN: '', POLAR_WEBHOOK_SECRET: '' };
    const ai = hostedAi(deployment(noPayments));
    expect(ai?.powerCredit).toBe(false);
    expect(ai?.models.map((m) => [m.id, m.uses])).toEqual([
      [DEFAULT_BACKGROUND_MODEL, ['the open pool']],
    ]);
    expect(await page('/privacy', noPayments)).not.toContain('Power mode on Tangent credit');
  });

  it('pinned hosts without fallbacks, when the operator turns them off', () => {
    const ai = hostedAi(
      deployment({
        BUILT_IN_PROVIDER: builtIn(
          'https://openrouter.ai/api/v1',
          [{ id: 'a/quick', label: 'Quick', tier: 'normal', providerOrder: ['some-host/fp8'] }],
          { extraBody: { provider: { allow_fallbacks: false } } },
        ),
        POOL_MODEL: 'a/quick',
      }),
    );
    expect(ai?.models[0]).toMatchObject({ id: 'a/quick', hosts: ['some-host'], fallbacks: false });
  });

  it('names an endpoint other than OpenRouter by its host, with no hosting claims', async () => {
    const other = {
      BUILT_IN_PROVIDER: builtIn('https://api.openai.com/v1', [
        { id: 'a/quick', label: 'Normal', tier: 'normal' },
      ]),
      POOL_MODEL: 'a/quick',
    };
    expect(hostedAi(deployment(other))).toMatchObject({
      openRouter: false,
      endpoint: 'api.openai.com',
    });
    const privacy = await page('/privacy', other);
    expect(privacy).toContain('api.openai.com, which runs the models');
    expect(privacy).not.toMatch(/OpenRouter \(USA\)|on a host OpenRouter chooses/);
  });
});
