// Migrations 0020 (`branch_funding`) and 0021 (`retire_fake_provider`) run on a
// database that was really at the schema before them: MIGRATION_DB starts empty
// (vitest.config.ts), gets migrations 0000–0019 only, is seeded with rows in that
// schema (no `branches.funding` yet), then gets the rest. The other migration
// tests (funding-matrix, fake-provider-retired) replay one migration's UPDATEs on
// rows seeded into the fully migrated DB; this one applies them as wrangler does
// in production, ALTER TABLE included, and checks the rules in docs/DECISIONS.md
// ("Funding apart from the provider", "Fake reply removed") on every kind of row.
import { KeyRequiredError } from '@tangent/core';
import { type StreamEvent } from '@tangent/shared';
import { applyD1Migrations, type D1Migration } from 'cloudflare:test';
import { env as rawEnv } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { assertGenerationAllowed } from '../src/byok/guard.js';
import { createD1Repositories } from '../src/db/d1-repositories.js';
import type { AccountContext, AppEnv } from '../src/env.js';
import { chatService, routeRegistryFor } from '../src/services.js';
import { DEFAULT_SIMPLE_NORMAL_MODEL } from '../src/simple-mode.js';

const env = rawEnv as unknown as AppEnv & {
  TEST_MIGRATIONS: D1Migration[];
  MIGRATION_DB: D1Database;
};
const db = env.MIGRATION_DB;
/** The app on the upgraded database (generations here run through ChatService, not the DO). */
const upgraded = { ...env, DB: db } as AppEnv;

const ALL = env.TEST_MIGRATIONS;
const BEFORE = ALL.filter((m) => m.name < '0020_');
const AT = '2026-09-01T12:00:00.000Z';

const USER = 'ada';
const POWER = `p_${USER}`;
const LEARN = `u_${USER}`;
/** A tree whose account row is missing (an account deleted by hand, or never created). */
const ORPHAN = 'p_gone';

const powerAccount: AccountContext = {
  id: POWER,
  mode: 'power',
  userId: USER,
  billingAccountId: LEARN,
  builtIn: true,
  operatorKeys: false,
  funding: 'personal',
};
const learnOwnKey: AccountContext = {
  id: LEARN,
  mode: 'simple',
  userId: USER,
  billingAccountId: LEARN,
  builtIn: false,
  operatorKeys: false,
  funding: 'personal',
};

interface SeedBranch {
  id: string;
  tree: string;
  parent: string | null;
  point: string | null;
  provider: string;
  model: string;
  context?: 'path' | 'summary' | 'independent';
}
interface SeedNode {
  id: string;
  tree: string;
  branch: string;
  parent: string | null;
  seq: number;
  role: 'user' | 'assistant';
  content: string;
  provider?: string;
  model?: string;
}

const trees = [
  { id: 't_power', account: POWER, title: 'Power on everything', trunk: 'b_power_trunk' },
  { id: 't_learn', account: LEARN, title: 'A Learn lesson', trunk: 'b_learn_trunk' },
  { id: 't_orphan', account: ORPHAN, title: 'Nobody owns me', trunk: 'b_orphan_trunk' },
  // The dev bypass's account, seeded `power` by migration 0001.
  { id: 't_default', account: 'default', title: 'Dev bypass', trunk: 'b_default_trunk' },
];

