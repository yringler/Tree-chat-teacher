import type { TreeBackup } from '@tangent/shared';
import { describe, expect, it } from 'vitest';
import { backupFile, readBackupFile } from './backup-file';
import { branch, detail, T } from '../testing';

const BACKUP: TreeBackup = {
  format: 'tangent-tree-backup',
  version: 1,
  exportedAt: T,
  tree: detail([], [], [], { id: 't', title: 'Why is the sky blue?', trunkBranchId: 'b' }).tree,
  branches: [branch('b', { treeId: 't', title: 'Main thread', model: 'max' })],
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
      'big.json is too large to import (60 MB; the limit is 10 MB).',
    );
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
