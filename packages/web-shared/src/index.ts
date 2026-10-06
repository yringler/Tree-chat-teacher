/*
 * @tangent/web-shared: Angular code shared by the power app (apps/web), the
 * simple app (apps/simple) and the canvas (apps/canvas). Consumed as TS
 * source (exports ./src/index.ts); each app's Angular builder compiles it.
 * Styles: src/styles/base.css (`@tangent/web-shared/styles/base.css`).
 */

// Core services
export {
  ApiClient,
  ApiError,
  errorMessage,
  isMembershipRequired,
  isPaymentRequired,
  isPoolCapReached,
  isPoolConsentRequired,
  isPoolEmpty,
  isPoolUnavailable,
  type ExportParams,
} from './core/api-client';
export { API_FETCH, API_HEADERS, defaultApiFetch } from './core/api-fetch';
export {
  backupFile,
  MAX_BACKUP_BYTES,
  readBackupFile,
  SAVE_FILE,
  type BackupFile,
  type SaveFile,
} from './core/backup-file';
export { APP_PATHS, provideAppPaths, type AppPaths } from './core/app-paths';
export { LEAVE_PAGE, type LeavePage } from './core/leave-page';
export {
  AUTH_CLIENT,
  authErrorMessage,
  createTangentAuthClient,
  type TangentAuthClient,
} from './core/auth-client';
export { AuthService, loginErrorMessage, type PasskeyInfo, type SocialProvider } from './core/auth';
export { BillingClient, BillingError } from './core/billing-client';
export {
  accountModeOf,
  APP_BASES,
  DEMO_BASES,
  DEMO_MODE,
  isDemoPath,
  type AppId,
} from './core/demo';
export { MarkdownService } from './core/markdown.service';
export { deleteBranchQuestion, subtreeSize, type BranchNoun } from './core/delete-branch';
export {
  DEFAULT_TEXT_SIZE,
  parseTextSize,
  provideTextSize,
  TEXT_SIZE_STEPS,
  TEXT_SIZE_STORAGE_KEY,
  TextSizeStore,
} from './core/text-size-store';

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
export { Logo } from './ui/logo';
export { Modal } from './ui/modal';
export { DEEP_BRANCH_DEPTH, SourcesList } from './ui/sources-list';
export { TangentAsk } from './ui/tangent-ask';
export { TextSizeMenu } from './ui/text-size-menu';
export {
  MAX_QUOTE,
  PendingQuote,
  SelectionAsk,
  selectedMessageQuote,
  type MessageQuote,
} from './ui/selection-ask';
export { ModeSwitch } from './ui/mode-switch';
export { Turnstile } from './ui/turnstile';
export { LoginPage } from './login/login-page';
export { AccountId } from './account/account-id';
export { DeleteAccount } from './account/delete-account';

// Billing: the shared billing page, the membership gate and their helpers
export { BillingPage } from './billing/billing-page';
export { BILLING_SUMMARY_LISTENER } from './billing/billing-listener';
export { MembershipGate } from './billing/membership-gate';
export { MembershipCodeForm } from './billing/membership-code-form';
export { ReadOnlyComposer } from './billing/read-only-composer';
export {
  LearnCopy,
  learnLessonHref,
  lockedFundings,
  readOnlyText,
  routeLocked,
  routeOpen,
  type ReadOnlyText,
} from './billing/read-only';
export {
  creditCanPay,
  creditCarriesOn,
  creditFeeText,
  includedCreditText,
  membershipBlocks,
  membershipPriceText,
  membershipStatusText,
  subscribeToMembership,
} from './billing/membership';
export {
  formatBps,
  formatCents,
  formatCharge,
  formatMicros,
  parseDollarsToCents,
} from './billing/format';

// The community pool: the meter, the billing page's section, the inline empty/cap states and the first-use check
export { PoolMeter } from './pool/pool-meter';
export { PoolSection } from './pool/pool-section';
export { ImpactFeed, loadLatestImpact } from './pool/impact-feed';
export { PoolBlockNotice } from './pool/pool-block-notice';
export { PoolFirstUseDialog, poolVerifyHref } from './pool/pool-first-use-dialog';
export {
  poolBlockOf,
  poolBlockText,
  poolDollarsLabel,
  poolWeekLabel,
  sessionsLabel,
  untilText,
  type PoolBlock,
  type PoolBlockText,
} from './pool/pool-format';