const branches: SeedBranch[] = [
  // Power: Tangent credit (`tangent`), the user's own keys, and the retired fake.
  {
    id: 'b_power_trunk',
    tree: 't_power',
    parent: null,
    point: null,
    provider: 'tangent',
    model: 'smart',
  },
  {
    id: 'b_power_ant',
    tree: 't_power',
    parent: 'b_power_trunk',
    point: 'n_power_2',
    provider: 'anthropic',
    model: 'claude-opus-5-5',
    context: 'summary',
  },
  {
    id: 'b_power_or',
    tree: 't_power',
    parent: 'b_power_trunk',
    point: 'n_power_2',
    provider: 'openrouter',
    model: 'deepseek/deepseek-v4-flash',
    context: 'independent',
  },
  {
    id: 'b_power_fake',
    tree: 't_power',
    parent: 'b_power_trunk',
    point: 'n_power_2',
    provider: 'fake',
    model: 'fake-1',
  },
  // Learn: `tangent` was paid per request; a Learn branch on the fake (never offered there, but stored data can say anything).
  {
    id: 'b_learn_trunk',
    tree: 't_learn',
    parent: null,
    point: null,
    provider: 'tangent',
    model: 'smart',
  },
  {
    id: 'b_learn_fake',
    tree: 't_learn',
    parent: 'b_learn_trunk',
    point: 'n_learn_2',
    provider: 'fake',
    model: 'fake-1',
  },
  {
    id: 'b_orphan_trunk',
    tree: 't_orphan',
    parent: null,
    point: null,
    provider: 'tangent',
    model: 'simple',
  },
  {
    id: 'b_default_trunk',
    tree: 't_default',
    parent: null,
    point: null,
    provider: 'tangent',
    model: 'smart',
  },
];

const nodes: SeedNode[] = [
  {
    id: 'n_power_1',
    tree: 't_power',
    branch: 'b_power_trunk',
    parent: null,
    seq: 0,
    role: 'user',
    content: 'What is a prime?',
  },
  {
    id: 'n_power_2',
    tree: 't_power',
    branch: 'b_power_trunk',
    parent: 'n_power_1',
    seq: 1,
    role: 'assistant',
    content: 'A number with two divisors.',
    provider: 'tangent',
    model: 'smart',
  },
  {
    id: 'n_ant_1',
    tree: 't_power',
    branch: 'b_power_ant',
    parent: 'n_power_2',
    seq: 0,
    role: 'user',
    content: 'And 1?',
  },
  {
    id: 'n_ant_2',
    tree: 't_power',
    branch: 'b_power_ant',
    parent: 'n_ant_1',
    seq: 1,
    role: 'assistant',
    content: 'Not prime.',
    provider: 'anthropic',
    model: 'claude-opus-5-5',
  },
  {
    id: 'n_fake_1',
    tree: 't_power',
    branch: 'b_power_fake',
    parent: 'n_power_2',
    seq: 0,
    role: 'user',
    content: 'Echo?',
  },
  {
    id: 'n_fake_2',
    tree: 't_power',
    branch: 'b_power_fake',
    parent: 'n_fake_1',
    seq: 1,
    role: 'assistant',
    content: 'Fake reply (fake-1) to 1 message(s)',
    provider: 'fake',
    model: 'fake-1',
  },
  {
    id: 'n_learn_1',
    tree: 't_learn',
    branch: 'b_learn_trunk',
    parent: null,
    seq: 0,
    role: 'user',
    content: 'Why is the sky blue?',
  },
  {
    id: 'n_learn_2',
    tree: 't_learn',
    branch: 'b_learn_trunk',
    parent: 'n_learn_1',
    seq: 1,
    role: 'assistant',
    content: 'Rayleigh scattering.',
    provider: 'tangent',
    model: 'smart',
  },
  {
    id: 'n_orphan_1',
    tree: 't_orphan',
    branch: 'b_orphan_trunk',
    parent: null,
    seq: 0,
    role: 'user',
    content: 'Hello?',
  },
  {
    id: 'n_orphan_2',
    tree: 't_orphan',
    branch: 'b_orphan_trunk',
    parent: 'n_orphan_1',
    seq: 1,
    role: 'assistant',
    content: 'Hi.',
    provider: 'tangent',
    model: 'simple',
  },
];

const summaries = [
  { anchor: 'n_power_2', hash: 'h1', model: 'smart', provider: 'tangent', tree: 't_power' },
  { anchor: 'n_fake_2', hash: 'h2', model: 'fake-1', provider: 'fake', tree: 't_power' },
  {
    anchor: 'n_ant_2',
    hash: 'h3',
    model: 'claude-opus-5-5',
    provider: 'anthropic',
    tree: 't_power',
  },
];

