import { DEFAULT_ACCOUNT_ID } from '@tangent/shared';
import { describe, expect, it } from 'vitest';
import { NotFoundError } from '../../src/errors.js';
import { ChatService, DEFAULT_CHAT_SETTINGS } from '../../src/services/chat-service.js';
import { ShareService } from '../../src/services/share-service.js';
import { registryOf, send, setup } from './helpers.js';

/** Two services over the same storage, acting as different accounts. */
function twoAccounts() {
  const base = setup({ autoTitle: false });
  const otherChat = new ChatService({
    repos: base.repos,
    providers: registryOf(base.provider),
    settings: { ...DEFAULT_CHAT_SETTINGS, autoTitle: false },
    accountId: 'other',
  });
  const otherShares = new ShareService({
    repos: base.repos,
    publicBaseUrl: 'https://t.test',
    accountId: 'other',
  });
  return { ...base, otherChat, otherShares };
}

describe('accounts', () => {
  it('stamps new trees and shares with the default account', async () => {
    const { chat, shares } = setup({ autoTitle: false });
    const { tree } = await chat.createTree({});
    expect(tree.accountId).toBe(DEFAULT_ACCOUNT_ID);
    await send(chat, tree.trunkBranchId, 'hi');
    const share = await shares.create({ treeId: tree.id, scope: 'tree' });
    expect(share.accountId).toBe(DEFAULT_ACCOUNT_ID);
  });

  it('keeps trees and shares of other accounts out of reach', async () => {
    const { chat, shares, otherChat, otherShares } = twoAccounts();
    const { tree } = await chat.createTree({ title: 'Mine' });
    await send(chat, tree.trunkBranchId, 'hi');
    const share = await shares.create({ treeId: tree.id, scope: 'tree' });

    expect(await otherChat.listTrees()).toEqual([]);
    await expect(otherChat.getTreeDetail(tree.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(otherChat.updateTree(tree.id, { title: 'x' })).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(otherChat.deleteTree(tree.id)).rejects.toBeInstanceOf(NotFoundError);
    const branch = await chat.createBranch({
      fromNodeId: (await chat.getTreeDetail(tree.id)).nodes[0]!.id,
    });
    await expect(otherChat.deleteBranch(branch.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(otherChat.exportBackup(tree.id)).rejects.toBeInstanceOf(NotFoundError);

    expect(await otherShares.list()).toEqual([]);
    await expect(otherShares.create({ treeId: tree.id, scope: 'tree' })).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(otherShares.revoke(share.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(otherShares.republish(share.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(otherShares.update(share.id, { title: 'x' })).rejects.toBeInstanceOf(
      NotFoundError,
    );

    // The owner still sees everything; public links are account-independent.
    expect(await chat.listTrees()).toHaveLength(1);
    expect((await otherShares.resolvePublic(share.token)).ok).toBe(true);
  });

  it('assigns imported backups to the importing account', async () => {
    const { chat, otherChat } = twoAccounts();
    const { tree } = await chat.createTree({});
    await send(chat, tree.trunkBranchId, 'hi');
    const backup = await chat.exportBackup(tree.id);
    expect(backup.tree.accountId).toBe(DEFAULT_ACCOUNT_ID);
    const restored = await otherChat.importBackup(backup);
    expect(restored.tree.accountId).toBe('other');
    expect(await otherChat.listTrees()).toHaveLength(1);
    // Backups made before accounts existed (no accountId) import fine.
    const { accountId: _drop, ...legacyTree } = backup.tree;
    const legacy = await chat.importBackup({ ...backup, tree: legacyTree });
    expect(legacy.tree.accountId).toBe(DEFAULT_ACCOUNT_ID);
  });
});

describe('account settings', () => {
  function withDefault(accountId: string, base = setup({ autoTitle: false })) {
    return new ChatService({
      repos: base.repos,
      providers: registryOf(base.provider),
      settings: { ...DEFAULT_CHAT_SETTINGS, autoTitle: false },
      accountId,
      defaultSystemPrompt: 'BUILT-IN',
    });
  }

  it('gives new trees the saved prompt, else the built-in one, unless the request names one', async () => {
    const base = setup({ autoTitle: false });
    const chat = withDefault('a', base);
    const other = withDefault('b', base);
    expect(await chat.getSettings()).toEqual({
      systemPrompt: null,
      defaultSystemPrompt: 'BUILT-IN',
    });
    expect((await chat.createTree({})).tree.systemPrompt).toBe('BUILT-IN');
    expect((await chat.createTree({ systemPrompt: '  ' })).tree.systemPrompt).toBe('BUILT-IN');

    expect(await chat.updateSettings({ systemPrompt: 'MINE' })).toEqual({
      systemPrompt: 'MINE',
      defaultSystemPrompt: 'BUILT-IN',
    });
    expect((await chat.createTree({})).tree.systemPrompt).toBe('MINE');
    expect((await chat.createTree({ systemPrompt: 'THIS ONE' })).tree.systemPrompt).toBe(
      'THIS ONE',
    );
    // Settings are per account.
    expect((await other.getSettings()).systemPrompt).toBeNull();
    expect((await other.createTree({})).tree.systemPrompt).toBe('BUILT-IN');

    // A blank prompt goes back to the built-in one.
    expect((await chat.updateSettings({ systemPrompt: ' \n' })).systemPrompt).toBeNull();
    expect((await chat.createTree({})).tree.systemPrompt).toBe('BUILT-IN');
  });

  it('has no default prompt without a built-in one', async () => {
    const { chat } = setup({ autoTitle: false });
    expect((await chat.createTree({})).tree.systemPrompt).toBeNull();
    expect(await chat.getSettings()).toEqual({ systemPrompt: null, defaultSystemPrompt: '' });
  });
});
