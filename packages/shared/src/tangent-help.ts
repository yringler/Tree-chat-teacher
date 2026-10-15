import { TRUNK_TITLE } from './domain.js';

/**
 * The words that teach when to reply and when to go on a tangent: the two
 * send actions, the "How tangents work" help and the first-run walkthrough,
 * and the ways to the two ends of a thread. One source for the landing page, the Angular help sheet and coach marks,
 * and the Flutter app, whose mirror (apps/flutter/lib/ui/tangent_help_copy.dart)
 * a web-shared test keeps identical, as tiers.ts does for the tier words.
 */

/** Sends the message as a new tangent: the recommended default. */
export const TANGENT_ACTION = {
  label: 'Tangent ↳',
  hint: 'Wait, what’s that? Explore on the side without derailing the lesson.',
} as const;

/** Sends the message as the next step of the thread on screen. */
export const REPLY_ACTION = {
  label: 'Next ➜',
  hint: 'Got it, what’s next? Keeps the main lesson moving.',
  /** Inside a tangent, Next continues that tangent rather than the lesson. */
  hintInTangent: 'Got it, what’s next? Keeps this tangent moving.',
} as const;

export const HELP_TITLE = 'How tangents work';

export const HELP_RULE = 'Reply = the next step. Tangent = a side trip.';

/** The two actions, as the help lists them (labels match the buttons). */
export const HELP_ITEMS: readonly { readonly label: string; readonly text: string }[] = [
  { label: REPLY_ACTION.label, text: '“Got it, what’s next?” Keeps the main lesson moving.' },
  {
    label: TANGENT_ACTION.label,
    text: '“Wait, what’s that?” or “Ooh, tell me more about that.” Explores on the side without derailing the lesson.',
  },
];

/** When in doubt: a wrong tangent is cheap, a wrong reply clutters the main thread. */
export const HELP_DEFAULT = {
  label: 'Not sure? Tangent.',
  text: 'You can always come back.',
} as const;

export const HELP_TEST =
  'If you read the main thread back later, would this belong in the story? If yes, reply. If it would interrupt, tangent.';

export const HELP_ANALOGY =
  'Replies are the next chapter. Tangents are footnotes, and here any footnote can grow into its own book without breaking the chapter you’re reading.';

export const HELP_REPLAY = 'Replay the walkthrough';

export const HELP_SHORTCUTS = 'Keyboard shortcuts';

/** The three coach marks, in order: go on a tangent, head back, reply. */
export const WALKTHROUGH_STEPS = {
  tangent: 'Anything confusing or interesting? Go on a tangent.',
  back: 'Tangents never clutter your main lesson. Head back anytime.',
  next: 'Ready to move on? Reply.',
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
