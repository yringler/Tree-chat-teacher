import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../core/api-client';
import type { FailedSend } from '../conversation/conversation-store';
import { PowerConversationStore, type PowerApi } from './power-conversation-store';

/** Power's store with no app around it, its hooks reachable from the tests. */
class Store extends PowerConversationStore {
  readonly failures: unknown[] = [];

  fail(err: unknown): void {
    this.failures.push(err);
  }
  protected notify(): void {}
  protected keysSettled(): void {}
  protected movedToCredit(): void {}

  failSend(err: unknown, send: FailedSend): void {
    this.sendFailed(err, send);
  }
  starting(branchId: string): void {
    this.sendStarting(branchId);
  }
  removed(branchIds: string[]): void {
    this.branchesRemoved(new Set(branchIds), new Set());
  }
}

function setup(): Store {
  const router = { navigate: vi.fn(async () => true) };
  // No server call is made: the tests drive the hooks the engine calls.
  return new Store({} as PowerApi, router, {
    tree: 'conversation',
    branch: 'branch',
    link: 'link',
    linked: { created: 'Messages linked', existing: 'Already linked' },
  });
}

const noKey = () => new ApiError(401, 'key_required', 'Add your key');

function refused(branchId: string, content = 'Why?'): FailedSend {
  return { branchId, content, options: {}, started: false };
}

describe('PowerConversationStore', () => {
  it('a send refused for want of the key waits for the keys dialog, its text back in the composer', () => {
    const s = setup();
    s.failSend(noKey(), refused('side'));
    expect(s.blockedSends()).toEqual([{ branchId: 'side', content: 'Why?' }]);
    expect(s.unsentDrafts().get('side')).toBe('Why?');
    expect(s.failures).toHaveLength(1);
  });

  it('a send that failed after its reply started is in the tree: nothing is held back', () => {
    const s = setup();
    s.failSend(noKey(), { ...refused('side'), started: true });
    expect(s.blockedSends()).toEqual([]);
    expect(s.unsentDrafts().has('side')).toBe(false);
    // Still reported.
    expect(s.failures).toHaveLength(1);
  });

  it('"Check sources" is held for the key, but its text never lands in the composer', () => {
    const s = setup();
    s.failSend(noKey(), { ...refused('side'), options: { ground: 'required' } });
    expect(s.blockedSends()).toEqual([{ branchId: 'side', content: 'Why?', ground: 'required' }]);
    expect(s.unsentDrafts().has('side')).toBe(false);
  });

  it('sending a branch again drops its waiting message and its unsent text, not the others', () => {
    const s = setup();
    s.failSend(noKey(), refused('side'));
    s.failSend(noKey(), refused('trunk', 'Hi'));
    s.starting('side');
    expect(s.blockedSends().map((b) => b.branchId)).toEqual(['trunk']);
    expect([...s.unsentDrafts().keys()]).toEqual(['trunk']);
  });

  it("answers for a message's branch: which it is, whether it is locked, whether it is the newest", () => {
    const s = setup();
    const T = '2026-01-01T00:00:00.000Z';
    const b = (id: string, funding: 'own-key' | 'credit') => ({
      id,
      treeId: 't1',
      parentBranchId: id === 'trunk' ? null : 'trunk',
      branchPointNodeId: id === 'trunk' ? null : 'a1',
      contextMode: 'path' as const,
      anchorQuote: null,
      title: id,
      titleSource: 'default' as const,
      isPrivate: false,
      providerId: 'openrouter',
      model: 'a/b',
      funding,
      createdAt: T,
      updatedAt: T,
    });
    const n = (id: string, branchId: string, parentId: string | null, seq: number) => ({
      id,
      treeId: 't1',
      branchId,
      parentId,
      seq,
      role: 'assistant' as const,
      content: '',
      status: 'complete' as const,
      error: null,
      providerId: null,
      model: null,
      usage: null,
      createdAt: T,
    });
    s.selectedTreeId.set('t1');
    s.detail.set({
      tree: {
        id: 't1',
        accountId: 'p_1',
        title: 'Light',
        systemPrompt: null,
        trunkBranchId: 'trunk',
        createdAt: T,
        updatedAt: T,
      },
      branches: [b('trunk', 'own-key'), b('side', 'credit')],
      nodes: [n('a1', 'trunk', null, 0), n('a2', 'side', 'a1', 1)],
      links: [],
    });
    s.setRoute('t1', 'side', null);
    expect(s.branchOf('a2')?.id).toBe('side');
    expect(s.branchOf('gone')).toBeNull();
    expect(s.isLatest('a2')).toBe(true);
    expect(s.isLatest('a1')).toBe(false);
    // Own keys need the membership the user lacks: the trunk is locked, credit isn't.
    s.account.membershipNeededFor.set(['own-key']);
    s.account.membership.set({
      required: true,
      status: 'inactive',
      subscriptionStatus: null,
      periodEnd: null,
      cancelAtPeriodEnd: false,
      priceCents: 1000,
    });
    expect(s.nodeLocked('a1')).toBe(true);
    expect(s.nodeLocked('a2')).toBe(false);
  });

  it('deleting branches drops their waiting messages and unsent text, not the others', () => {
    const s = setup();
    s.failSend(noKey(), refused('side'));
    s.failSend(noKey(), refused('deep', 'Deeper?'));
    s.failSend(noKey(), refused('trunk', 'Hi'));
    s.removed(['side', 'deep']);
    expect(s.blockedSends().map((b) => b.branchId)).toEqual(['trunk']);
    expect([...s.unsentDrafts().keys()]).toEqual(['trunk']);
  });
});
