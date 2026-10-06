// Migration 0023 (`node_links`) runs on a database that was really at the
// schema before it: LINKS_MIGRATION_DB starts empty (vitest.config.ts), gets
// migrations 0000–0022 only, is seeded with a tree in that schema, then gets the
// rest, as `wrangler d1 migrations apply` does in production. The existing rows
// are untouched, read with no links, and can be linked like new ones.
import { NotFoundError } from '@tangent/core';
import { applyD1Migrations, type D1Migration } from 'cloudflare:test';
import { env as rawEnv } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { createD1Repositories } from '../src/db/d1-repositories.js';
import type { AccountContext, AppEnv } from '../src/env.js';
import { chatService } from '../src/services.js';

const env = rawEnv as unknown as AppEnv & {
  TEST_MIGRATIONS: D1Migration[];
  LINKS_MIGRATION_DB: D1Database;
};
const db = env.LINKS_MIGRATION_DB;
/** The app on the upgraded database. */
const upgraded = { ...env, DB: db } as AppEnv;

const ALL = env.TEST_MIGRATIONS;
const BEFORE = ALL.filter((m) => m.name < '0023_');
const AT = '2026-09-01T12:00:00.000Z';

const USER = 'grace';
const POWER = `p_${USER}`;
const power: AccountContext = {
  id: POWER,
  mode: 'power',
  userId: USER,
  billingAccountId: `u_${USER}`,
  builtIn: false,
  operatorKeys: false,
  funding: 'own-key',
};

/**
 * Tree `t_old`: trunk `b_trunk` with n1 (question) and n2 (reply); `b_side`
 * off n2 with n3 and n4.
 */
const nodes = [
  { id: 'n1', branch: 'b_trunk', parent: null, seq: 0, role: 'user', content: 'What is a prime?' },
  {
    id: 'n2',
    branch: 'b_trunk',
    parent: 'n1',
    seq: 1,
    role: 'assistant',
    content: 'Two divisors.',
  },
  { id: 'n3', branch: 'b_side', parent: 'n2', seq: 0, role: 'user', content: 'And 1?' },
  { id: 'n4', branch: 'b_side', parent: 'n3', seq: 1, role: 'assistant', content: 'Not prime.' },
] as const;

async function seedOldSchema(): Promise<void> {
  const branch = (id: string, parent: string | null, point: string | null) =>
    db
      .prepare(
        "INSERT INTO branches (id, tree_id, parent_branch_id, branch_point_node_id, context_mode, anchor_quote, title, title_source, is_private, provider_id, model, funding, grounding, created_at, updated_at) VALUES (?, 't_old', ?, ?, 'path', NULL, ?, 'default', 0, 'fake', 'fake-1', 'own-key', 'auto', ?, ?)",
      )
      .bind(id, parent, point, id, AT, AT);
  await db.batch([
    db
      .prepare(
        "INSERT INTO accounts (id, name, created_at, user_id, mode) VALUES (?, 'Power', ?, ?, 'power')",
      )
      .bind(POWER, AT, USER),
    db
      .prepare(
        "INSERT INTO trees (id, title, system_prompt, trunk_branch_id, account_id, created_at, updated_at) VALUES ('t_old', 'Primes', NULL, 'b_trunk', ?, ?, ?)",
      )
      .bind(POWER, AT, AT),
    branch('b_trunk', null, null),
    branch('b_side', 'b_trunk', 'n2'),
    ...nodes.map((n) =>
      db
        .prepare(
          "INSERT INTO nodes (id, tree_id, branch_id, parent_id, seq, role, content, status, created_at) VALUES (?, 't_old', ?, ?, ?, ?, ?, 'complete', ?)",
        )
        .bind(n.id, n.branch, n.parent, n.seq, n.role, n.content, AT),
    ),
  ]);
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

describe('migration 0023 on a database at the 0022 schema', () => {
  beforeAll(async () => {
    const after = ALL.map((m) => m.name).filter((n) => n >= '0023_');
    expect(after[0]).toBe('0023_node_links.sql');
    await applyD1Migrations(db, BEFORE);
    // Really the old schema: no node_links table.
    expect(
      await rows("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'node_links'"),
    ).toEqual([]);
    await seedOldSchema();
    await applyD1Migrations(db, ALL);
  });

  it('applies it once, recorded so it never runs twice', async () => {
    const names = await applied();
    expect(names).toEqual(ALL.map((m) => m.name));
    await applyD1Migrations(db, ALL);
    expect(await applied()).toEqual(names);
    // That bookkeeping is what makes a re-run safe: CREATE TABLE isn't idempotent.
    const create = ALL.find((m) => m.name.startsWith('0023_'))!.queries[0]!;
    await expect(db.prepare(create).run()).rejects.toThrow(/already exists/);
  });

  it('leaves the same schema as a database migrated from scratch', async () => {
    expect(await schemaOf(db)).toEqual(await schemaOf(env.DB));
    const indexes = await rows<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'node_links' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    );
    expect(indexes.map((i) => i.name)).toEqual([
      'node_links_pair_uq',
      'node_links_source_idx',
      'node_links_target_idx',
      'node_links_tree_idx',
    ]);
  });

  it('keeps the existing rows, which read with no links', async () => {
    const chat = chatService(upgraded, power);
    const detail = await chat.getTreeDetail('t_old');
    expect(detail.links).toEqual([]);
    expect(detail.nodes.map((n) => n.id).sort()).toEqual(['n1', 'n2', 'n3', 'n4']);
    expect(detail.branches).toHaveLength(2);
    expect((await chat.exportBackup('t_old')).links).toEqual([]);
  });

  it('links the existing messages: dedupe, the CHECK, and the cascades', async () => {
    const chat = chatService(upgraded, power);
    const repos = createD1Repositories(db);
    const { link, created } = await chat.createLink({
      fromNodeId: 'n1',
      toNodeId: 'n4',
      note: 'the question it answers',
    });
    expect(created).toBe(true);
    expect(await chat.createLink({ fromNodeId: 'n4', toNodeId: 'n1' })).toEqual({
      link,
      created: false,
    });
    const kept = (await chat.createLink({ fromNodeId: 'n1', toNodeId: 'n2' })).link;
    expect((await chat.getTreeDetail('t_old')).links).toEqual([link, kept]);
    await expect(
      db
        .prepare(
          "INSERT INTO node_links (id, tree_id, source_node_id, target_node_id, pair_key, created_at, updated_at) VALUES ('self', 't_old', 'n2', 'n2', 'n2|n2', ?, ?)",
        )
        .bind(AT, AT)
        .run(),
    ).rejects.toThrow(/CHECK/);
    await expect(
      repos.trees.createLink({ ...link, id: 'ghost', targetNodeId: 'missing' }, AT),
    ).rejects.toBeInstanceOf(NotFoundError);

    // Deleting the side branch takes its link and leaves the trunk's.
    await chat.deleteBranch('b_side');
    expect((await chat.getTreeDetail('t_old')).links).toEqual([kept]);
    // A message deleted by hand takes its links with it (the FK cascade).
    await db.prepare("DELETE FROM nodes WHERE id = 'n2'").run();
    expect(await repos.trees.listLinks('t_old')).toEqual([]);
  });
});
