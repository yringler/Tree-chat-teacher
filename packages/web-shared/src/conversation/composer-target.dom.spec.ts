import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { Branch, ChatNode } from '@tangent/shared';
import { describe, expect, it, vi } from 'vitest';
import { branch, detail, node } from '../testing';
import { ComposerController } from '../ui/composer';
import { ComposerTarget } from './composer-target';

/** The main thread, u1 → a1 → u2 → a2, with a1 focused, and the box's target. */
function setup() {
  const d = detail(
    [
      node('u1', { role: 'user', content: 'What is light?' }),
      node('a1', { parentId: 'u1', seq: 1, content: 'A wave.' }),
      node('u2', { parentId: 'a1', seq: 2, role: 'user', content: 'And?' }),
      node('a2', { parentId: 'u2', seq: 3, content: 'A particle.' }),
    ],
    [branch('trunk')],
  );
  const nodes = new Map(d.nodes.map((n) => [n.id, n]));
  const focusedNodeId = signal<string | null>('a1');
  const store = {
    path: signal<ChatNode[]>(d.nodes),
    selectedBranchId: signal<string | null>('trunk'),
    selectedBranch: signal<Branch | null>(d.branches[0] ?? null),
    focusedNodeId,
    focusedInPath: () => nodes.get(focusedNodeId() ?? '') ?? null,
    focus: vi.fn((id: string | null) => focusedNodeId.set(id)),
    index: () => ({ nodes }),
    send: vi.fn(async () => true),
    askFrom: vi.fn(async (): Promise<Branch | null> => null),
  };
  const thread = { pin: vi.fn(), toMessage: vi.fn(() => true) };
  const box = TestBed.runInInjectionContext(
    () => new ComposerTarget({ store: store as never, thread }),
  );
  return { store, thread, box, composer: TestBed.inject(ComposerController) };
}

describe('ComposerTarget', () => {
  it('names the focused reply its tangent starts at; a lead names itself', () => {
    const t = setup();
    expect(t.box.plan().target).toBe('a1');
    expect(t.box.target()).toBe('A wave.');
    t.box.showTarget();
    expect(t.thread.toMessage).toHaveBeenCalledWith('a1');
    t.composer.aim({ nodeId: 'a2', quote: 'particle' });
    expect(t.box.plan().target).toBe('a2');
    expect(t.box.target()).toBeNull();
    expect(t.box.excerptOf('a2')).toBe('A particle.');
  });

  it('a message that goes on lets the focus go, and the view follows its reply', () => {
    const t = setup();
    t.box.send('Why?');
    expect(t.thread.pin).toHaveBeenCalled();
    expect(t.store.focus).toHaveBeenCalledWith(null);
    expect(t.store.send).toHaveBeenCalledWith('trunk', 'Why?');
  });

  it('a tangent from the box keeps the lead until it is made', async () => {
    const t = setup();
    t.composer.aim({ nodeId: 'a1', quote: 'wave' });
    await t.box.goOnTangent('Of what?');
    expect(t.store.askFrom).toHaveBeenCalledWith('a1', 'Of what?', 'wave');
    expect(t.box.lead()).toEqual({ nodeId: 'a1', quote: 'wave' });
    t.store.askFrom.mockResolvedValue(branch('new'));
    await t.box.goOnTangent('Of what?');
    expect(t.box.lead()).toBeNull();
  });
});
