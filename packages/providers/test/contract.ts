// The provider stream contract (`ProviderEvent` in @tangent/shared) as checks on what a
// real stream did: the live contract suite (apps/worker/test/live) runs them against real
// endpoints, and recorded.test.ts against the responses it recorded, through the same
// adapters. Pure: no I/O, no clock. Nothing here reads a reply's text, which a model may
// word any way it likes; only its shape and its numbers.
import {
  isLengthStop,
  type Citation,
  type ProviderError,
  type ProviderErrorCode,
  type ProviderEvent,
  type ProviderUpstream,
  type ProviderUsage,
} from '@tangent/shared';

/** The last `billing` fields, folded like the meter folds them (later fields override). */
export interface BillingSummary {
  generationId?: string;
  costUsd?: number;
  webSearches?: number;
  servedBy?: string;
}

export type StreamTerminal =
  { type: 'done'; stopReason: string | null } | { type: 'error'; error: ProviderError };

/** What one provider stream showed, folded from its events in order. */
export interface StreamSummary {
  /** The reply's text (for its length only: never asserted on). */
  text: string;
  deltas: number;
  /** `usage` events folded field by field, later values overriding earlier ones. */
  usage: Partial<ProviderUsage>;
  usageEvents: number;
  billing: BillingSummary;
  /** The last `citations` event's list (each carries the full list so far). */
  citations: Citation[];
  /** `activity` events (a web search started). */
  searchActivity: number;
  terminal: StreamTerminal | null;
  /** Breaches of the event order: a missing or repeated terminal, events after it. */
  violations: string[];
}

export function foldStream(events: readonly ProviderEvent[]): StreamSummary {
  const summary: StreamSummary = {
    text: '',
    deltas: 0,
    usage: {},
    usageEvents: 0,
    billing: {},
    citations: [],
    searchActivity: 0,
    terminal: null,
    violations: [],
  };
  events.forEach((event, i) => {
    if (summary.terminal !== null) {
      summary.violations.push(`event ${i} (${event.type}) after the terminal event`);
      return;
    }
    switch (event.type) {
      case 'delta':
        summary.text += event.text;
        summary.deltas++;
        break;
      case 'usage':
        summary.usage = { ...summary.usage, ...definedFields(event.usage) };
        summary.usageEvents++;
        break;
      case 'billing': {
        const { type: _type, ...fields } = event;
        summary.billing = { ...summary.billing, ...definedFields(fields) };
        break;
      }
      case 'citations':
        summary.citations = event.citations;
        break;
      case 'activity':
        summary.searchActivity++;
        break;
      case 'done':
        summary.terminal = { type: 'done', stopReason: event.stopReason };
        break;
      case 'error':
        summary.terminal = { type: 'error', error: event.error };
        break;
    }
  });
  if (summary.terminal === null) summary.violations.push('no terminal event');
  return summary;
}

function definedFields<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

/**
 * What a scenario expects of its stream; plain JSON, so a recorded fixture
 * carries the expectation it was recorded under.
 */
export interface ContractExpectation {
  outcome: 'success' | 'error';
  /** `length`: cut off at the output cap; `natural`: any other stop. Absent = either. */
  stop?: 'length' | 'natural';
  /** A web search was required with this many uses at most. */
  search?: { maxUses: number };
  /** The error's code, how far the call got, its HTTP status (each only when given). */
  error?: { code?: ProviderErrorCode; upstream?: ProviderUpstream; status?: number };
  /**
   * `openrouter`: a success reports its cost and a `gen-` generation id;
   * `none`: a direct provider reports neither (Anthropic and OpenAI bill by tokens).
   */
  costReport?: 'openrouter' | 'none';
}

export interface ContractResult {
  /** Assumptions the code relies on that the stream broke. */
  failures: string[];
  /** Worth a look, not a breach (a missing upstream name, an empty search). */
  warnings: string[];
}

const TOKEN_FIELDS = [
  'inputTokens',
  'outputTokens',
  'cacheReadTokens',
  'cacheWriteTokens',
  'reasoningTokens',
] as const satisfies readonly (keyof ProviderUsage)[];

