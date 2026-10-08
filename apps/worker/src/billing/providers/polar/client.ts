// The Polar SDK client (`@polar-sh/sdk` v1, API version 2026-10 pinned by the
// import path; bump it about every 6 months).
import { createPolar, type Polar } from '@polar-sh/sdk/2026-10';
import type { PolarConfig } from './config.js';

/** Seconds per API call; the SDK's default of 5 is too short for checkout creation. */
const POLAR_TIMEOUT_SECONDS = 15;

// One client per token and server per isolate (the client holds no request state).
const clients = new Map<string, Polar>();

export function getPolar(config: Pick<PolarConfig, 'accessToken' | 'server'>): Polar {
  const key = `${config.server}:${config.accessToken}`;
  let client = clients.get(key);
  if (!client) {
    client = createPolar({
      accessToken: config.accessToken,
      environment: config.server,
      timeout: POLAR_TIMEOUT_SECONDS,
    });
    clients.set(key, client);
  }
  return client;
}
