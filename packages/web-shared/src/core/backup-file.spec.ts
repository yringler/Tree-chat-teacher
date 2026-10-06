import type { TreeBackup } from '@tangent/shared';
import { describe, expect, it } from 'vitest';
import { backupFile, MAX_BACKUP_BYTES, readBackupFile } from './backup-file';

const AT = '2026-01-01T00:00:00.000Z';

const BACKUP: TreeBackup = {
  format: 'tangent-tree-backup',
  version: 1,
  exportedAt: AT,
  tree: {
    id: 't',
    accountId: 'u_1',
    title: 'Why is the sky blue?',
    systemPrompt: null,
    trunkBranchId: 'b',
    createdAt: AT,
    updatedAt: AT,
  },
  branches: [
    {
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
      model: 'smart',
      funding: 'own-key',
      createdAt: AT,
      updatedAt: AT,
    },
  ],
  nodes: [],
};

const file = (text: string, name = 'lesson.tangent.json') => new File([text], name);

describe('readBackupFile', () => {
  it('reads a backup made by either app', async () => {
    await expect(readBackupFile(file(JSON.stringify(BACKUP)))).resolves.toEqual(BACKUP);
  });

  it('refuses an empty or too large file before reading it', async () => {
    await expect(readBackupFile(file(''))).rejects.toThrow('lesson.tangent.json is empty.');
    const big = { name: 'big.json', size: 60 * 1024 * 1024, text: () => Promise.reject() };
    await expect(readBackupFile(big)).rejects.toThrow(
      'big.json is too large to import (60 MB; the limit is 50 MB).',
    );
    expect(MAX_BACKUP_BYTES).toBe(50 * 1024 * 1024);
    await expect(readBackupFile(file('{"a":1}'), 3)).rejects.toThrow(/too large/);
  });

  it('says when a file is not JSON, e.g. a Markdown export', async () => {
    await expect(readBackupFile(file('# Why is the sky blue?', 'sky.md'))).rejects.toThrow(
      'sky.md is not a JSON file. Import takes a JSON backup (.tangent.json), not a Markdown or HTML export.',
    );
  });

  it('tells other JSON, a newer version and a damaged backup apart', async () => {
    await expect(readBackupFile(file('{"hello":"world"}', 'x.json'))).rejects.toThrow(
      'x.json is not a Tangent backup.',
    );
    await expect(readBackupFile(file('[1,2]', 'x.json'))).rejects.toThrow(
      'x.json is not a Tangent backup.',
    );
    await expect(
      readBackupFile(file(JSON.stringify({ ...BACKUP, version: 2 }), 'new.json')),
    ).rejects.toThrow(
      'new.json was made by a newer version of Tangent and can’t be imported here.',
    );
    await expect(
      readBackupFile(file(JSON.stringify({ ...BACKUP, branches: [{ id: 'b' }] }), 'bad.json')),
    ).rejects.toThrow(/^bad\.json is a damaged Tangent backup \(branches\.0\.\w+: .+\)\.$/);
  });
});

describe('backupFile', () => {
  it("is the server's JSON under the server's file name, and reads back as the same backup", async () => {
    const { name, blob } = backupFile(BACKUP);
    expect(name).toBe('why-is-the-sky-blue.tangent.json');
    expect(blob.type).toBe('application/json');
    expect(await blob.text()).toBe(JSON.stringify(BACKUP));
    await expect(readBackupFile(new File([blob], name))).resolves.toEqual(BACKUP);
  });
});
