// The words that teach when to reply and when to go on a tangent: the two
// send actions, the "How tangents work" help, the first-run walkthrough and
// the headings of a reply's tangents footer.
//
// This mirrors packages/shared/src/tangent-help.ts and the footer headings of
// packages/shared/src/tangents.ts, which the landing page and the web apps
// use; packages/web-shared/src/tangent-help-parity.spec.ts checks that
// every string there appears here verbatim, so the two change together.

/// Sends the message as a new tangent: the recommended default.
const tangentAction = (
  label: 'Tangent ↳',
  hint: 'Wait, what’s that? Explore on the side without derailing the lesson.',
);

/// Sends the message as the next step of the thread on screen. Inside a
/// tangent, Next continues that tangent rather than the lesson.
const replyAction = (
  label: 'Next ➜',
  hint: 'Got it, what’s next? Keeps the main lesson moving.',
  hintInTangent: 'Got it, what’s next? Keeps this tangent moving.',
);

const helpTitle = 'How tangents work';

const helpRule = 'Reply = the next step. Tangent = a side trip.';

/// The two actions, as the help lists them (labels match the buttons).
const helpItems = [
  (
    label: 'Next ➜',
    text: '“Got it, what’s next?” Keeps the main lesson moving.',
  ),
  (
    label: 'Tangent ↳',
    text: '“Wait, what’s that?” or “Ooh, tell me more about that.” Explores on the side without derailing the lesson.',
  ),
];

/// When in doubt: a wrong tangent is cheap, a wrong reply clutters the main
/// thread.
const helpDefault = (
  label: 'Not sure? Tangent.',
  text: 'You can always come back.',
);

const helpTest =
    'If you read the main thread back later, would this belong in the story? If yes, reply. If it would interrupt, tangent.';

const helpAnalogy =
    'Replies are the next chapter. Tangents are footnotes, and here any footnote can grow into its own book without breaking the chapter you’re reading.';

const helpReplay = 'Replay the walkthrough';

const helpShortcuts = 'Keyboard shortcuts';

/// The three coach marks, in order: go on a tangent, head back, reply.
const walkthroughSteps = (
  tangent: 'Anything confusing or interesting? Go on a tangent.',
  back: 'Tangents never clutter your main lesson. Head back anytime.',
  next: 'Ready to move on? Reply.',
);

const walkthroughButtons = (next: 'Got it', skip: 'Skip tour', done: 'Done');

/// The control that leaves a tangent for the trunk, named as the trunk is.
const mainThreadLabel = 'Main thread';

const mainThreadBack = 'Back to main thread';

/// The heading over a reply's suggestions that continue the thread.
const keepGoingLabel = 'Keep going';

/// The heading over the tangents started from a reply, shown first.
const yourTangentsLabel = 'Your tangents';

/// The heading over a reply's suggested tangents that no tangent follows yet.
const suggestedTangentsLabel = 'Suggested tangents';
