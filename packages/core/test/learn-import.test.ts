import type { TreeBackupInput } from '@tangent/shared';
import { describe, expect, it } from 'vitest';
import { adaptBackupForLearn, type LearnImportTarget } from '../src/learn-import.js';

const AT = '2026-01-01T00:00:00.000Z';

const TARGET: LearnImportTarget = {
  providerId: 'openrouter',
  models: ['smart', 'simple'],
  defaultModel: 'smart',
  systemPrompt: 'TUTOR',
};

type BackupBranch = TreeBackupInput['branches'][number];

function branch(id: string, over: Partial<BackupBranch> = {}): BackupBranch {
  return {
    id,
    treeId: 't',
    parentBranchId: 'trunk',
    branchPointNodeId: 'n2',
    contextMode: 'path',
    anchorQuote: null,
    title: id,
    titleSource: 'user',
    isPrivate: false,
    providerId: 'openrouter',
    model: 'smart',
    funding: 'own-key',
    createdAt: AT,
    updatedAt: AT,
    ...over,
  };
}

/** A tree as power mode makes it: several providers, models, context modes and fundings. */
function powerBackup(): TreeBackupInput {
  return {
    format: 'tangent-tree-backup',
    version: 1,
    exportedAt: AT,
    tree: {
      id: 't',
      accountId: 'p_user',
      title: 'Primes',
      systemPrompt: 'You are a pirate.',
      trunkBranchId: 'trunk',
      createdAt: AT,
      updatedAt: AT,
    },
    branches: [
      branch('trunk', {
        parentBranchId: null,
        branchPointNodeId: null,
        providerId: 'anthropic',
        model: 'vendor-large',
        titleSource: 'default',
      }),
      branch('simple', { model: 'simple', anchorQuote: 'a prime', isPrivate: true }),
      branch('credit', { model: 'smart', funding: 'credit', contextMode: 'summary' }),
      branch('open', { model: 'vendor/other-model', contextMode: 'independent' }),
      branch('legacy', { providerId: 'tangent', model: 'simple', funding: undefined }),
      branch('elsewhere', { providerId: 'openai', model: 'smart' }),
    ],
    nodes: [
      {
        id: 'n1',
        treeId: 't',
        branchId: 'trunk',
        parentId: null,
        seq: 0,
        role: 'user',
        content: 'What is a prime?',
        status: 'complete',
        error: null,
        providerId: null,
        model: null,
        usage: null,
        createdAt: AT,
      },
      {
        id: 'n2',
        treeId: 't',
        branchId: 'trunk',
        parentId: 'n1',
        seq: 1,
        role: 'assistant',
        content: 'A number with exactly two divisors.',
        status: 'complete',
        error: null,
        providerId: 'anthropic',
        model: 'vendor-large',
        usage: { inputTokens: 10, outputTokens: 8 },
        createdAt: AT,
      },
    ],
  };
}

const routes = (b: TreeBackupInput) =>
  b.branches.map((x) => [x.id, x.providerId, x.model, x.contextMode, x.funding]);

describe('adaptBackupForLearn', () => {
  it("moves branches Learn can't run onto its provider's default model and keeps its own models", () => {
    expect(routes(adaptBackupForLearn(powerBackup(), TARGET))).toEqual([
      // Another provider: Learn's provider, Smart.
      ['trunk', 'openrouter', 'smart', 'path', 'own-key'],
      // Already on one of Learn's models: kept.
      ['simple', 'openrouter', 'simple', 'path', 'own-key'],
      // On credit in power: kept model, but own-key (Learn pays per request).
      ['credit', 'openrouter', 'smart', 'path', 'own-key'],
      // A model Learn doesn't offer (power's open models): Smart.
      ['open', 'openrouter', 'smart', 'path', 'own-key'],
      // The legacy built-in id is the built-in endpoint.
      ['legacy', 'openrouter', 'simple', 'path', 'own-key'],
      // A model id Learn offers, but on another provider: Smart on Learn's.
      ['elsewhere', 'openrouter', 'smart', 'path', 'own-key'],
    ]);
  });

  it("gives the lesson Learn's prompt, or none when Learn has none", () => {
    expect(adaptBackupForLearn(powerBackup(), TARGET).tree.systemPrompt).toBe('TUTOR');
    expect(
      adaptBackupForLearn(powerBackup(), { ...TARGET, systemPrompt: null }).tree.systemPrompt,
    ).toBeNull();
  });

  it('keeps messages, titles, anchors, privacy and the tree structure as they are', () => {
    const before = powerBackup();
    const after = adaptBackupForLearn(before, TARGET);
    expect(after.nodes).toEqual(before.nodes);
    const { systemPrompt: _a, ...treeBefore } = before.tree;
    const { systemPrompt: _b, ...treeAfter } = after.tree;
    expect(treeAfter).toEqual(treeBefore);
    const keep = (b: TreeBackupInput) =>
      b.branches.map((x) => ({
        id: x.id,
        parentBranchId: x.parentBranchId,
        branchPointNodeId: x.branchPointNodeId,
        anchorQuote: x.anchorQuote,
        title: x.title,
        titleSource: x.titleSource,
        isPrivate: x.isPrivate,
      }));
    expect(keep(after)).toEqual(keep(before));
    expect(after.format).toBe('tangent-tree-backup');
    expect(after.exportedAt).toBe(AT);
  });

  it('does not change its input, and adapting twice changes nothing more', () => {
    const before = powerBackup();
    const copy = structuredClone(before);
    const once = adaptBackupForLearn(before, TARGET);
    expect(before).toEqual(copy);
    expect(adaptBackupForLearn(once, TARGET)).toEqual(once);
  });

  it('leaves a backup made in Learn as it was, apart from the prompt', () => {
    const learn: TreeBackupInput = {
      ...powerBackup(),
      tree: { ...powerBackup().tree, systemPrompt: 'TUTOR' },
      branches: [
        branch('trunk', { parentBranchId: null, branchPointNodeId: null }),
        branch('side', { model: 'simple', anchorQuote: 'two divisors' }),
      ],
    };
    expect(adaptBackupForLearn(learn, TARGET)).toEqual(learn);
  });
});
