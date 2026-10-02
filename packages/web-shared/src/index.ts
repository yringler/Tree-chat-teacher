/*
 * @tangent/web-shared: Angular code shared by the power app (apps/web) and
 * the simple app (apps/simple). Consumed as TS source (exports ./src/index.ts);
 * each app's Angular builder compiles it. Styles: src/styles/base.css
 * (`@tangent/web-shared/styles/base.css`).
 */

// Core services
export {
  ApiClient,
  ApiError,
  errorMessage,
  isPaymentRequired,
  type ExportParams,
} from './core/api-client';
export { API_FETCH, API_HEADERS, defaultApiFetch } from './core/api-fetch';
export { APP_PATHS, provideAppPaths, type AppPaths } from './core/app-paths';
export {
  AUTH_CLIENT,
  authErrorMessage,
  createTangentAuthClient,
  type TangentAuthClient,
} from './core/auth-client';
export { AuthService, loginErrorMessage, type PasskeyInfo, type SocialProvider } from './core/auth';
export {
  absoluteUrl,
  BillingClient,
  BillingError,
  type BillingSubscription,
} from './core/billing-client';
export { DEMO_BASES, DEMO_MODE, isDemoPath } from './core/demo';
export { MarkdownService } from './core/markdown.service';

// Server-sent events
export {
  isTerminal,
  parseReviewEvent,
  parseStreamEvent,
  readSseEvents,
  readStreamEvents,
  SseParser,
  type SseFrame,
} from './sse/sse-parser';
export {
  defaultSleep,
  runStream,
  type StreamOutcome,
  type StreamRunnerDeps,
  type StreamRunOptions,
} from './sse/stream-runner';

// UI
export { Icon, type IconName } from './ui/icon';
export { Modal } from './ui/modal';
export { ModeSwitch } from './ui/mode-switch';
export { Turnstile } from './ui/turnstile';
export { LoginPage } from './login/login-page';
