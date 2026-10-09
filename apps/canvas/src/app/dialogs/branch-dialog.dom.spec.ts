import { TestBed } from '@angular/core/testing';
import {
  CONTEXT_MODES,
  type BillingSummary,
  type MembershipInfo,
  type PoolStatusResponse,
  type ProviderInfo,
} from '@tangent/shared';
import {
  branch,
  detail,
  me,
  membership,
  node,
  openTree,
  powerProviders,
  provider,
  render,
} from '@tangent/web-shared/testing';
import { screen } from '@testing-library/dom';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { CanvasStore } from '../state/canvas-store';
import { UiStore } from '../state/ui-store';
import { BranchDialog } from './branch-dialog';

const ownKey = provider({ models: [{ id: 'vendor/listed', label: 'Listed' }] });
const credit: ProviderInfo = {
  ...ownKey,
  label: 'Tangent credit',
  defaultModel: 'vendor/default',
  acceptsUserKey: false,
  keySource: 'server',
  funding: 'credit',
};

/**
 * "Branch from here" on reply a1 of an own-key trunk on `vendor/x`, for a
 * user whose membership is `status`, offered `providers`, signed in as the
 * canvas does it (the provider list, the keys, the credit balance and the pool).
 */
async function open(status: MembershipInfo['status'], providers: ProviderInfo[]) {
  const api = {
    providers: vi.fn(async () => providers),
    listTrees: vi.fn(async () => []),
    keyStatus: vi.fn(async () => ({ enabled: true, hasKey: false, providers: [] })),
    billing: vi.fn(async () => ({ availableMicros: 2_000_000 }) as BillingSummary),
    poolStatus: vi.fn(async () => ({ enabled: false }) as PoolStatusResponse),
  };
  const r = await render(BranchDialog, {
    providers: powerProviders(CanvasStore, api),
    setup: async () => {
      const store = TestBed.inject(CanvasStore);
      await store.init(me({ builtInCredit: true, membership: membership({ status }) }));
      openTree(
        store,
        detail(
          [node('a1', { content: 'A wave.', providerId: 'openrouter', model: 'vendor/x' })],
          [branch('trunk', { model: 'vendor/x' })],
        ),
      );
      TestBed.inject(UiStore).dialogs.open({ kind: 'branch', fromNodeId: 'a1', quote: null });
    },
    inputs: { state: { fromNodeId: 'a1', quote: null } },
  });
  const store = TestBed.inject(CanvasStore);
  const fanOut = vi.spyOn(store, 'fanOut').mockResolvedValue([branch('new')]);
  return { ...r, store, fanOut, ui: TestBed.inject(UiStore), user: userEvent.setup() };
}

/** Lane `n`'s route and model, as the dialog shows them. */
function lane(n: number) {
  const route = screen.getByRole<HTMLSelectElement>('combobox', { name: `Provider of lane ${n}` });
  const model = screen.getByRole<HTMLInputElement>('textbox', { name: `Model of lane ${n}` });
  return { route: route.selectedOptions[0]?.textContent?.trim(), model: model.value };
}

describe('Canvas branch dialog: the route a new lane starts on', () => {
  it('a usable parent lane: its own route and model', async () => {
    await open('active', [ownKey, credit]);
    expect(lane(1)).toEqual({ route: 'OpenRouter', model: 'vendor/x' });
  });

  it('a parent lane locked by the membership: Tangent credit, keeping a model it serves', async () => {
    const d = await open('inactive', [ownKey, credit]);
    expect(lane(1)).toEqual({ route: 'Tangent credit', model: 'vendor/x' });
    // The locked route can't be picked.
    const own = screen
      .getByRole('combobox', { name: 'Provider of lane 1' })
      .querySelector<HTMLOptionElement>('option[value="openrouter"]')!;
    expect(own.disabled).toBe(true);
    await d.user.click(screen.getByRole('button', { name: 'Open the lane' }));
    expect(d.fanOut).toHaveBeenCalledWith(
      expect.objectContaining({
        variants: [
          { contextMode: 'path', providerId: 'openrouter', funding: 'credit', model: 'vendor/x' },
        ],
      }),
    );
  });

  it('a parent lane whose own key is missing here: the default route', async () => {
    await open('active', [{ ...ownKey, available: false, keySource: null }, credit]);
    expect(lane(1).route).toBe('Tangent credit');
  });
});

describe('Canvas branch dialog: several lanes at once', () => {
  it('adds variants, every context mode, and asks each the starting message', async () => {
    const d = await open('active', [ownKey, credit]);
    await d.user.click(screen.getByRole('button', { name: 'Every context mode' }));
    const rows = screen.getAllByRole('combobox', { name: /^Context of lane/ });
    expect(rows.map((s) => (s as HTMLSelectElement).value)).toEqual([...CONTEXT_MODES]);
    expect(
      screen.getByRole<HTMLButtonElement>('button', { name: 'Every context mode' }).disabled,
    ).toBe(true);
    await d.user.type(screen.getByRole('textbox', { name: /Starting message/ }), 'Why?');
    await d.user.click(
      screen.getByRole('button', { name: `Ask in ${CONTEXT_MODES.length} lanes` }),
    );
    expect(d.fanOut).toHaveBeenCalledWith(
      expect.objectContaining({ fromNodeId: 'a1', firstMessage: 'Why?' }),
    );
    expect(d.fanOut.mock.calls[0]![0].variants).toHaveLength(CONTEXT_MODES.length);
    expect(d.ui.dialogs.get('branch')).toBeNull();
  });

  it('one lane can’t be removed; another can', async () => {
    const d = await open('active', [ownKey, credit]);
    const [only] = screen.getAllByRole<HTMLButtonElement>('button', { name: 'Remove this lane' });
    expect(only!.disabled).toBe(true);
    await d.user.click(screen.getByRole('button', { name: 'Add a variant' }));
    await d.user.click(screen.getAllByRole('button', { name: 'Remove this lane' })[1]!);
    expect(screen.getAllByRole('button', { name: 'Remove this lane' })).toHaveLength(1);
  });
});
