#!/usr/bin/env node
/**
 * Model eval for Tangent's hosted tiers (dev only; never part of the build).
 * Asks every question of a questions file under every config, through
 * OpenRouter, with Tangent's tutor prompt (DEFAULT_SYSTEM_PROMPT), and records
 * per answer: the text, finish reason, the provider that served it, prompt /
 * cached / completion / reasoning tokens, billed cost and latency. Reasoning
 * text is never stored, only its token count. Multi-turn
 * items replay a branch path (a tree of turns) so cache hits show from the
 * second turn on. Then writes a side-by-side Markdown report for grading.
 *
 * Node >= 22.18 runs it directly (type stripping), no build step:
 *
 *   OPENROUTER_API_KEY=… node scripts/model-eval/eval.ts run \
 *     --questions scripts/model-eval/sample-questions.json \
 *     --configs scripts/model-eval/sample-configs.json --out /tmp/model-eval [--dry-run]
 *   node scripts/model-eval/eval.ts report --questions … --configs … --out /tmp/model-eval \
 *     [--blind] [--grades grades.json]
 *
 * `run` options: --only <labels,…> (configs), --items <ids,…>, --subset <tag>,
 * --concurrency <n> (default 4), --max-cost <usd> (stop starting calls once
 * this run has spent it), --assume-output <tokens> (dry-run estimate, default
 * 2500), --force (redo answers already in results.jsonl; failed ones are
 * always retried).
 *
 * Output (in --out): results.jsonl (one CallResult per line, appended, so a
 * rerun resumes), results.json, report.md, and with --blind report-blind.md
 * plus blind-key.json. Keep real conversations and outputs out of the repo.
 *
 * Repeat runs (to measure variance): run the same configs into separate --out
 * directories. A pinned provider your account's data policy excludes (e.g.
 * "deepseek" with paid-training providers off) fails with 404 "No endpoints
 * found", recorded as an error and retried on the next run.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { DEFAULT_SYSTEM_PROMPT } from '../../packages/shared/src/default-prompt.ts';
import { HttpError, requestBody, streamCompletion } from './openrouter.ts';
import { buildMessages, type PathStep } from './prompt.ts';
import { renderReport, resultId, type Grade } from './report.ts';
import type { CallResult, EvalConfig, QuestionFile, QuestionItem, TurnSpec } from './types.ts';

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    questions: { type: 'string' },
    configs: { type: 'string' },
    out: { type: 'string' },
    only: { type: 'string' },
    items: { type: 'string' },
    subset: { type: 'string' },
    concurrency: { type: 'string', default: '4' },
    'max-cost': { type: 'string' },
    'assume-output': { type: 'string', default: '2500' },
    'dry-run': { type: 'boolean', default: false },
    force: { type: 'boolean', default: false },
    blind: { type: 'boolean', default: false },
    grades: { type: 'string' },
    title: { type: 'string', default: 'Tangent model eval' },
  },
});

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

const command = positionals[0];
if (command !== 'run' && command !== 'report')
  fail(
    'Usage: eval.ts run|report --questions <file> --configs <file> --out <dir> (see the header)',
  );
if (!values.questions || !values.configs || !values.out)
  fail('--questions, --configs and --out are required');

const questionFile = JSON.parse(readFileSync(values.questions, 'utf8')) as QuestionFile;
const systemPrompt = questionFile.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
const allConfigs = JSON.parse(readFileSync(values.configs, 'utf8')) as EvalConfig[];
const outDir = resolve(values.out);
mkdirSync(outDir, { recursive: true });
const resultsPath = join(outDir, 'results.jsonl');

const onlyConfigs = values.only?.split(',').map((s) => s.trim());
const configs = onlyConfigs ? allConfigs.filter((c) => onlyConfigs.includes(c.label)) : allConfigs;
if (configs.length === 0) fail('No configs selected');
const onlyItems = values.items?.split(',').map((s) => s.trim());
const items = questionFile.items.filter(
  (i) =>
    (!onlyItems || onlyItems.includes(i.id)) && (!values.subset || i.tags?.includes(values.subset)),
);

/** The latest result per id (later lines win, so a retry replaces a failure). */
function loadResults(): Map<string, CallResult> {
  const map = new Map<string, CallResult>();
  if (!existsSync(resultsPath)) return map;
  for (const line of readFileSync(resultsPath, 'utf8').split('\n')) {
    if (line.trim() === '') continue;
    const r = JSON.parse(line) as CallResult;
    map.set(resultId(r), r);
  }
  return map;
}

