import { Component, signal } from '@angular/core';
import { screen, within } from '@testing-library/dom';
import userEvent from '@testing-library/user-event';
import { REPLY_ACTION, type Branch, type Tangent } from '@tangent/shared';
import { describe, expect, it, vi } from 'vitest';
import { branch, render } from '../testing';
import { SuggestionGroups } from './suggestion-groups';

const SUGGESTED: readonly Tangent[] = [
  { kind: 'continue', title: 'Diffraction', why: 'what a slit does to it next' },
  { kind: 'tangent', title: 'Interference', why: 'why two waves add up' },
  { kind: 'tangent', title: 'Photons', why: 'the particle side' },
];

/** A tangent following the "Photons" suggestion, and one asked in the user's own words. */
const PHOTONS = branch('b-photons', { title: 'Photons' });
const OWN = branch('b-own', { title: 'Why is the sky blue', anchorQuote: 'the sky' });

/** The footer, with `send` and `open` spies that settle when `settle` is called. */
async function groups(inputs: Record<string, unknown> = {}) {
  let settle = (): void => undefined;
  const pending = () =>
    new Promise<void>((resolve) => {
      settle = resolve;
    });
  const send = vi.fn(pending);
  const open = vi.fn(pending);
  const openBranch = vi.fn();
  const r = await render(SuggestionGroups, {
    inputs: { tangents: SUGGESTED, latest: true, send, open, openBranch, ...inputs },
  });
  return { ...r, send, open, openBranch, settle: () => settle(), user: userEvent.setup() };
}

const group = (name: string) => within(screen.getByRole('group', { name }));
const step = () => group('Keep going').getByRole<HTMLButtonElement>('button', { name: /^Diff/ });
const offer = (title: string) =>
  screen.getByRole<HTMLButtonElement>('button', { name: new RegExp(`^Start a tangent: ${title}`) });
const yours = (title: string) =>
  screen.getByRole<HTMLButtonElement>('button', { name: `Open tangent: ${title}` });
const fold = () => screen.getByRole<HTMLButtonElement>('button', { expanded: false });

describe('SuggestionGroups: before the user has a tangent here', () => {
  it('Keep going, then every suggested tangent, open, each one to start', async () => {
    await groups();
    expect(screen.queryByRole('group', { name: 'Your tangents' })).toBeNull();
    expect(group('Keep going').getAllByRole('button')).toHaveLength(1);
    expect(group('Suggested tangents').getAllByRole('button')).toHaveLength(2);
    group('Suggested tangents').getByRole('button', {
      name: 'Start a tangent: Photons the particle side',
    });
    expect(screen.queryByRole('button', { expanded: false })).toBeNull();
  });

  it('only the newest reply offers Keep going', async () => {
    await groups({ latest: false });
    expect(screen.queryByRole('group', { name: 'Keep going' })).toBeNull();
    group('Suggested tangents').getByRole('button', { name: /^Start a tangent: Interference/ });
  });

  it('with nothing to offer, shows nothing', async () => {
    const g = await groups({ tangents: [] });
    expect(g.host.textContent?.trim()).toBe('');
  });

  it('labels each group, without a landmark per message', async () => {
    await groups({ children: [OWN] });
    expect(screen.queryAllByRole('navigation')).toEqual([]);
    expect(screen.getAllByRole('group').map((g) => g.getAttribute('aria-labelledby'))).toEqual([
      expect.stringMatching(/^your-tangents-/),
      expect.stringMatching(/^keep-going-/),
      expect.stringMatching(/^suggested-tangents-/),
    ]);
  });
});

describe('SuggestionGroups: Keep going', () => {
  it('keeps the main thread moving, or inside a tangent, that tangent', async () => {
    const g = await groups();
    expect(step().title).toBe(REPLY_ACTION.hint);
    await g.set({ inTangent: true });
    expect(step().title).toBe(REPLY_ACTION.hintInTangent);
  });

  it('sends a step once, until the send settles', async () => {
    const g = await groups();
    await g.user.click(step());
    expect(g.send).toHaveBeenCalledWith('Diffraction');
    expect(step().disabled).toBe(true);
    await g.user.click(step());
    expect(g.send).toHaveBeenCalledTimes(1);
    g.settle();
    await vi.waitFor(() => expect(step().disabled).toBe(false));
  });

  it('waits while something else is generating', async () => {
    await groups({ busy: true });
    expect(step().disabled).toBe(true);
  });
});

