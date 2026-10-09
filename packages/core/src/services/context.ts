import type { Repositories } from '../repository.js';
import type { Ownership } from './ownership.js';
import type { RouteResolver } from './routing.js';
import type { ChatSettings } from './settings.js';

/** What every part of ChatService works with: one account's storage, routes, clock and log. */
export interface ServiceContext {
  readonly repos: Repositories;
  readonly accountId: string;
  readonly owned: Ownership;
  readonly routes: RouteResolver;
  readonly settings: ChatSettings;
  /** Built-in system prompt of new trees (`ChatServiceDeps.defaultSystemPrompt`). */
  readonly defaultSystemPrompt: string | null;
  now(): string;
  newId(): string;
  /** `ChatServiceDeps.log`: failures the service recovers from on its own. */
  log(event: string, fields: Record<string, unknown>): void;
}

/** A caught error as a log field: its message (an `Error` serializes as `{}`). */
export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function emptyToNull(value: string | null | undefined): string | null {
  return value === undefined || value === null || value.trim() === '' ? null : value;
}
