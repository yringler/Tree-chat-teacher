import { TestBed } from '@angular/core/testing';
import { type AppSettings, DEFAULT_SETTINGS, SettingsStore } from './settings-store';

/** Specs: the account's settings as if loaded, the defaults but for `over`. */
export function loadSettings(over: Partial<AppSettings> = {}): SettingsStore {
  const store = TestBed.inject(SettingsStore);
  store.settings.set({ ...DEFAULT_SETTINGS, ...over });
  store.loaded.set(true);
  return store;
}
