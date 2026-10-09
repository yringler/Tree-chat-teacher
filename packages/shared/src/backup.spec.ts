import { describe, expect, it } from 'vitest';
import {
  MAX_BACKUP_BRANCHES,
  MAX_BACKUP_NODE_CHARS,
  MAX_BACKUP_NODES,
  MAX_NODE_ERROR_CHARS,
  treeBackupSchema,
} from './api.js';

const AT = '2026-10-01T00:00:00.000Z';

const branch = {
  id: 'b',
  treeId: 't',
  parentBranchId: null,
  branchPointNodeId: null,
  contextMode: 'path',
  anchorQuote: null,
  title: 'Main thread',
  titleSource: 'default',
  isPrivate: false,
  providerId: 'openrouter',
  model: 'max',
  createdAt: AT,
  updatedAt: AT,
};

const node = {
  id: 'n1',
  treeId: 't',
  branchId: 'b',
  parentId: null,
  seq: 0,
  role: 'assistant',
  content: 'A prime has two divisors.',
  status: 'error',
  error: 'Upstream failed',
  providerId: 'openrouter',
  model: 'max',
  usage: null,
  createdAt: AT,
};

const backup = {
  format: 'tangent-tree-backup',
  version: 1,
  exportedAt: AT,
  tree: {
    id: 't',
    title: 'Primes',
    systemPrompt: null,
    trunkBranchId: 'b',
    createdAt: AT,
    updatedAt: AT,
  },
  branches: [branch],
  nodes: [node],
};

describe('backup limits', () => {
  it('refuses more branches or messages than a tree may import', () => {
    const branches = Array.from({ length: MAX_BACKUP_BRANCHES + 1 }, (_, i) => ({
      ...branch,
      id: `b${i}`,
    }));
    expect(treeBackupSchema.safeParse({ ...backup, branches }).success).toBe(false);
    const nodes = Array.from({ length: MAX_BACKUP_NODES + 1 }, (_, i) => ({
      ...node,
      id: `n${i}`,
      seq: i,
    }));
    expect(treeBackupSchema.safeParse({ ...backup, nodes }).success).toBe(false);
    const atCap = nodes.slice(0, MAX_BACKUP_NODES);
    expect(treeBackupSchema.safeParse({ ...backup, nodes: atCap }).success).toBe(true);
  });

  it('refuses an oversized message and unbounded route fields', () => {
    const big = { ...node, content: 'x'.repeat(MAX_BACKUP_NODE_CHARS + 1) };
    expect(treeBackupSchema.safeParse({ ...backup, nodes: [big] }).success).toBe(false);
    const model = { ...node, model: 'm'.repeat(201) };
    expect(treeBackupSchema.safeParse({ ...backup, nodes: [model] }).success).toBe(false);
    const provider = { ...node, providerId: 'p'.repeat(65) };
    expect(treeBackupSchema.safeParse({ ...backup, nodes: [provider] }).success).toBe(false);
  });

  it('cuts a long error message rather than refusing the backup that recorded it', () => {
    const long = { ...node, error: 'e'.repeat(MAX_NODE_ERROR_CHARS * 3) };
    const parsed = treeBackupSchema.parse({ ...backup, nodes: [long] });
    expect(parsed.nodes[0]?.error).toBe('e'.repeat(MAX_NODE_ERROR_CHARS));
    expect(treeBackupSchema.parse(backup).nodes[0]?.error).toBe('Upstream failed');
  });
});
