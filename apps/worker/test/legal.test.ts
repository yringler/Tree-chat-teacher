// The legal pages (http/legal.tsx): who runs the deployment, what it keeps
// and for how long, and who handles the text of Tangent-paid requests
// (http/hosted-ai.ts), each from the config. The CSP, escaping and copy rules
// every public page shares are in public-pages.test.ts.
import { CANDIDATE_TTL_MS } from '@tangent/shared';
import { env as rawEnv } from 'cloudflare:workers';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { DEFAULT_BACKGROUND_MODEL, DEFAULT_LEARN_NORMAL_MODEL } from '../src/config.js';
import type { AppBindings, AppEnv } from '../src/env.js';
import { hostedAi } from '../src/http/hosted-ai.js';
import { legalRoutes } from '../src/http/legal.js';
import { POOL_IDENTITY_RETENTION_DAYS } from '../src/pool/identity.js';
import { STRIKES_TO_SUSPEND } from '../src/share/review.js';
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

  it('say share links are limited unless SHARING is everyone', async () => {
    const limited = /Share links are (not generally available|available only to accounts)/;
    for (const path of ['/privacy', '/terms']) {
      expect(await page(path, { SHARING: 'everyone' })).not.toMatch(limited);
      expect(await page(path, { SHARING: 'allowlist' })).toMatch(limited);
      expect(await page(path, { SHARING: 'off' })).toMatch(limited);
      // `everyone` without the classifier is `allowlist`.
      expect(await page(path, { SHARING: 'everyone', MODERATION_API_KEY: '' })).toMatch(limited);
    }
  });

  it('disclose what Google sign-in receives, its use, sharing, protection and deletion, and Limited Use', async () => {
    const privacy = await page('/privacy');
    const section = privacy.slice(
      privacy.indexOf('<h2 id="google-user-data">'),
      privacy.indexOf('<h2>Share links</h2>'),
    );
    expect(section).toMatch(
      /<code>openid<\/code>, <code>email<\/code> and\s+<code>profile<\/code>/,
    );
    for (const heading of [
      'What we receive:',
      'How we use it:',
      'Who we share it with:',
      'How we protect it:',
      'How long we keep it:',
    ])
      expect(section).toContain(`<strong>${heading}</strong>`);
    expect(section).toMatch(
      /don't use it to develop, improve or train AI\s+or machine-learning models/,
    );
    expect(section).toMatch(/We discard the\s+access, refresh and ID tokens Google issues/);
    expect(section).toContain(`(for ${POOL_IDENTITY_RETENTION_DAYS} days)`);
    expect(section).toContain('href="https://myaccount.google.com/connections"');
    expect(section).toContain(
      'href="https://developers.google.com/terms/api-services-user-data-policy"',
    );
    expect(section).toContain('including the Limited Use requirements');
    expect(privacy).toContain('<a href="#google-user-data">Google user data</a>');
  });

  it('name the moderation provider as a recipient of shared text only while it screens', async () => {
    const recipient = /<strong>OpenAI<\/strong> \(USA\): screens share links/;
    const screened = await page('/privacy', { MODERATION_API_KEY: 'mod-key' });
    expect(screened).toMatch(recipient);
    expect(screened).toContain('its text is screened automatically');
    const unscreened = await page('/privacy', { MODERATION_API_KEY: '' });
    expect(unscreened).not.toMatch(recipient);
    expect(unscreened).not.toContain('screened automatically');
  });
});

describe('the terms on share links', () => {
  it('grant a license to host what is shared, and say shares can be reported and taken down', async () => {
    const terms = await page('/terms');
    expect(terms).toMatch(/license to host, copy and display that conversation/);
    expect(terms).toMatch(/Anyone who opens a shared conversation can report it/);
    expect(terms).toMatch(/AI-generated/);
  });

  it('mention the classifier only while it screens', async () => {
    const classifier = /automated classifier screens its text/;
    expect(await page('/terms', { MODERATION_API_KEY: 'mod-key' })).toMatch(classifier);
    expect(await page('/terms', { MODERATION_API_KEY: '' })).not.toMatch(classifier);
  });

  it('forbid doxxing, planning violence and getting around screening or the share limits', async () => {
    const terms = await page('/terms');
    expect(terms).toContain('(doxxing)');
    expect(terms).toMatch(/plan or prepare violence/);
    expect(terms).toMatch(/get around[^<]*the screening of share links or the limits on\s+them/);
  });

  it('state the repeat-infringer rule the strikes enforce', async () => {
    expect(await page('/terms')).toMatch(
      new RegExp(
        `removed\\s+${STRIKES_TO_SUSPEND} of your share links after reports, sharing is turned off`,
      ),
    );
  });

  it('allow acting without saying why where an investigation requires it', async () => {
    expect(await page('/terms')).toMatch(/telling you could harm an investigation/);
  });
});

