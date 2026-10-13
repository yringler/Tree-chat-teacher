import { TestBed } from '@angular/core/testing';
import { screen } from '@testing-library/dom';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '../testing';
import {
  AndroidAppBanner,
  androidAppBannerDue,
  AndroidAppNotice,
  onAndroid,
} from './android-app-banner';

const KEY = 'tangent.androidAppBanner';
const ANDROID_UA =
  'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36';
const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const IPHONE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';

describe('onAndroid', () => {
  it('is true for Android browsers only', () => {
    expect(onAndroid(ANDROID_UA)).toBe(true);
    expect(onAndroid('Mozilla/5.0 (Android 14; Mobile; rv:131.0) Gecko/131.0 Firefox/131.0')).toBe(
      true,
    );
    expect(onAndroid(DESKTOP_UA)).toBe(false);
    expect(onAndroid(IPHONE_UA)).toBe(false);
  });
});

describe('androidAppBannerDue', () => {
  it('shows from the second load until it is closed', () => {
    expect(androidAppBannerDue(null)).toBe(false);
    expect(androidAppBannerDue('seen')).toBe(true);
    expect(androidAppBannerDue('closed')).toBe(false);
    expect(androidAppBannerDue('garbled')).toBe(false);
  });
});

describe('AndroidAppBanner', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  /** Renders the banner in `placement` for a browser with `userAgent`, then tells it the caller's app. */
  async function show(
    opts: { userAgent?: string; appId?: string | null; placement?: 'learn' | 'power' } = {},
  ) {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(opts.userAgent ?? ANDROID_UA);
    const r = await render(AndroidAppBanner, {
      inputs: { placement: opts.placement ?? 'learn' },
    });
    const notice = TestBed.inject(AndroidAppNotice);
    notice.known(opts.appId === undefined ? 'com.example.app' : opts.appId);
    await r.fixture.whenStable();
    return notice;
  }

  it("waits for the second load on Android, then links the app's store page", async () => {
    const first = await show();
    expect(screen.queryByRole('note')).toBeNull();
    expect(first.holdsBannerSlot()).toBe(false);
    expect(localStorage.getItem(KEY)).toBe('seen');

    TestBed.resetTestingModule();
    await show();
    const link = screen.getByRole('link', { name: 'Get it on Google Play' });
    expect(link.getAttribute('href')).toBe(
      'https://play.google.com/store/apps/details?id=com.example.app&referrer=utm_source%3Dweb%26utm_medium%3Dlearn',
    );
    expect(screen.getByRole('note').textContent).toContain('Tangent is on Android');
  });

  it('tells power users the app is Learn, with their conversations', async () => {
    localStorage.setItem(KEY, 'seen');
    await show({ placement: 'power' });
    expect(screen.getByRole('note').textContent).toContain(
      'Your conversations are in the Android app too',
    );
    expect(screen.getByRole('link').getAttribute('href')).toContain('utm_medium%3Dpower');
  });

  it('closing it keeps it closed, and the beta notice comes back', async () => {
    localStorage.setItem(KEY, 'seen');
    const notice = await show();
    expect(notice.holdsBannerSlot()).toBe(true);
    await userEvent.click(screen.getByRole('button', { name: 'Close the Android app notice' }));
    expect(screen.queryByRole('note')).toBeNull();
    expect(notice.holdsBannerSlot()).toBe(false);
    expect(localStorage.getItem(KEY)).toBe('closed');

    TestBed.resetTestingModule();
    await show();
    expect(screen.queryByRole('note')).toBeNull();
  });

  it('following the link closes it too', async () => {
    localStorage.setItem(KEY, 'seen');
    await show();
    const link = screen.getByRole('link', { name: 'Get it on Google Play' });
    // The store page itself isn't opened in the test document.
    link.addEventListener('click', (e) => e.preventDefault());
    await userEvent.click(link);
    expect(screen.queryByRole('note')).toBeNull();
    expect(localStorage.getItem(KEY)).toBe('closed');
  });

  it('holds the beta notice back only until the caller shows the deployment has no app', async () => {
    localStorage.setItem(KEY, 'seen');
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(ANDROID_UA);
    await render(AndroidAppBanner, { inputs: { placement: 'learn' } });
    const notice = TestBed.inject(AndroidAppNotice);
    expect(notice.holdsBannerSlot()).toBe(true);
    notice.known(null);
    expect(notice.holdsBannerSlot()).toBe(false);
    expect(screen.queryByRole('note')).toBeNull();
  });

  it('never shows, and stores nothing, off Android or without an app', async () => {
    await show({ userAgent: DESKTOP_UA });
    TestBed.resetTestingModule();
    await show({ userAgent: IPHONE_UA });
    expect(localStorage.getItem(KEY)).toBeNull();
    TestBed.resetTestingModule();
    await show({ appId: null });
    expect(localStorage.getItem(KEY)).toBeNull();
    expect(screen.queryByRole('note')).toBeNull();
  });
});