function turnsOf(item: QuestionItem): readonly TurnSpec[] {
  if (item.turns) return item.turns;
  if (item.question === undefined) fail(`Item ${item.id} has neither question nor turns`);
  return [{ id: 'q', question: item.question }];
}

/** Root-first path of turns ending at `turn`. */
function pathTo(turns: readonly TurnSpec[], turn: TurnSpec): TurnSpec[] {
  const byId = new Map(turns.map((t) => [t.id, t]));
  const path: TurnSpec[] = [turn];
  let parent = turn.parent;
  while (parent !== undefined) {
    const p = byId.get(parent);
    if (!p) fail(`Turn ${turn.id} names unknown parent ${parent}`);
    path.unshift(p);
    parent = p.parent;
  }
  return path;
}

function appliesTo(config: EvalConfig, item: QuestionItem): boolean {
  return !config.subset || (item.tags?.includes(config.subset) ?? false);
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function report(): Promise<void> {
  const results = [...loadResults().values()];
  const grades: Record<string, Grade> = values.grades
    ? (JSON.parse(readFileSync(values.grades, 'utf8')) as Record<string, Grade>)
    : {};
  const full = renderReport(items, configs, results, grades, {
    title: values.title,
    blind: false,
  });
  writeFileSync(join(outDir, 'report.md'), full.markdown);
  writeFileSync(join(outDir, 'results.json'), JSON.stringify(results, null, 1));
  console.log(`Wrote ${join(outDir, 'report.md')}`);
  if (values.blind) {
    const blind = renderReport(
      items,
      configs,
      results,
      {},
      {
        title: `${values.title} (blind)`,
        blind: true,
      },
    );
    writeFileSync(join(outDir, 'report-blind.md'), blind.markdown);
    writeFileSync(join(outDir, 'blind-key.json'), JSON.stringify(blind.key, null, 1));
    console.log(`Wrote ${join(outDir, 'report-blind.md')} and blind-key.json`);
  }
}

interface Price {
  input: number;
  output: number;
}

/** $/token of the first pinned provider, else the model's listed price. */
async function priceOf(config: EvalConfig): Promise<Price | null> {
  try {
    const res = await fetch(`https://openrouter.ai/api/v1/models/${config.model}/endpoints`);
    const j = (await res.json()) as {
      data?: { endpoints?: { tag?: string; pricing?: { prompt?: string; completion?: string } }[] };
    };
    const eps = j.data?.endpoints ?? [];
    const tag = config.providerOrder?.[0];
    const ep = (tag && eps.find((e) => e.tag === tag || e.tag?.split('/')[0] === tag)) || eps[0];
    if (!ep?.pricing) return null;
    return { input: Number(ep.pricing.prompt), output: Number(ep.pricing.completion) };
  } catch {
    return null;
  }
}

async function run(): Promise<void> {
  const apiKey = process.env['OPENROUTER_API_KEY'];
  const done = loadResults();
  interface Unit {
    config: EvalConfig;
    item: QuestionItem;
    turns: readonly TurnSpec[];
  }
  const units: Unit[] = [];
  // Interleaved by item so concurrent calls spread over providers.
  for (const item of items)
    for (const config of configs)
      if (appliesTo(config, item)) units.push({ config, item, turns: turnsOf(item) });
  const pending = (u: Unit, t: TurnSpec): boolean => {
    const prior = done.get(resultId({ config: u.config.label, key: `${u.item.id}#${t.id}` }));
    return values.force || !prior || prior.error !== null;
  };
  const calls = units.flatMap((u) => u.turns.filter((t) => pending(u, t)).map((t) => ({ u, t })));

  if (values['dry-run']) {
    const assumeOut = Number(values['assume-output']);
    let total = 0;
    for (const config of configs) {
      const mine = calls.filter((c) => c.u.config === config);
      const price = await priceOf(config);
      const inTokens = mine.reduce((a, { u, t }) => {
        const chars =
          systemPrompt.length +
          pathTo(u.turns, t).reduce(
            (s, p) =>
              s +
              p.question.length +
              (p.anchor?.length ?? 0) +
              (p === t ? 0 : (p.assistant?.length ?? 6000)),
            0,
          );
        return a + chars / 3.5;
      }, 0);
      const est = price ? inTokens * price.input + mine.length * assumeOut * price.output : NaN;
      total += Number.isNaN(est) ? 0 : est;
      console.log(
        `${config.label.padEnd(28)} ${String(mine.length).padStart(4)} calls  ~${Math.round(inTokens)} input tok  est $${est.toFixed(4)} (uncached, ${assumeOut} output tok/call)`,
      );
    }
    console.log(`Total ${calls.length} calls, est $${total.toFixed(4)}`);
    return;
  }
  if (!apiKey) fail('OPENROUTER_API_KEY is not set');

  const maxCost = values['max-cost'] === undefined ? Infinity : Number(values['max-cost']);
  let spent = 0;
  let finished = 0;
  let stopped = false;

  async function call(u: Unit, turn: TurnSpec): Promise<CallResult | null> {
    const path = pathTo(u.turns, turn);
    const steps: PathStep[] = [];
    for (const p of path) {
      if (p === turn) {
        steps.push({
          question: p.question,
          ...(p.anchor !== undefined ? { anchor: p.anchor } : {}),
        });
        break;
      }
      const own = done.get(resultId({ config: u.config.label, key: `${u.item.id}#${p.id}` }));
      const answer = p.assistant ?? (own && own.error === null ? own.answer : undefined);
      if (answer === undefined) return null; // an earlier turn failed: skip the branch below it
      steps.push({
        question: p.question,
        ...(p.anchor !== undefined ? { anchor: p.anchor } : {}),
        answer,
      });
    }
    const messages = buildMessages(
      systemPrompt,
      steps,
      u.config.anchorMode ?? 'user',
      u.config.model,
    );
    const body = requestBody(u.config, messages);
    const base = {
      key: `${u.item.id}#${turn.id}`,
      itemId: u.item.id,
      turnId: turn.id,
      depth: path.length,
      config: u.config.label,
      model: u.config.model,
      startedAt: new Date().toISOString(),
    };
    for (let attempt = 0; ; attempt++) {
      const t0 = Date.now();
      try {
        const o = await streamCompletion(apiKey!, body, AbortSignal.timeout(15 * 60_000));
        return { ...base, ...o, latencyMs: Date.now() - t0, error: null };
      } catch (e) {
        const status = e instanceof HttpError ? e.status : 0;
        const retryable = status === 0 || status === 408 || status === 429 || status >= 500;
        if (retryable && attempt < 2) {
          await sleep(5000 * (attempt + 1) ** 2);
          continue;
        }
        return {
          ...base,
          provider: null,
          finishReason: null,
          answer: '',
          usage: null,
          latencyMs: Date.now() - t0,
          firstAnswerMs: null,
          generationId: null,
          error: `${status || 'network'}: ${e instanceof Error ? e.message : String(e)}`.slice(
            0,
            600,
          ),
        };
      }
    }
  }

  async function runUnit(u: Unit): Promise<void> {
    for (const turn of u.turns) {
      if (!pending(u, turn)) continue;
      if (spent >= maxCost) {
        stopped = true;
        return;
      }
      const r = await call(u, turn);
      if (r === null) continue;
      done.set(resultId(r), r);
      appendFileSync(resultsPath, `${JSON.stringify(r)}\n`);
      spent += r.usage?.cost ?? 0;
      finished++;
      const u2 = r.usage;
      console.log(
        `[${finished}/${calls.length}] ${r.config} ${r.key} ${r.error ? `ERROR ${r.error.slice(0, 120)}` : `${r.provider} ${r.finishReason} in ${u2?.promptTokens}(c${u2?.cachedTokens}) out ${u2?.completionTokens}(r${u2?.reasoningTokens}) $${u2?.cost.toFixed(5)} ${(r.latencyMs / 1000).toFixed(1)}s`} | run $${spent.toFixed(4)}`,
      );
    }
  }

  const queue = units.filter((u) => u.turns.some((t) => pending(u, t)));
  const workers = Array.from({ length: Math.max(1, Number(values.concurrency)) }, async () => {
    for (let u = queue.shift(); u; u = queue.shift()) await runUnit(u);
  });
  await Promise.all(workers);
  console.log(
    `Done: ${finished} calls, $${spent.toFixed(4)}${stopped ? ' (stopped at --max-cost)' : ''}`,
  );
  await report();
}

if (command === 'run') await run();
else await report();