describe('who handles Tangent-paid requests (hostedAi)', () => {
  it('as shipped: Normal, the pool and summaries on their pinned hosts; power on OpenRouter’s choice', async () => {
    const ai = hostedAi(deployment());
    expect(ai).toMatchObject({ openRouter: true, gateway: false, powerCredit: true });
    expect(DEFAULT_BACKGROUND_MODEL).toBe(DEFAULT_LEARN_NORMAL_MODEL);
    expect(ai?.models).toEqual([
      {
        id: DEFAULT_LEARN_NORMAL_MODEL,
        maker: 'Anthropic',
        // The pool runs Normal.
        uses: ["Learn's Normal model", 'the open pool', 'summaries and titles of conversations'],
        hosts: ['Anthropic'],
        fallbacks: true,
        direct: false,
      },
    ]);
    expect(ai?.anthropic).toBe(false);
    // The policy names each model and host.
    const privacy = await page('/privacy');
    for (const m of ai!.models) {
      expect(privacy).toContain(`<code>${m.id}</code>`);
      for (const host of m.hosts) expect(privacy).toContain(host);
    }
    expect(privacy).toContain('Power mode on Tangent credit');
  });

  it('names Anthropic as a direct processor of the Claude models it serves, when it is a backend', async () => {
    const anthropic = {
      BUILT_IN_BACKENDS: 'anthropic,openrouter',
      BUILT_IN_ANTHROPIC_API_KEY: 'sk-ant-operator',
    };
    const ai = hostedAi(deployment(anthropic));
    expect(ai?.anthropic).toBe(true);
    expect(ai?.models.map((m) => [m.id, m.direct, m.hosts])).toEqual([
      [DEFAULT_LEARN_NORMAL_MODEL, true, []],
    ]);
    const privacy = await page('/privacy', anthropic);
    expect(privacy).toContain('Some Claude models go to Anthropic (USA) directly instead');
    expect(privacy).toContain(
      `<code>${DEFAULT_LEARN_NORMAL_MODEL}</code> (made by Anthropic), sent to Anthropic directly`,
    );
    expect(privacy).toContain('or at Anthropic directly for the Claude models Tangent sends there');
    // Without its key, Anthropic is no backend, and the policy doesn't name it.
    const keyless = { ...anthropic, BUILT_IN_ANTHROPIC_API_KEY: '' };
    expect(hostedAi(deployment(keyless))?.anthropic).toBe(false);
    expect(await page('/privacy', keyless)).not.toContain('Anthropic (USA) directly');
  });

  it("follows a changed pinning, the pool's too", () => {
    const ai = hostedAi(deployment({ LEARN_NORMAL_PROVIDER_ORDER: 'amazon-bedrock' }));
    expect(ai?.models.map((m) => [m.id, m.uses, m.hosts])).toEqual([
      [
        DEFAULT_LEARN_NORMAL_MODEL,
        ["Learn's Normal model", 'the open pool', 'summaries and titles of conversations'],
        ['Amazon Bedrock'],
      ],
    ]);
  });

  it('without payments, only the pool', async () => {
    const noPayments = { POLAR_ACCESS_TOKEN: '', POLAR_WEBHOOK_SECRET: '' };
    const ai = hostedAi(deployment(noPayments));
    expect(ai?.powerCredit).toBe(false);
    expect(ai?.models.map((m) => [m.id, m.uses])).toEqual([
      [DEFAULT_LEARN_NORMAL_MODEL, ['the open pool']],
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
      }),
    );
    expect(ai?.models[0]).toMatchObject({ id: 'a/quick', hosts: ['some-host'], fallbacks: false });
  });

  it('names an endpoint other than OpenRouter by its host, with no hosting claims', async () => {
    const other = {
      BUILT_IN_PROVIDER: builtIn('https://api.openai.com/v1', [
        { id: 'a/quick', label: 'Normal', tier: 'normal' },
      ]),
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
