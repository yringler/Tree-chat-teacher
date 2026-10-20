import { TestBed } from '@angular/core/testing';
import type { TreeDetail } from '@tangent/shared';
import { ComposerController } from '@tangent/web-shared';
import {
  branch,
  detail,
  membership,
  node,
  openTree,
  powerProviders,
  provider,
  signIn,
} from '@tangent/web-shared/testing';
import { describe, expect, it, onTestFinished } from 'vitest';
import { TreeStore } from '../state/tree-store';
import { UiStore } from '../state/ui-store';
import { Keyboard, SHORTCUTS } from './keyboard';

/** "What is light?" (u1) → "A wave." (a1) → "And?" (u2) → "A particle." (a2), on the trunk. */
function tree(last: 'complete' | 'streaming' = 'complete'): TreeDetail {
  return detail(
    [
      node('u1', { role: 'user', content: 'What is light?' }),
      node('a1', { parentId: 'u1', seq: 1, content: 'A wave.' }),
      node('u2', { parentId: 'a1', seq: 2, role: 'user', content: 'And?' }),
      node('a2', { parentId: 'u2', seq: 3, content: 'A particle.', status: last }),
    ],
    [branch('trunk', { title: 'Main thread' })],
  );
}

const CREDIT = provider({ funding: 'credit', acceptsUserKey: false, keySource: 'server' });

/**
 * Power's keyboard on `d`. `lapsed`: the membership ended, so the own-key
 * trunk is read-only, while Tangent credit can still reply.
 */
function setup(d = tree(), opts: { lapsed?: boolean } = {}) {
  TestBed.configureTestingModule({ providers: powerProviders(TreeStore, {}) });
  const store = TestBed.inject(TreeStore);
  signIn(store.account, {
    membership: opts.lapsed
      ? membership({ status: 'inactive', subscriptionStatus: 'canceled' })
      : undefined,
    providers: [provider(), CREDIT],
    builtInCredit: true,
    billing: { availableMicros: 1_000_000, enabled: true } as never,
  });
  openTree(store, d);
  const keyboard = TestBed.inject(Keyboard);
  const press = (key: string, init: KeyboardEventInit = {}) => {
    const e = new KeyboardEvent('keydown', { key, cancelable: true, ...init });
    keyboard.handle(e);
    return e;
  };
  return {
    store,
    ui: TestBed.inject(UiStore),
    composer: TestBed.inject(ComposerController),
    press,
    focus: (nodeId: string) => store.setRoute('t1', 'trunk', nodeId),
  };
}

/** Reply a1 on the page, as power renders it, with "wave" of "A wave." selected. */
function selectWave(): void {
  const messages = document.createElement('div');
  messages.className = 'messages';
  messages.innerHTML =
    '<article id="msg-a1" data-node-id="a1"><div class="msg-body" data-node-id="a1">A wave.</div></article>';
  document.body.append(messages);
  onTestFinished(() => messages.remove());
  const text = messages.querySelector('.msg-body')!.firstChild!;
  const range = document.createRange();
  range.setStart(text, 2);
  range.setEnd(text, 6);
  window.getSelection()!.removeAllRanges();
  window.getSelection()!.addRange(range);
}

describe('Power: keyboard', () => {
  it('b puts the focused reply on the message box (a question stands for its reply), else the latest', () => {
    const k = setup();
    expect(k.press('b').defaultPrevented).toBe(true);
    expect(k.composer.lead()).toEqual({ nodeId: 'a2', quote: null });
    k.focus('a1');
    k.press('b');
    expect(k.composer.lead()).toEqual({ nodeId: 'a1', quote: null });
    k.focus('u2');
    k.press('b');
    expect(k.composer.lead()).toEqual({ nodeId: 'a2', quote: null });
    expect(k.ui.dialogs.list()).toEqual([]);
  });

  it('b puts words selected in a reply on the message box, and lets the selection go', () => {
    const k = setup();
    selectWave();
    expect(k.press('b').defaultPrevented).toBe(true);
    expect(k.composer.lead()).toEqual({ nodeId: 'a1', quote: 'wave' });
    expect(window.getSelection()!.isCollapsed).toBe(true);
  });

  it('b with no finished reply to put there leaves the key alone', () => {
    const k = setup(tree('streaming'));
    expect(k.press('b').defaultPrevented).toBe(false);
    expect(k.composer.lead()).toBeNull();
  });

  it('on a read-only thread, which has no message box, b opens Tangent from here', () => {
    const k = setup(tree(), { lapsed: true });
    k.press('b');
    expect(k.composer.lead()).toBeNull();
    expect(k.ui.dialogs.get('branch')).toEqual({ kind: 'branch', fromNodeId: 'a2', quote: null });
  });

  it('Shift+B opens Tangent from here for the focused message, with the words selected in it', () => {
    const k = setup();
    expect(k.press('B', { shiftKey: true }).defaultPrevented).toBe(true);
    expect(k.ui.dialogs.get('branch')).toEqual({ kind: 'branch', fromNodeId: 'a2', quote: null });
    k.ui.dialogs.close('branch');
    k.focus('a1');
    selectWave();
    k.press('B', { shiftKey: true });
    expect(k.ui.dialogs.get('branch')).toEqual({ kind: 'branch', fromNodeId: 'a1', quote: 'wave' });
    expect(k.composer.lead()).toBeNull();
  });

  it('the help lists b and Shift+B', () => {
    expect(SHORTCUTS).toContainEqual({
      keys: ['b'],
      label: 'Put the selected words, else the focused (or latest) reply, on the message box',
    });
    expect(SHORTCUTS).toContainEqual({
      keys: ['Shift+B'],
      label: 'Open Tangent from here for the focused (or latest) message',
    });
  });
});