const usageRows = [
  {
    id: 'ue_learn',
    account: LEARN,
    tree: 't_learn',
    node: 'n_learn_2',
    provider: 'tangent',
    model: 'smart',
    tier: null,
  },
  {
    id: 'ue_power',
    account: LEARN,
    tree: 't_power',
    node: 'n_power_2',
    provider: 'tangent',
    model: 'smart',
    tier: null,
  },
  {
    id: 'ue_pool',
    account: 'pool',
    tree: 't_learn',
    node: 'n_learn_2',
    provider: 'tangent',
    model: 'simple',
    tier: 'member',
  },
];

/** Rows in the 0019 schema: `branches` has no `funding` column yet. */
async function seedOldSchema(): Promise<void> {
  const stmts: D1PreparedStatement[] = [
    db
      .prepare(
        "INSERT INTO accounts (id, name, created_at, user_id, mode) VALUES (?, 'Power', ?, ?, 'power'), (?, 'Learn', ?, ?, 'simple')",
      )
      .bind(POWER, AT, USER, LEARN, AT, USER),
    db
      .prepare(
        'INSERT INTO auth_users (id, name, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)',
      )
      .bind(USER, 'Ada', 'ada@example.org', Date.parse(AT), Date.parse(AT)),
  ];
  for (const t of trees)
    stmts.push(
      db
        .prepare(
          'INSERT INTO trees (id, title, system_prompt, trunk_branch_id, account_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        )
        .bind(t.id, t.title, 'Be terse.', t.trunk, t.account, AT, AT),
    );
  for (const b of branches)
    stmts.push(
      db
        .prepare(
          "INSERT INTO branches (id, tree_id, parent_branch_id, branch_point_node_id, context_mode, anchor_quote, title, title_source, is_private, provider_id, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?, NULL, ?, 'default', 0, ?, ?, ?, ?)",
        )
        .bind(
          b.id,
          b.tree,
          b.parent,
          b.point,
          b.context ?? 'path',
          b.id,
          b.provider,
          b.model,
          AT,
          AT,
        ),
    );
  for (const n of nodes)
    stmts.push(
      db
        .prepare(
          "INSERT INTO nodes (id, tree_id, branch_id, parent_id, seq, role, content, status, error, provider_id, model, input_tokens, output_tokens, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'complete', NULL, ?, ?, NULL, NULL, ?)",
        )
        .bind(
          n.id,
          n.tree,
          n.branch,
          n.parent,
          n.seq,
          n.role,
          n.content,
          n.provider ?? null,
          n.model ?? null,
          AT,
        ),
    );
  for (const s of summaries)
    stmts.push(
      db
        .prepare(
          'INSERT INTO summaries (anchor_node_id, source_hash, model, provider_id, tree_id, content, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        )
        .bind(s.anchor, s.hash, s.model, s.provider, s.tree, `Summary by ${s.provider}`, AT),
    );
  stmts.push(
    db
      .prepare(
        "INSERT INTO shares (id, token, tree_id, scope, target_node_id, include_ancestors, mode, title, expires_at, revoked_at, created_at, updated_at, published_at, version, view_count, account_id) VALUES ('sh_power', 'tok_power', 't_power', 'tree', NULL, 0, 'snapshot', 'Primes', NULL, NULL, ?, ?, ?, 3, 7, ?)",
      )
      .bind(AT, AT, AT, POWER),
    db.prepare("INSERT INTO share_snapshots (share_id, chunk, data) VALUES ('sh_power', 0, '{}')"),
  );
  for (const u of usageRows)
    stmts.push(
      db
        .prepare(
          "INSERT INTO usage_events (id, account_id, tree_id, node_id, purpose, provider_id, model, generation_id, status, hold_micros, markup_bps, cost_nanos, charge_micros, input_tokens, output_tokens, created_at, settled_at, fee_bps, user_id, funding, tier) VALUES (?, ?, ?, ?, 'reply', ?, ?, NULL, 'settled', 20000, 1000, 1234000, 1500, 10, 20, ?, ?, 550, ?, ?, ?)",
        )
        .bind(
          u.id,
          u.account,
          u.tree,
          u.node,
          u.provider,
          u.model,
          AT,
          AT,
          USER,
          u.tier ? 'pool' : 'personal',
          u.tier,
        ),
    );
  await db.batch(stmts);
}

const rows = <T>(sql: string) =>
  db
    .prepare(sql)
    .all<T>()
    .then((r) => r.results);
const applied = () =>
  rows<{ name: string }>('SELECT name FROM d1_migrations ORDER BY id').then((r) =>
    r.map((m) => m.name),
  );

/** Every table, index and trigger, as SQLite stores its definition. */
async function schemaOf(d: D1Database) {
  const { results } = await d
    .prepare(
      "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY type, name",
    )
    .all<{ type: string; name: string; tbl_name: string; sql: string | null }>();
  return results;
}

async function collect(events: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}

describe('migrations 0020 and 0021 on a database at the 0019 schema', () => {
  beforeAll(async () => {
    // The migration list is ordered by name; 0020/0021 come right after 0019 (later
    // migrations, e.g. 0022_grounding, are applied with them, as in production).
    const after = ALL.map((m) => m.name).filter((n) => n >= '0020_');
    expect(after.slice(0, 2)).toEqual(['0020_branch_funding.sql', '0021_retire_fake_provider.sql']);
    expect(BEFORE).toHaveLength(ALL.length - after.length);
    await applyD1Migrations(db, BEFORE);
    // Really the old schema: no funding column.
    const columns = await rows<{ name: string }>("SELECT name FROM pragma_table_info('branches')");
    expect(columns.map((c) => c.name)).not.toContain('funding');
    await seedOldSchema();
    // As `wrangler d1 migrations apply`: only what d1_migrations doesn't list yet.
    await applyD1Migrations(db, ALL);
  });

  it('applies both, in order, recorded so they never run twice', async () => {
    const names = await applied();
    expect(names).toEqual(ALL.map((m) => m.name));
    const after = names.filter((n) => n >= '0020_');
    expect(after.slice(0, 2)).toEqual(['0020_branch_funding.sql', '0021_retire_fake_provider.sql']);

    // Applying the whole list again runs nothing (and so changes nothing).
    const before = await rows('SELECT id, provider_id, model, funding FROM branches ORDER BY id');
    await applyD1Migrations(db, ALL);
    expect(await applied()).toEqual(names);
    expect(await rows('SELECT id, provider_id, model, funding FROM branches ORDER BY id')).toEqual(
      before,
    );
    // That bookkeeping is what makes a re-run safe: 0020's ALTER TABLE isn't idempotent.
    const addColumn = ALL.find((m) => m.name.startsWith('0020_'))!.queries[0]!;
    await expect(db.prepare(addColumn).run()).rejects.toThrow(/duplicate column/);
  });

  it('leaves the same schema as a database migrated from scratch', async () => {
    expect(await schemaOf(db)).toEqual(await schemaOf(env.DB));
  });

  it('branches: power `tangent` is credit, every other row own-key; `fake` moves to OpenRouter', async () => {
    const got = await rows<{ id: string; provider_id: string; model: string; funding: string }>(
      'SELECT id, provider_id, model, funding FROM branches ORDER BY id',
    );
    expect(Object.fromEntries(got.map((b) => [b.id, [b.provider_id, b.model, b.funding]]))).toEqual(
      {
        // A power branch on `tangent` was on Tangent credit by definition.
        b_power_trunk: ['openrouter', 'smart', 'credit'],
        b_default_trunk: ['openrouter', 'smart', 'credit'],
        // Own keys stay as they were.
        b_power_ant: ['anthropic', 'claude-opus-5-5', 'own-key'],
        b_power_or: ['openrouter', 'deepseek/deepseek-v4-flash', 'own-key'],
        // Learn paid per request: the row doesn't say who paid, so the safe own-key.
        b_learn_trunk: ['openrouter', 'smart', 'own-key'],
        // No account row: unreachable, the same safe value.
        b_orphan_trunk: ['openrouter', 'simple', 'own-key'],
        // The retired fake: OpenRouter's default model on the user's own key, never credit. 0021
        // set the Normal model of its day, V4 Pro; 0025 moves Learn's on to today's Normal.
        b_power_fake: ['openrouter', 'deepseek/deepseek-v4-pro', 'own-key'],
        b_learn_fake: ['openrouter', DEFAULT_SIMPLE_NORMAL_MODEL, 'own-key'],
      },
    );
    // Nothing else about a branch changes.
    const shapes = await rows<{
      id: string;
      context_mode: string;
      parent_branch_id: string | null;
    }>('SELECT id, context_mode, parent_branch_id FROM branches ORDER BY id');
    for (const b of branches)
      expect(shapes.find((s) => s.id === b.id)).toEqual({
        id: b.id,
        context_mode: b.context ?? 'path',
        parent_branch_id: b.parent,
      });
  });

  it('replies and summaries: `tangent` is renamed; `fake` and everything else is history, kept', async () => {
    const got = await rows<{
      id: string;
      provider_id: string | null;
      model: string | null;
      content: string;
    }>('SELECT id, provider_id, model, content FROM nodes ORDER BY id');
    const expected: Record<string, string | null> = {
      n_power_2: 'openrouter',
      n_learn_2: 'openrouter',
      n_orphan_2: 'openrouter',
      n_ant_2: 'anthropic',
      n_fake_2: 'fake',
    };
    for (const n of nodes) {
      const row = got.find((g) => g.id === n.id)!;
      expect(row.provider_id, n.id).toBe(expected[n.id] ?? null);
      expect(row.model, n.id).toBe(n.model ?? null);
      expect(row.content, n.id).toBe(n.content);
    }
    expect(
      await rows('SELECT anchor_node_id, provider_id, model FROM summaries ORDER BY source_hash'),
    ).toEqual([
      { anchor_node_id: 'n_power_2', provider_id: 'openrouter', model: 'smart' },
      { anchor_node_id: 'n_fake_2', provider_id: 'fake', model: 'fake-1' },
      { anchor_node_id: 'n_ant_2', provider_id: 'anthropic', model: 'claude-opus-5-5' },
    ]);
  });

  it('billing history, shares, accounts and trees are untouched', async () => {
    expect(
      await rows(
        'SELECT id, provider_id, model, funding, tier, charge_micros FROM usage_events ORDER BY id',
      ),
    ).toEqual([
      {
        id: 'ue_learn',
        provider_id: 'tangent',
        model: 'smart',
        funding: 'personal',
        tier: null,
        charge_micros: 1500,
      },
      {
        id: 'ue_pool',
        provider_id: 'tangent',
        model: 'simple',
        funding: 'pool',
        tier: 'member',
        charge_micros: 1500,
      },
      {
        id: 'ue_power',
        provider_id: 'tangent',
        model: 'smart',
        funding: 'personal',
        tier: null,
        charge_micros: 1500,
      },
    ]);
    expect(
      await rows(
        'SELECT id, token, tree_id, scope, mode, version, view_count, account_id FROM shares',
      ),
    ).toEqual([
      {
        id: 'sh_power',
        token: 'tok_power',
        tree_id: 't_power',
        scope: 'tree',
        mode: 'snapshot',
        version: 3,
        view_count: 7,
        account_id: POWER,
      },
    ]);
    expect(await rows('SELECT share_id, data FROM share_snapshots')).toEqual([
      { share_id: 'sh_power', data: '{}' },
    ]);
    expect(await rows('SELECT id, mode, user_id FROM accounts ORDER BY id')).toEqual([
      { id: 'default', mode: 'power', user_id: null },
      { id: POWER, mode: 'power', user_id: USER },
      { id: LEARN, mode: 'simple', user_id: USER },
    ]);
    expect(
      await rows('SELECT id, account_id, system_prompt, updated_at FROM trees ORDER BY id'),
    ).toEqual(
      trees
        .map((t) => ({
          id: t.id,
          account_id: t.account,
          system_prompt: 'Be terse.',
          updated_at: AT,
        }))
        .sort((a, b) => a.id.localeCompare(b.id)),
    );
  });

  it('the code reads the upgraded rows: lists, details, backups', async () => {
    const repos = createD1Repositories(db);
    expect(await repos.trees.getBranch('b_power_trunk')).toMatchObject({
      providerId: 'openrouter',
      funding: 'credit',
      contextMode: 'path',
    });
    const power = chatService(upgraded, powerAccount);
    expect((await power.listTrees()).map((t) => t.id)).toEqual(['t_power']);
    const detail = await power.getTreeDetail('t_power');
    expect(detail.branches.map((b) => [b.id, b.providerId, b.funding]).sort()).toEqual([
      ['b_power_ant', 'anthropic', 'own-key'],
      ['b_power_fake', 'openrouter', 'own-key'],
      ['b_power_or', 'openrouter', 'own-key'],
      ['b_power_trunk', 'openrouter', 'credit'],
    ]);
    expect(detail.nodes).toHaveLength(6);
    const backup = await power.exportBackup('t_power');
    expect(backup.branches.find((b) => b.id === 'b_power_trunk')).toMatchObject({
      providerId: 'openrouter',
      funding: 'credit',
    });
    const learn = chatService(upgraded, learnOwnKey);
    expect((await learn.listTrees()).map((t) => t.id)).toEqual(['t_learn']);
    // The orphan tree belongs to no one who can sign in.
    await expect(
      chatService(upgraded, { ...powerAccount, id: 'p_other' }).getTreeDetail('t_orphan'),
    ).rejects.toThrow();
  });

  it('a power branch that was on `tangent` continues on Tangent credit, metered to the user', async () => {
    const service = chatService(upgraded, powerAccount, { generating: true });
    const begin = await service.beginSend('b_power_trunk', 'And twin primes?');
    expect(begin.assistantNode).toMatchObject({ providerId: 'openrouter', model: 'smart' });
    const events = await collect(service.runGeneration(begin, new AbortController().signal));
    expect(events.at(-1)?.type, JSON.stringify(events.at(-1))).toBe('done');
    const reply = await createD1Repositories(db).trees.getNode(begin.assistantNode.id);
    expect(reply).toMatchObject({ status: 'complete', providerId: 'openrouter' });
    expect(reply!.content.length).toBeGreaterThan(0);
    // The built-in endpoint on the operator's key: a usage row on the user's ledger.
    const usage = await rows<{
      account_id: string;
      provider_id: string;
      funding: string;
      branch_id: string;
    }>(
      `SELECT account_id, provider_id, funding, branch_id FROM usage_events WHERE node_id = '${begin.assistantNode.id}'`,
    );
    expect(usage).toEqual([
      {
        account_id: LEARN,
        provider_id: 'openrouter',
        funding: 'personal',
        branch_id: 'b_power_trunk',
      },
    ]);
  });

  it('a Learn lesson that was on `tangent` continues on the learner’s own key, unmetered', async () => {
    const service = chatService(upgraded, learnOwnKey, {
      generating: true,
      apiKeys: { openrouter: 'sk-or-learner' },
    });
    const begin = await service.beginSend('b_learn_trunk', 'And at sunset?');
    const events = await collect(service.runGeneration(begin, new AbortController().signal));
    expect(events.at(-1)?.type, JSON.stringify(events.at(-1))).toBe('done');
    const usage = await rows(
      `SELECT id FROM usage_events WHERE node_id = '${begin.assistantNode.id}'`,
    );
    expect(usage).toEqual([]);
  });

  it('a branch moved off the fake asks for the OpenRouter key (key_required), then runs on it', () => {
    // The gate a send passes first, on the default power providers (no fake among them).
    const defaults = { ...upgraded, PROVIDERS: '' } as AppEnv;
    const signedIn = { ...powerAccount, builtIn: false };
    expect(() =>
      assertGenerationAllowed(
        routeRegistryFor(defaults, signedIn, 'own-key'),
        'openrouter',
        DEFAULT_SIMPLE_NORMAL_MODEL,
      ),
    ).toThrow(KeyRequiredError);
    expect(() =>
      assertGenerationAllowed(
        routeRegistryFor(defaults, signedIn, 'own-key', { openrouter: 'sk-or-user' }),
        'openrouter',
        DEFAULT_SIMPLE_NORMAL_MODEL,
      ),
    ).not.toThrow();
  });
});
