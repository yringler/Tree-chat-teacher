import type { ApplicationConfig } from '@angular/core';
import { bootstrapApplication } from '@angular/platform-browser';
import { appConfig } from './app/app.config';
import { App } from './app/app';
import { isDemoPath } from './app/demo/demo-mode';

/**
 * `/learn/demo/...` runs the same app over an in-browser backend. Its code
 * (the ChatService, the lorem generator) is a separate chunk loaded only there.
 */
async function config(): Promise<ApplicationConfig> {
  if (!isDemoPath(location.pathname)) return appConfig;
  const { demoProviders } = await import('./app/demo/demo-providers');
  return { ...appConfig, providers: [...appConfig.providers, ...demoProviders()] };
}

config()
  .then((c) => bootstrapApplication(App, c))
  .catch((err) => console.error(err));
