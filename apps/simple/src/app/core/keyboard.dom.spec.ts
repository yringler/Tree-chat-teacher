import { TestBed } from '@angular/core/testing';
import { ThreadEnds } from '@tangent/web-shared';
import { appProviders, openTree } from '@tangent/web-shared/testing';
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

  it('? shows the shortcuts; behind a dialog the other keys wait', () => {
    const k = setup();
    k.press('?');
    expect(k.ui.dialogs.list()).toEqual([{ kind: 'shortcuts' }]);
    k.press('j');
    expect(k.go).not.toHaveBeenCalled();
  });

  it('the help lists Home and End', () => {
    expect(SHORTCUTS).toContainEqual({ keys: ['Home', 'End'], label: 'Start / end of the thread' });
  });

  it('the help lists how the message box sends: Enter as a tangent, Ctrl+Enter as Next', () => {
    expect(SHORTCUTS).toContainEqual({ keys: ['Enter'], label: 'Send as a tangent' });
    expect(SHORTCUTS).toContainEqual({ keys: ['Ctrl+Enter'], label: 'Send as Next' });
  });
});
