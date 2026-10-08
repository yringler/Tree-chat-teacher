import { isModelAllowed } from '@tangent/shared';
import { env as rawEnv } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { createD1Repositories } from '../src/db/d1-repositories.js';
import type { AccountContext, AppEnv } from '../src/env.js';
import { providerConfigs, registryFor } from '../src/services.js';
import { DEFAULT_SIMPLE_NORMAL_MODEL } from '../src/simple-mode.js';

/*
 * The offline fake provider is no longer one of power's defaults
 * (docs/DECISIONS.md "Fake reply removed"); migration 0021 moves branches that
 * ran on it. The `fake` kind itself stays a test seam (vitest.config.ts).
 */

const env = rawEnv as unknown as AppEnv;
const defaults = { ...env, PROVIDERS: '' } as AppEnv;
/** A signed-in power user (bring-your-own-key) on a server with the default providers. */
const powerUser: AccountContext = {
  id: 'p_retired',
  mode: 'power',
  userId: 'retired',
  billingAccountId: 'u_retired',
  builtIn: false,
  operatorKeys: false,
  funding: 'personal',
};

describe('the offline fake provider is retired', () => {
  it('is not among the default power providers', () => {
    const configs = providerConfigs(defaults);
    expect(configs.map((c) => c.id)).toEqual(['anthropic', 'openai', 'openrouter']);
    expect(configs.some((c) => c.kind === 'fake')).toBe(false);
    const listed = registryFor(defaults, powerUser).list();
    expect(listed.map((p) => p.id)).not.toContain('fake');
  });

  it('migration 0021 moves branches on `fake` to OpenRouter on the own key, and keeps replies', async () => {
    const migrations = (
      env as unknown as { TEST_MIGRATIONS: { name: string; queries: string[] }[] }
    ).TEST_MIGRATIONS;
    const migration = migrations.find((m) => m.name.startsWith('0021_'))!;
    expect(migration).toBeDefined();

    const db = env.DB;
    const at = new Date().toISOString();
    const id = (p: string) => `${p}_${Math.random().toString(36).slice(2, 10)}`;
    const account = id('p_fake');
    await db
      .prepare(
        "INSERT INTO accounts (id, name, created_at, user_id, mode) VALUES (?, 'P', ?, ?, 'power')",
      )
      .bind(account, at, id('usr'))
      .run();
    const rows = [
      { provider: 'fake', model: 'fake-1', funding: 'own-key' },
      // Whatever a row says, the fake never spent credit: the moved branch doesn't either.
      { provider: 'fake', model: 'fake-1', funding: 'credit' },
      { provider: 'anthropic', model: 'claude-opus-5-5', funding: 'own-key' },
    ];
    const ids: { branch: string; node: string }[] = [];
    for (const r of rows) {
      const tree = id('t');
      const branch = id('b');
      const node = id('n');
      ids.push({ branch, node });
      await db.batch([
        db
          .prepare(
            'INSERT INTO trees (id, title, system_prompt, trunk_branch_id, account_id, created_at, updated_at) VALUES (?, ?, NULL, ?, ?, ?, ?)',
          )
          .bind(tree, 'T', branch, account, at, at),
        db
          .prepare(
            "INSERT INTO branches (id, tree_id, parent_branch_id, branch_point_node_id, context_mode, anchor_quote, title, title_source, is_private, provider_id, model, funding, created_at, updated_at) VALUES (?, ?, NULL, NULL, 'path', NULL, 'Main', 'default', 0, ?, ?, ?, ?, ?)",
          )
          .bind(branch, tree, r.provider, r.model, r.funding, at, at),
        db
          .prepare(
            "INSERT INTO nodes (id, tree_id, branch_id, parent_id, seq, role, content, status, provider_id, model, created_at) VALUES (?, ?, ?, NULL, 0, 'assistant', 'A', 'complete', ?, ?, ?)",
          )
          .bind(node, tree, branch, r.provider, r.model, at),
      ]);
    }
    for (const q of migration.queries) await db.prepare(q).run();

    const repos = createD1Repositories(db);
    const got = await Promise.all(
      ids.map(async ({ branch, node }) => ({
        branch: (await repos.trees.getBranch(branch))!,
        node: (await repos.trees.getNode(node))!,
      })),
    );
    expect(
      got.map(({ branch, node }) => [
        branch.providerId,
        branch.model,
        branch.funding,
        node.providerId,
        node.model,
      ]),
    ).toEqual([
      ['openrouter', DEFAULT_SIMPLE_NORMAL_MODEL, 'own-key', 'fake', 'fake-1'],
      ['openrouter', DEFAULT_SIMPLE_NORMAL_MODEL, 'own-key', 'fake', 'fake-1'],
      ['anthropic', 'claude-opus-5-5', 'own-key', 'anthropic', 'claude-opus-5-5'],
    ]);

    // The route it moves to exists in the default power providers, with that model allowed.
    const openrouter = registryFor(defaults, powerUser)
      .list()
      .find((p) => p.id === 'openrouter')!;
    expect(isModelAllowed(openrouter, DEFAULT_SIMPLE_NORMAL_MODEL)).toBe(true);
  });
});