describe('SuggestionGroups: suggested tangents', () => {
  it('starts one tangent at a time', async () => {
    const g = await groups();
    await g.user.click(offer('Photons'));
    expect(g.open).toHaveBeenCalledWith('Photons');
    expect(offer('Interference').disabled).toBe(true);
    g.settle();
    await vi.waitFor(() => expect(offer('Interference').disabled).toBe(false));
  });

  it('fold behind one button once the reply has a tangent of the user’s', async () => {
    const g = await groups({ children: [OWN] });
    const button = fold();
    expect(button.textContent?.trim()).toBe('2 suggested tangents');
    const list = document.getElementById(button.getAttribute('aria-controls') ?? '');
    expect(list?.hidden).toBe(true);
    expect(screen.queryByRole('button', { name: /^Start a tangent/ })).toBeNull();
    // The group keeps its name while folded; only the button shows.
    screen.getByRole('group', { name: 'Suggested tangents' });
    expect(screen.getByText('Suggested tangents').classList).toContain('sr-only');

    await g.user.click(button);
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(list?.hidden).toBe(false);
    expect(screen.getByText('Suggested tangents').classList).not.toContain('sr-only');
    offer('Interference');
    offer('Photons');

    await g.user.click(button);
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('button', { name: /^Start a tangent/ })).toBeNull();
  });

  it('a followed suggestion leaves them: the button says how many more there are', async () => {
    const g = await groups({ children: [PHOTONS] });
    expect(fold().textContent?.trim()).toBe('1 more suggested');
    await g.user.click(fold());
    offer('Interference');
    expect(screen.queryByRole('button', { name: /^Start a tangent: Photons/ })).toBeNull();
  });

  it('locked: folded even without a tangent, saying why in the thread’s own word', async () => {
    const g = await groups({ locked: true, noun: 'lane' });
    expect(step().disabled).toBe(true);
    expect(step().title).toBe('Continuing needs a membership (this lane is on your own key)');
    const why = 'Starting a tangent needs a membership (this lane is on your own key)';
    expect(fold().title).toBe(why);
    await g.user.click(fold());
    expect(offer('Interference').disabled).toBe(true);
    expect(offer('Interference').title).toBe(why);
  });
});

