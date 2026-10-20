import { TRUNK_TITLE } from './domain.js';

/**
 * The words that teach going on tangents, and the plain reply beside them:
 * the two send actions, the "How tangents work" help and the first-run walkthrough,
 * and the ways to the two ends of a thread. One source for the landing page, the Angular help sheet and coach marks,
 * and the Flutter app, whose mirror (apps/flutter/lib/ui/tangent_help_copy.dart)
 * a web-shared test keeps identical, as tiers.ts does for the tier words.
 */

/** Sends the message as a new tangent: the default on the main thread. */
export const TANGENT_ACTION = {
  label: 'Tangent ↳',
  hint: 'Wait, tell me more about that. Explore in a tangent without derailing the lesson.',
} as const;

/**
 * Sends the message as the next one in the thread on screen, as any chat
 * would: the default inside a tangent.
 */
export const REPLY_ACTION = {
  label: 'Next ➜',
  hint: 'Good old-fashioned AI chat: continues the main lesson.',
  /** Inside a tangent, Next continues that tangent rather than the lesson. */
  hintInTangent: 'Good old-fashioned AI chat: continues this tangent.',
} as const;

export const HELP_TITLE = 'How tangents work';

export const HELP_RULE = 'Tangents are how you explore. Next is a plain reply.';

/** The two actions, tangents first, as the help lists them (labels match the buttons). */
export const HELP_ITEMS: readonly { readonly label: string; readonly text: string }[] = [
  {
    label: TANGENT_ACTION.label,
    text: '“Wait, tell me more about that” or “Hey, what about…?” Explores in its own thread without derailing the lesson. The suggestions under a reply are tangents too: Dig deeper goes further in, Suggested tangents go off to the side.',
  },
  {
    label: REPLY_ACTION.label,
    text: 'Good old-fashioned AI chat, here if you want it. Inside a tangent it’s the default, so the tangent goes on.',
  },
];

/** When in doubt on the main thread: a wrong tangent is cheap, a wrong reply clutters it. */
export const HELP_DEFAULT = {
  label: 'Not sure? Tangent.',
  text: 'On the main thread that’s the default, and you can always come back.',
} as const;

export const HELP_ANALOGY =
  'Tangents are footnotes, and here any footnote can grow into its own book without breaking the chapter you’re reading.';

export const HELP_REPLAY = 'Replay the walkthrough';

export const HELP_SHORTCUTS = 'Keyboard shortcuts';

/** The three coach marks, in order: go on a tangent, head back, reply. */
export const WALKTHROUGH_STEPS = {
  tangent: 'Anything confusing or interesting? Go on a tangent.',
  back: 'Tangents never clutter your main lesson. Head back anytime.',
  next: 'Or just reply, like any AI chat.',
} as const;

export const WALKTHROUGH_BUTTONS = { next: 'Got it', skip: 'Skip tour', done: 'Done' } as const;

/** The control that leaves a tangent for the trunk, named as the trunk is. */
export const MAIN_THREAD_LABEL = TRUNK_TITLE;

export const MAIN_THREAD_BACK = 'Back to main thread';

/**
 * The ways to the two ends of a thread: the button that shows while the end
 * is far below, and what the title and a tangent's current step in its path
 * do when clicked or tapped (their tooltips).
 */
export const THREAD_ENDS = {
  toEnd: 'Jump to the end',
  toStart: 'Back to the start',
  toTangentStart: 'Back to the start of this tangent',
} as const;