/**
 * Checks `summary` against the stream contract and `expected`. `secrets`
 * (the keys the call ran with) must appear in no error message.
 */
export function checkContract(
  summary: StreamSummary,
  expected: ContractExpectation,
  secrets: readonly string[] = [],
): ContractResult {
  const failures = [...summary.violations];
  const warnings: string[] = [];
  const { usage, billing, terminal } = summary;

  for (const field of TOKEN_FIELDS) {
    const n = usage[field];
    if (n !== undefined && !(Number.isSafeInteger(n) && n >= 0))
      failures.push(`usage.${field} is ${n}, not a non-negative integer`);
  }
  const input = usage.inputTokens ?? 0;
  const cached = (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
  if (cached > input)
    failures.push(`cache read + write (${cached}) exceed the input tokens (${input})`);
  if ((usage.reasoningTokens ?? 0) > (usage.outputTokens ?? 0))
    failures.push(
      `reasoning tokens (${usage.reasoningTokens}) exceed the output tokens (${usage.outputTokens ?? 0})`,
    );
  if (billing.costUsd !== undefined && !(Number.isFinite(billing.costUsd) && billing.costUsd >= 0))
    failures.push(`billing.costUsd is ${billing.costUsd}`);

  if (expected.outcome === 'success') {
    if (terminal?.type !== 'done') {
      failures.push(`expected done, got ${describeTerminal(terminal)}`);
    } else {
      if (expected.stop === 'length' && !isLengthStop(terminal.stopReason))
        failures.push(`expected a length stop, got ${terminal.stopReason}`);
      if (expected.stop === 'natural' && isLengthStop(terminal.stopReason))
        failures.push(`expected a natural stop, got ${terminal.stopReason}`);
    }
    // A reply cut off while it was still thinking has no text; the cap is the scenario's.
    if (summary.deltas === 0 && expected.stop !== 'length') failures.push('no text deltas');
    if (usage.inputTokens === undefined || usage.outputTokens === undefined)
      failures.push('no input and output token counts');
  } else if (terminal?.type !== 'error') {
    failures.push(`expected an error, got ${describeTerminal(terminal)}`);
  } else {
    const { error } = terminal;
    const want = expected.error ?? {};
    if (want.code !== undefined && error.code !== want.code)
      failures.push(`error code ${error.code}, expected ${want.code} (${error.message})`);
    if (want.upstream !== undefined && error.upstream !== want.upstream)
      failures.push(`error upstream ${error.upstream}, expected ${want.upstream}`);
    if (want.status !== undefined && error.status !== want.status)
      failures.push(`error status ${error.status}, expected ${want.status}`);
    for (const secret of secrets)
      if (secret.length >= 4 && error.message.includes(secret))
        failures.push('the error message contains the key');
  }

  if (expected.search) {
    const searches = billing.webSearches;
    if (searches === undefined) failures.push('no web search count reported');
    else if (searches < 1 || searches > expected.search.maxUses)
      failures.push(`${searches} web searches, expected 1 to ${expected.search.maxUses}`);
    const https = summary.citations.filter((c) => c.url.startsWith('https://'));
    if (https.length === 0) failures.push('no https citation');
  }

  if (expected.costReport === 'openrouter' && expected.outcome === 'success') {
    if (billing.costUsd === undefined) failures.push('no reported cost');
    if (!billing.generationId?.startsWith('gen-'))
      failures.push(`generation id ${billing.generationId ?? 'missing'}, expected gen-…`);
    if (billing.servedBy === undefined) warnings.push('no upstream provider named (servedBy)');
  }
  if (expected.costReport === 'none') {
    if (billing.costUsd !== undefined)
      failures.push(`a direct provider reported a cost (${billing.costUsd})`);
    if (billing.generationId !== undefined)
      failures.push(`a direct provider reported a generation id (${billing.generationId})`);
  }
  return { failures, warnings };
}

function describeTerminal(terminal: StreamTerminal | null): string {
  if (terminal === null) return 'no terminal event';
  if (terminal.type === 'done') return `done (${terminal.stopReason})`;
  return `error ${terminal.error.code} (${terminal.error.message})`;
}
