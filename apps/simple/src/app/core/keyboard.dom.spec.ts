import { TestBed } from '@angular/core/testing';
import { appProviders, branch, detail, node, openTree } from '@tangent/web-shared/testing';
import { describe, expect, it, vi } from 'vitest';
import { branchyLesson, learner } from '../learn.testing';
import { LessonStore } from '../state/lesson-store';
import { UiStore } from '../state/ui-store';
import { Keyboard } from './keyboard';

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

  it('m opens the map only when the lesson has side questions', () => {
    const one = detail([node('u1', { role: 'user' })], [branch('trunk')]);
    const k = setup(one);
    expect(k.press('m').defaultPrevented).toBe(false);
    expect(k.ui.dialogs.list()).toEqual([]);
    TestBed.resetTestingModule();
    const k2 = setup();
    k2.press('m');
    expect(k2.ui.dialogs.list()).toEqual([{ kind: 'map' }]);
  });

  it('? shows the shortcuts; behind a dialog the other keys wait', () => {
    const k = setup();
    k.press('?');
    expect(k.ui.dialogs.list()).toEqual([{ kind: 'shortcuts' }]);
    k.press('j');
    expect(k.go).not.toHaveBeenCalled();
  });
});
