import type { Child } from 'hono/jsx';

/**
 * The landing page's demo: one "Why is the sky blue?" conversation, first in
 * a regular chat that tangles, then, after the visitor presses the gate's
 * button, the same questions asked in Tangent, one step at a time, ending on
 * chips that open any branch. It runs on CSS alone (LANDING_STYLE's `.dm`
 * rules): a checkbox switches the halves and radio chips pick a branch.
 * Answers are placeholder bars, so the only words are the questions, the
 * phrase each follow-up came from, and the captions.
 *
 * Tangent shows one branch at a time: the message a side question came from,
 * dimmed, then the side question. That is Learn's and power mode's view, so
 * the demo never shows Canvas's lanes.
 */

type Branch = 1 | 2 | 3 | 4;
type Mood = 'glad' | 'ok' | 'meh' | 'sad';
type Width = 30 | 45 | 60 | 75 | 90;
type Step = 1 | 2 | 3;

const CHIPS: Record<Branch, string> = {
  1: 'Main',
  2: '↳ Rayleigh',
  3: '↳ 1/λ⁴',
  4: '↳ Violet',
};

const MOUTHS: Record<Mood, string> = {
  glad: 'M7.5 13.5q4.5 4.5 9 0',
  ok: 'M8.5 14.5q3.5 2 7 0',
  meh: 'M8.5 15h7',
  sad: 'M8 16.5q4-4 8 0',
};

function Face(props: { mood: Mood }) {
  const low = props.mood === 'meh' || props.mood === 'sad';
  return (
    <svg width="28" height="28" viewBox="0 0 24 24" aria-hidden="true">
      <circle class={low ? 'face low' : 'face'} cx="12" cy="12" r="10.5" />
      <circle class="face-eye" cx="8.6" cy="9.6" r="1.2" />
      <circle class="face-eye" cx="15.4" cy="9.6" r="1.2" />
      <path class="face-line" d={MOUTHS[props.mood]} />
    </svg>
  );
}

/** A caption with the learner's face: over the regular chat, under a Tangent branch. */
function Caption(props: { mood: Mood; note?: boolean; children: Child }) {
  const body = (
    <>
      <Face mood={props.mood} />
      <span>{props.children}</span>
    </>
  );
  return props.note ? <p class="dm-note">{body}</p> : <li class="dm-cap">{body}</li>;
}

function classes(...names: (string | false | undefined)[]): string {
  return names.filter(Boolean).join(' ');
}

/** A line of an answer's text, as a placeholder bar. */
function Bar(props: { w: Width }) {
  return <span class={`sk w${props.w}`} />;
}

/** The phrase in an answer a follow-up came from, in its branch's colour; `tap` is the one being asked about. */
function Phrase(props: { b: Branch; tap?: Branch; children: Child }) {
  return (
    <mark class={classes(`b${props.b}`, props.tap === props.b && 'tap')}>{props.children}</mark>
  );
}

function Question(props: { b: Branch; n?: Step; children: Child }) {
  return (
    <p class={classes('dm-msg q', `b${props.b}`, props.n && `n${props.n}`)}>{props.children}</p>
  );
}

function Answer(props: { b: Branch; n?: Step; from?: boolean; children: Child }) {
  return (
    <p
      class={classes('dm-msg a', `b${props.b}`, props.n && `n${props.n}`, props.from && 'dm-from')}
    >
      {props.children}
    </p>
  );
}

/** The answers, by the branch they open; `tap` pulses the phrase about to be asked about. */
const ANSWERS: Record<Branch | 5, (p: { tap?: Branch }) => Child> = {
  1: (p) => (
    <>
      <Bar w={90} />
      <Bar w={45} />
      <Phrase b={2} tap={p.tap}>
        Rayleigh scattering
      </Phrase>{' '}
      <Bar w={75} />
      <Bar w={30} />
      <Phrase b={4} tap={p.tap}>
        violet
      </Phrase>
    </>
  ),
  2: (p) => (
    <>
      <Bar w={90} />
      <Bar w={30} />
      <Phrase b={3} tap={p.tap}>
        1/λ⁴
      </Phrase>{' '}
      <Bar w={75} />
    </>
  ),
  3: () => (
    <>
      <Bar w={90} />
      <Bar w={60} />
    </>
  ),
  4: () => (
    <>
      <Bar w={90} />
      <Bar w={75} />
      <Bar w={45} />
    </>
  ),
  5: () => (
    <>
      <Bar w={90} />
      <Bar w={60} />
    </>
  ),
};

