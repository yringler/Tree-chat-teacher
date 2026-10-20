import { TestBed } from '@angular/core/testing';
import { ComposerController, ThreadEnds } from '@tangent/web-shared';
import { appProviders, branch, detail, node, openTree } from '@tangent/web-shared/testing';
import { describe, expect, it, vi } from 'vitest';
import { branchyLesson, learner } from '../learn.testing';
import { LessonStore } from '../state/lesson-store';
import { UiStore } from '../state/ui-store';
import { Keyboard, SHORTCUTS } from './keyboard';

function setup(d = branchyLesson(), branchId: string | null = null) {
  TestBed.configureTestingModule({ providers: appProviders({}) });
  learner();
  const store = TestBed.inject(LessonStore);
  openTree(store, d, branchId);
  const go = vi.spyOn(store, 'go').mockImplementation(() => undefined);
  const keyboard = TestBed.inject(Keyboard);
  const press = (key: string, init: KeyboardEventInit = {}) => {
    const e = new KeyboardEvent('keydown', { key, cancelable: true, ...init });
    keyboard.handle(e);
    return e;
  };
  return { store, go, ui: TestBed.inject(UiStore), press };
}

describe('Learn: keyboard', () => {
  it('Alt+arrows and [ ] move between side questions', () => {
    const k = setup(branchyLesson(), 'side');
    expect(k.press('ArrowUp', { altKey: true }).defaultPrevented).toBe(true);
    expect(k.go).toHaveBeenLastCalledWith('trunk', 'a1');
    k.press(']');
    expect(k.go).toHaveBeenLastCalledWith('deep', 'u3');
    k.press('ArrowLeft', { altKey: true });
    expect(k.go).toHaveBeenLastCalledWith('other', 'u4');
  });

  it('j and k move the mark along the messages', () => {
    const k = setup();
    k.press('j');
    expect(k.go).toHaveBeenLastCalledWith('trunk', 'u1', true);
  });

  it('Home and End go to the start and the end of the thread, but not while typing', () => {
    const k = setup();
    const ends = TestBed.inject(ThreadEnds);
    const toStart = vi.spyOn(ends, 'toStart').mockReturnValue(true);
    const toEnd = vi.spyOn(ends, 'toEnd').mockReturnValue(true);
    expect(k.press('Home').defaultPrevented).toBe(true);
    expect(toStart).toHaveBeenCalledTimes(1);
    expect(k.press('End').defaultPrevented).toBe(true);
    expect(toEnd).toHaveBeenCalledTimes(1);
    // In the message box they move the caret.
    const box = document.createElement('textarea');
    document.body.append(box);
    const typed = new KeyboardEvent('keydown', { key: 'End', cancelable: true });
    box.addEventListener('keydown', (e) => TestBed.inject(Keyboard).handle(e));
    box.dispatchEvent(typed);
    expect(typed.defaultPrevented).toBe(false);
    expect(toEnd).toHaveBeenCalledTimes(1);
    // With no thread on screen, the key stays the browser's.
    toEnd.mockReturnValue(false);
    expect(k.press('End').defaultPrevented).toBe(false);
  });

  it('b puts the focused reply on the message box, an earlier thread’s too, else the latest', () => {
    const k = setup(branchyLesson(), 'side');
    const composer = TestBed.inject(ComposerController);
    expect(k.press('b').defaultPrevented).toBe(true);
    expect(composer.lead()).toEqual({ nodeId: 'a2', quote: null });
    k.store.setRoute('t1', 'side', 'a1');
    k.press('b');
    expect(composer.lead()).toEqual({ nodeId: 'a1', quote: null });
  });

  it('b with no finished reply to put there leaves the key alone', () => {
    const streaming = detail(
      [
        node('u1', { role: 'user', content: 'What is light?' }),
        node('a1', { parentId: 'u1', seq: 1, status: 'streaming', content: '' }),
      ],
      [branch('trunk', { title: 'Main thread' })],
    );
    const k = setup(streaming);
    expect(k.press('b').defaultPrevented).toBe(false);
    expect(TestBed.inject(ComposerController).lead()).toBeNull();
  });

  it('? shows the shortcuts; behind a dialog the other keys wait', () => {
    const k = setup();
    k.press('?');
    expect(k.ui.dialogs.list()).toEqual([{ kind: 'shortcuts' }]);
    k.press('j');
    expect(k.go).not.toHaveBeenCalled();
  });

  it('the help lists Home and End, and b', () => {
    expect(SHORTCUTS).toContainEqual({ keys: ['Home', 'End'], label: 'Start / end of the thread' });
    expect(SHORTCUTS).toContainEqual({
      keys: ['b'],
      label: 'Put the focused (or latest) reply on the message box',
    });
  });

  it('the help lists how the message box sends: Enter with the filled button, Ctrl+Enter the other', () => {
    expect(SHORTCUTS).toContainEqual({
      keys: ['Enter'],
      label: 'Send with the filled button: a tangent on the main thread, Next inside a tangent',
    });
    expect(SHORTCUTS).toContainEqual({ keys: ['Ctrl+Enter'], label: 'Send with the other button' });
  });
});