describe('SuggestionGroups: your tangents', () => {
  it('come first, in order, whether they follow a suggestion or not; each opens', async () => {
    const g = await groups({ children: [OWN, PHOTONS] });
    const rows = group('Your tangents').getAllByRole('button');
    expect(rows.map((b) => b.textContent?.trim())).toEqual([
      'Open tangent: Why is the sky blue',
      'Open tangent: Photons',
    ]);
    const labels = [...g.host.querySelectorAll('.tangents-group-label:not(.sr-only)')].map((l) =>
      l.textContent?.trim(),
    );
    expect(labels).toEqual(['Your tangents', 'Keep going']);
    await g.user.click(yours('Photons'));
    expect(g.openBranch).toHaveBeenCalledWith(PHOTONS);
    expect(g.open).not.toHaveBeenCalled();
  });

  it('a tooltip of its quote, else the suggestion’s reason, else its title as the app shows it', async () => {
    const plain = branch('b-plain', { title: 'Tangent: Colour' });
    const g = await groups({
      children: [OWN, PHOTONS, plain],
      titleOf: (b: Branch) => b.title.replace('Tangent: ', ''),
    });
    const described = (title: string, description: string) =>
      screen.getByRole('button', { name: `Open tangent: ${title}`, description });
    described('Why is the sky blue', 'the sky');
    described('Photons', 'the particle side');
    // The title alone is no description: a screen reader would read it twice.
    const colour = described('Colour', '');
    expect(colour.querySelector('[title]')?.getAttribute('title')).toBe('Colour');
    expect(yours('Photons').querySelector('[title]')).toBeNull();

    await g.set({ compact: true });
    described('Why is the sky blue', 'the sky');
    expect(described('Colour', '').querySelector('[title]')?.getAttribute('title')).toBe('Colour');
  });

  it('show for any message, with no suggestions at all', async () => {
    await groups({ tangents: [], children: [OWN] });
    yours('Why is the sky blue');
    expect(screen.getAllByRole('group')).toHaveLength(1);
  });

  it('one on the selected branch’s chain is lit and current', async () => {
    await groups({ children: [OWN, PHOTONS], chainIds: new Set(['trunk', 'b-photons']) });
    expect(yours('Photons').getAttribute('aria-current')).toBe('true');
    expect(yours('Photons').closest('.tangent-yours')?.classList).toContain('is-on');
    expect(yours('Why is the sky blue').getAttribute('aria-current')).toBeNull();
  });

  it('open while the reply is locked', async () => {
    await groups({ locked: true, children: [PHOTONS] });
    expect(yours('Photons').disabled).toBe(false);
  });

  it('a trash button only where the app deletes from here; it asks the app', async () => {
    const g = await groups({ children: [OWN] });
    expect(screen.queryByRole('button', { name: /^Delete/ })).toBeNull();
    const remove = vi.fn(() => Promise.resolve(true));
    await g.set({ remove });
    await g.user.click(
      screen.getByRole('button', { name: 'Delete the tangent Why is the sky blue' }),
    );
    expect(remove).toHaveBeenCalledWith(OWN);
    expect(g.openBranch).not.toHaveBeenCalled();
  });

  it('compact: chips edged in their context mode, lit on the chain', async () => {
    const g = await groups({
      compact: true,
      children: [OWN, branch('b-sum', { title: 'Sum', contextMode: 'summary' })],
      chainIds: new Set(['b-sum']),
    });
    const chip = yours('Sum');
    expect(chip.classList).toContain('tangent-chip');
    expect(chip.classList).toContain('mode-chip-summary');
    expect(chip.classList).toContain('is-on');
    expect(chip.getAttribute('aria-current')).toBe('true');
    await g.user.click(yours('Why is the sky blue'));
    expect(g.openBranch).toHaveBeenCalledWith(OWN);
  });
});

/** An app's footer: "Ask your own" projected, and its details on each of the user's tangents. */
@Component({
  imports: [SuggestionGroups],
  template: `
    <app-suggestion-groups
      [tangents]="tangents"
      [children]="children()"
      [withAsk]="true"
      [send]="settled"
      [open]="settled"
      [openBranch]="opened"
      [rowExtra]="extra"
    >
      <textarea aria-label="Ask your own"></textarea>
    </app-suggestion-groups>
    <ng-template #extra let-b
      ><span class="mode">{{ b.contextMode }}</span></ng-template
    >
  `,
})
class AppFooter {
  readonly tangents = SUGGESTED;
  readonly children = signal<readonly Branch[]>([OWN]);
  readonly settled = () => Promise.resolve();
  readonly opened = (): void => undefined;
}

describe('SuggestionGroups in an app', () => {
  it('"Ask your own" stays in view while the suggestions are folded', async () => {
    await render(AppFooter);
    fold();
    group('Suggested tangents').getByRole('textbox', { name: 'Ask your own' });
  });

  it('with every suggestion followed, "Ask your own" still shows', async () => {
    const r = await render(AppFooter);
    r.component.children.set([OWN, PHOTONS, branch('b-int', { title: 'Interference' })]);
    await r.fixture.whenStable();
    expect(screen.queryByRole('button', { expanded: false })).toBeNull();
    group('Suggested tangents').getByRole('textbox', { name: 'Ask your own' });
  });

  it('ends each of the user’s tangents with the app’s details', async () => {
    await render(AppFooter);
    const row = screen.getByRole('button', { name: 'Open tangent: Why is the sky blue path' });
    expect(row.querySelector('.mode')?.textContent).toBe('path');
  });
});