const QUESTIONS: Record<Branch | 5, string> = {
  1: 'Why is the sky blue?',
  2: 'What’s Rayleigh scattering?',
  3: 'What does 1/λ⁴ mean?',
  4: 'Why isn’t the sky violet?',
  5: 'And why are sunsets orange?',
};

/** Where each side question starts: the answer it came from, and the phrase. */
const FORKS: Record<2 | 3 | 4, { from: Branch; phrase: string }> = {
  2: { from: 1, phrase: 'Rayleigh scattering' },
  3: { from: 2, phrase: '1/λ⁴' },
  4: { from: 1, phrase: 'violet' },
};

/** A side question's branch: the answer it came from (dimmed), the divider, then its own messages. */
function SideBranch(props: { b: 2 | 3 | 4; animate?: boolean; children?: Child }) {
  const { from, phrase } = FORKS[props.b];
  const step = (n: Step) => (props.animate ? n : undefined);
  return (
    <>
      <Answer b={from} from>
        {ANSWERS[from]({ tap: props.animate ? props.b : undefined })}
      </Answer>
      <p class={classes('dm-fork', props.animate && 'n1')}>Side question · {phrase}</p>
      <Question b={props.b} n={step(2)}>
        {QUESTIONS[props.b]}
      </Question>
      <Answer b={props.b} n={step(3)}>
        {ANSWERS[props.b]({})}
      </Answer>
      {props.children}
    </>
  );
}

/** The main question's branch: its answer and how many side questions it has, then the follow-up once asked. */
function MainBranch(props: { sides: 0 | 1 | 2; sunsets: boolean; animate?: Step[] }) {
  const [q, a] = props.animate ?? [];
  return (
    <>
      <Question b={1} n={props.sunsets ? undefined : q}>
        {QUESTIONS[1]}
      </Question>
      <Answer b={1} n={props.sunsets ? undefined : a}>
        {ANSWERS[1]({})}
      </Answer>
      {props.sides > 0 && (
        <p class="dm-forks">
          {props.sides === 1 ? '1 side question' : `${props.sides} side questions`}
        </p>
      )}
      {props.sunsets && (
        <>
          <Question b={1} n={q}>
            {QUESTIONS[5]}
          </Question>
          <Answer b={1} n={a}>
            {ANSWERS[5]({})}
          </Answer>
        </>
      )}
    </>
  );
}

/** One step of the Tangent replay: the branches opened so far, the one shown, and its caption. */
function Scene(props: {
  n: number;
  open: Branch;
  on: Branch;
  pop?: Branch;
  children: Child;
  caption: string;
}) {
  const shown = ([1, 2, 3, 4] as const).filter((b) => b <= props.open);
  return (
    <div class={`dm-scene sc${props.n}`}>
      <div class="dm-chips">
        {shown.map((b) => (
          <span class={classes('chip', `b${b}`, b === props.on && 'on', b === props.pop && 'pop')}>
            {CHIPS[b]}
          </span>
        ))}
      </div>
      <div class="dm-pane">
        {props.children}
        <Caption mood="glad" note>
          {props.caption}
        </Caption>
      </div>
    </div>
  );
}

