import '@angular/compiler'; // JIT: the component metadata and the DI below.
import { ElementRef, Injector, runInInjectionContext } from '@angular/core';
import { Router } from '@angular/router';
import { ApiClient, AuthService, DEMO_MODE, SAVE_FILE, ToastStore } from '@tangent/web-shared';
import { describe, expect, it, vi } from 'vitest';
import { AccountStore } from '../state/account-store';
import { LessonStore } from '../state/lesson-store';
import { PaymentStore } from '../state/payment-store';
import { UiStore } from '../state/ui-store';
import { AppHeader } from './app-header';

describe('Learn header: signing out', () => {
  it('forgets the message left unsent before the session ends', async () => {
    const order: string[] = [];
    const auth = { signOut: vi.fn(async () => void order.push('signOut')) };
    const injector = Injector.create({
      providers: [
        { provide: LessonStore },
        { provide: AccountStore },
        { provide: PaymentStore },
        { provide: UiStore },
        { provide: ToastStore },
        { provide: ApiClient, useValue: {} },
        { provide: Router, useValue: { navigate: vi.fn(async () => true) } },
        { provide: SAVE_FILE, useValue: vi.fn() },
        { provide: AuthService, useValue: auth },
        { provide: ElementRef, useValue: new ElementRef({}) },
        { provide: DEMO_MODE, useValue: false },
      ],
    });
    const lessons = injector.get(LessonStore);
    vi.spyOn(lessons, 'forgetUnsent').mockImplementation(() => void order.push('forget'));
    const header = runInInjectionContext(injector, () => new AppHeader());
    await header['signOut']();
    expect(order).toEqual(['forget', 'signOut']);
  });
});
