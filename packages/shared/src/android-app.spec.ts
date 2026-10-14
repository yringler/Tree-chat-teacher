import { describe, expect, it } from 'vitest';
import { androidAppStoreUrl } from './android-app.js';

describe('androidAppStoreUrl', () => {
  it("opens the app's Play Store page, tagged with where the link sits", () => {
    const url = new URL(androidAppStoreUrl('com.example.app', 'learn'));
    expect(url.origin + url.pathname).toBe('https://play.google.com/store/apps/details');
    expect(url.searchParams.get('id')).toBe('com.example.app');
    expect(url.searchParams.get('referrer')).toBe('utm_source=web&utm_medium=learn');
  });
});
