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
    help: 'Sends everything the parent branch had at the branch point, then this branch.',
    longHelp:
      'Full path: the model sees everything the parent branch had at the branch point, then this branch',
  },
  summary: {
    label: 'Summary',
    abbr: 'sum',
    help: 'Sends a generated summary of the parent context (focused on the quote), then this branch.',
    longHelp: 'Summary: the model sees a generated summary of the parent context, then this branch',
  },
  message: {
    label: 'Parent message',
    abbr: 'msg',
    help: 'Sends only the message you branched from and the anchor quote, no other earlier messages.',
    longHelp:
      'Parent message: the model sees only the message this branch starts from, the quote and this branch',
  },
  independent: {
    label: 'Independent',
    abbr: 'ind',
    help: 'Starts fresh: only the system prompt and the anchor quote, no earlier messages.',
    longHelp: 'Independent: the model sees only the system prompt, the quote and this branch',
  },
};
