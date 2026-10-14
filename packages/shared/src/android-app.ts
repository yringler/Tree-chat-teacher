/** Where a link to the Android app sits, reported to Play Console as the install's `utm_medium`. */
export type AndroidAppPlacement = 'learn' | 'power' | 'landing';

/**
 * The Android app's Play Store page. On a phone the Play Store app opens it
 * (showing Open when the app is installed); on a computer it is the store's
 * web page, which installs on the visitor's phone. The `referrer` lets Play
 * Console's acquisition report count installs by placement.
 */
export function androidAppStoreUrl(appId: string, placement: AndroidAppPlacement): string {
  const referrer = `utm_source=web&utm_medium=${placement}`;
  return `https://play.google.com/store/apps/details?id=${encodeURIComponent(appId)}&referrer=${encodeURIComponent(referrer)}`;
}
