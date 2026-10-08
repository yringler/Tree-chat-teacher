import { computed } from '@angular/core';
import { describe, expect, it } from 'vitest';
import { LiveReplies, type LiveReply } from './live-replies';

function reply(nodeId: string, branchId: string, content = ''): LiveReply {
  return { nodeId, treeId: 't1', branchId, content, status: null, reconnecting: false };
}

describe('LiveReplies', () => {
  it('follows replies from start to end', () => {
    const live = new LiveReplies();
    expect(live.get('a1')).toBeNull();
    live.set(reply('a1', 'trunk'));
    live.patch('a1', { content: 'Hi', status: 'Thinking…' });
    expect(live.get('a1')).toEqual({ ...reply('a1', 'trunk', 'Hi'), status: 'Thinking…' });
    expect(live.peek('a1')?.content).toBe('Hi');
    // Patching a reply that isn't followed does nothing.
    live.patch('gone', { content: 'x' });
    expect(live.get('gone')).toBeNull();
    live.drop('a1');
    live.drop('a1');
    expect(live.get('a1')).toBeNull();
    expect(live.all().size).toBe(0);
  });

  it('a delta re-evaluates only the readers of its own reply', () => {
    const live = new LiveReplies();
    live.set(reply('a1', 'trunk'));
    live.set(reply('a2', 'side'));
    const runs = { a1: 0, a2: 0, idle: 0, trunk: 0, size: 0 };
    const a1 = computed(() => (runs.a1++, live.get('a1')?.content));
    const a2 = computed(() => (runs.a2++, live.get('a2')?.content));
    const idle = computed(() => (runs.idle++, live.get('n1')));
    const trunk = computed(() => (runs.trunk++, live.branchIds().has('trunk')));
    const size = computed(() => (runs.size++, live.all().size));
    expect([a1(), a2(), idle(), trunk(), size()]).toEqual(['', '', null, true, 2]);

    for (const text of ['Light ', 'is ', 'a wave.']) {
      live.patch('a1', { content: (live.peek('a1')?.content ?? '') + text });
      expect([a1(), a2(), idle(), trunk(), size()]).toEqual([
        live.peek('a1')?.content,
        '',
        null,
        true,
        2,
      ]);
    }
    expect(a1()).toBe('Light is a wave.');
    expect(runs).toEqual({ a1: 4, a2: 1, idle: 1, trunk: 1, size: 1 });

    // Re-setting a followed reply keeps its signal: still nothing else re-evaluates.
    live.set(reply('a1', 'trunk', 'Again'));
    expect([a1(), a2(), idle(), trunk(), size()]).toEqual(['Again', '', null, true, 2]);
    expect(runs).toEqual({ a1: 5, a2: 1, idle: 1, trunk: 1, size: 1 });

    // Starting or ending a reply reaches every reader of the map.
    live.drop('a2');
    expect([a1(), a2(), idle(), trunk(), size()]).toEqual(['Again', undefined, null, true, 1]);
    expect(runs).toEqual({ a1: 6, a2: 2, idle: 2, trunk: 2, size: 2 });
  });

  it('branchIds keeps the same set while the branches generating stay the same', () => {
    const live = new LiveReplies();
    live.set(reply('a1', 'trunk'));
    const before = live.branchIds();
    live.set(reply('a2', 'trunk'));
    expect(live.branchIds()).toBe(before);
    live.drop('a1');
    expect(live.branchIds()).toBe(before);
    live.drop('a2');
    expect([...live.branchIds()]).toEqual([]);
  });
});
