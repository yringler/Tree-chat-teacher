import type { ApplicationConfig } from '@angular/core';
import { bootstrapApplication } from '@angular/platform-browser';
import { isDemoPath } from '@tangent/web-shared';
import { appConfig } from './app/app.config';
import { App } from './app/app';

/**
 * `/canvas/demo/...` runs the same app over an in-browser backend (the power
 * demo's account). Its code is a separate chunk loaded only there.
 */
async function config(): Promise<ApplicationConfig> {
  if (!isDemoPath(location.pathname, 'canvas')) return appConfig;
  const { demoProviders } = await import('@tangent/web-shared/demo');
  return { ...appConfig, providers: [...appConfig.providers, ...demoProviders('canvas')] };
}

config()
  .then((c) => bootstrapApplication(App, c))
  .catch((err) => console.error(err));
