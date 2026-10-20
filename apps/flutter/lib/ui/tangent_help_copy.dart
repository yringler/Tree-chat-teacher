// The words that teach going on tangents, and the plain reply beside them:
// the two send actions, the "How tangents work" help, the first-run walkthrough, the
// headings of a reply's tangents footer and the ways to the two ends of a
// thread.
//
// This mirrors packages/shared/src/tangent-help.ts and the footer headings of
// packages/shared/src/tangents.ts, which the landing page and the web apps
// use; packages/web-shared/src/tangent-help-parity.spec.ts checks that
// every string there appears here verbatim, so the two change together.

/// Sends the message as a new tangent: the default on the main thread.
const tangentAction = (
  label: 'Tangent ↳',
  hint: 'Wait, tell me more about that. Explore in a tangent without derailing the lesson.',
);

/// Sends the message as the next one in the thread on screen, as any chat
/// would: the default inside a tangent, where it continues that tangent
/// rather than the lesson.
const replyAction = (
  label: 'Next ➜',
  hint: 'Good old-fashioned AI chat: continues the main lesson.',
  hintInTangent: 'Good old-fashioned AI chat: continues this tangent.',
);

const helpTitle = 'How tangents work';

const helpRule = 'Tangents are how you explore. Next is a plain reply.';

/// The two actions, tangents first, as the help lists them (labels match
/// the buttons).
const helpItems = [
  (
    label: 'Tangent ↳',
    text: '“Wait, tell me more about that” or “Hey, what about…?” Explores in its own thread without derailing the lesson. The suggestions under a reply are tangents too: Dig deeper goes further in, Suggested tangents go off to the side.',
  ),
  (
    label: 'Next ➜',
    text: 'Good old-fashioned AI chat, here if you want it. Inside a tangent it’s the default, so the tangent goes on.',
  ),
];

/// When in doubt on the main thread: a wrong tangent is cheap, a wrong reply
/// clutters it.
const helpDefault = (
  label: 'Not sure? Tangent.',
  text: 'On the main thread that’s the default, and you can always come back.',
);

const helpAnalogy =
    'Tangents are footnotes, and here any footnote can grow into its own book without breaking the chapter you’re reading.';

const helpReplay = 'Replay the walkthrough';

const helpShortcuts = 'Keyboard shortcuts';

/// The three coach marks, in order: go on a tangent, head back, reply.
const walkthroughSteps = (
  tangent: 'Anything confusing or interesting? Go on a tangent.',
  back: 'Tangents never clutter your main lesson. Head back anytime.',
  next: 'Or just reply, like any AI chat.',
);

const walkthroughButtons = (next: 'Got it', skip: 'Skip tour', done: 'Done');

/// The control that leaves a tangent for the trunk, named as the trunk is.
const mainThreadLabel = 'Main thread';

const mainThreadBack = 'Back to main thread';

/// The heading over the tangents started from a reply, shown first.
const yourTangentsLabel = 'Your tangents';

/// The heading over a reply's deeper suggestions that no tangent follows
/// yet, shown before its suggested tangents.
const digDeeperLabel = 'Dig deeper';

/// The heading over a reply's suggested tangents that no tangent follows yet.
const suggestedTangentsLabel = 'Suggested tangents';

// The ways to the two ends of a thread.

/// The button that appears above the message box while the end of the
/// thread is far below.
const jumpToEnd = 'Jump to the end';

/// The lesson title's tooltip: a tap scrolls to the start of the thread.
const backToStart = 'Back to the start';

/// The tooltip of a tangent's current step in its path: a tap scrolls to
/// the tangent's first message.
const backToTangentStart = 'Back to the start of this tangent';
