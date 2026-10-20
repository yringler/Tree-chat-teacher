import type { ContextMode } from '@tangent/shared';

/** How the apps name and explain a branch's context mode. */
export interface ContextModeMeta {
  /** "Full path". */
  label: string;
  /** The badge's short form ("path"). */
  abbr: string;
  /** One line for a picker, under the label. */
  help: string;
  /** What the model sees, for a badge's tooltip. */
  longHelp: string;
}

export const CONTEXT_MODE_META: Readonly<Record<ContextMode, ContextModeMeta>> = {
  path: {
    label: 'Full path',
    abbr: 'path',
    help: 'Sends everything the parent thread had where the tangent started, then this tangent.',
    longHelp:
      'Full path: the model sees everything the parent thread had where the tangent started, then this tangent',
  },
  summary: {
    label: 'Summary',
    abbr: 'sum',
    help: 'Sends a generated summary of the parent context (focused on the quote), then this tangent.',
    longHelp:
      'Summary: the model sees a generated summary of the parent context, then this tangent',
  },
  message: {
    label: 'Parent message',
    abbr: 'msg',
    help: 'Sends only the message the tangent started from and the quote, no other earlier messages.',
    longHelp:
      'Parent message: the model sees only the message this tangent starts from, the quote and this tangent',
  },
  independent: {
    label: 'Independent',
    abbr: 'ind',
    help: 'Starts fresh: only the system prompt and the quote, no earlier messages.',
    longHelp: 'Independent: the model sees only the system prompt, the quote and this tangent',
  },
};