/** The demo window, with the checkbox that switches it to Tangent ahead of it. */
export function LandingDemo() {
  return (
    <div class="dm-wrap">
      <input
        type="checkbox"
        id="dm-solve"
        class="dm-solve sr-only"
        aria-label="Solve it with Tangent: the same questions, asked in Tangent"
      />
      <figure class="dm" aria-label="The same questions in a regular AI chat, then in Tangent">
        <div class="dm-bar">
          <span class="dm-title">
            <span class="dm-t1">A regular AI chat</span>
            <span class="dm-t2">Tangent</span>
          </span>
          <label for="dm-solve" class="dm-replay">
            Replay
          </label>
        </div>
        <div class="dm-tangle">
          <div class="dm-chat">
            <Question b={1}>{QUESTIONS[1]}</Question>
            <Answer b={1}>{ANSWERS[1]({})}</Answer>
            <Question b={2}>{QUESTIONS[2]}</Question>
            <Answer b={2}>{ANSWERS[2]({})}</Answer>
            <Question b={3}>{QUESTIONS[3]}</Question>
            <Answer b={3}>{ANSWERS[3]({})}</Answer>
            <Question b={4}>Wait, why isn’t the sky violet?</Question>
            <Answer b={4}>{ANSWERS[4]({})}</Answer>
            <Question b={1}>{QUESTIONS[5]}</Question>
            <Answer b={1}>{ANSWERS[5]({})}</Answer>
          </div>
          <ol class="dm-caps">
            <Caption mood="glad">You ask one question.</Caption>
            <Caption mood="glad">The answer raises another. You ask it.</Caption>
            <Caption mood="ok">Its answer raises one more.</Caption>
            <Caption mood="ok">Wait, the first answer said violet…</Caption>
            <Caption mood="meh">Your first answer is now 8 messages up.</Caption>
            <Caption mood="sad">Scrolling back past what you already know…</Caption>
            <Caption mood="sad">Now nobody could reread this. Including you.</Caption>
          </ol>
          <div class="dm-gate">
            <label for="dm-solve" class="dm-go">
              Solve it with Tangent
            </label>
            <small>Same questions, asked in Tangent</small>
          </div>
        </div>
        <div class="dm-solved">
          <div class="dm-play" aria-hidden="true">
            <Scene n={1} open={1} on={1} caption="Same first question, in Tangent.">
              <MainBranch sides={0} sunsets={false} animate={[1, 2]} />
            </Scene>
            <Scene n={2} open={2} on={2} pop={2} caption="A side question opens its own branch.">
              <SideBranch b={2} animate />
            </Scene>
            <Scene n={3} open={3} on={3} pop={3} caption="And a side question of that one.">
              <SideBranch b={3} animate />
            </Scene>
            <Scene n={4} open={3} on={1} caption="Back to the lesson. Nothing moved.">
              <MainBranch sides={1} sunsets={false} />
            </Scene>
            <Scene n={5} open={4} on={4} pop={4} caption="Violet gets a branch of its own.">
              <SideBranch b={4} animate />
            </Scene>
            <Scene n={6} open={4} on={1} caption="The lesson goes on, nothing in the way.">
              <MainBranch sides={2} sunsets animate={[1, 2]} />
            </Scene>
          </div>
          <div class="dm-live">
            <div class="dm-chips" role="radiogroup" aria-label="Branches">
              {([1, 2, 3, 4] as const).map((b) => (
                <>
                  <input
                    type="radio"
                    name="dm-branch"
                    id={`dm-b${b}`}
                    class="dm-pick sr-only"
                    checked={b === 1}
                  />
                  <label for={`dm-b${b}`} class={`chip b${b}`}>
                    {CHIPS[b]}
                  </label>
                </>
              ))}
            </div>
            <div class="dm-pane p1">
              <MainBranch sides={2} sunsets />
              <Caption mood="glad" note>
                Tap any branch to open it.
              </Caption>
            </div>
            <div class="dm-pane p2">
              <SideBranch b={2}>
                <p class="dm-forks">1 side question</p>
              </SideBranch>
              <Caption mood="glad" note>
                Each question gets its own branch.
              </Caption>
            </div>
            <div class="dm-pane p3">
              <SideBranch b={3} />
              <Caption mood="glad" note>
                A branch of a branch. Still easy to find.
              </Caption>
            </div>
            <div class="dm-pane p4">
              <SideBranch b={4} />
              <Caption mood="glad" note>
                Just violet. Nothing else in the way.
              </Caption>
            </div>
          </div>
        </div>
      </figure>
    </div>
  );
}
