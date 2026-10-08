/**
 * Turns results (and optional grades) into a per-config summary and a
 * side-by-side Markdown report. With `blind`, answers are shown under opaque
 * codes in a shuffled order and the code → config key is returned separately,
 * so they can be graded before the labels are known.
 */
import { splitTangents } from '../../packages/shared/src/tangents.ts';
import type { CallResult, EvalConfig, QuestionItem } from './types.ts';

/** A grader's marks for one answer (keyed by result id, or by blind code). */
export interface Grade {
  /** 0 wrong / 1 partly right or a notable error / 2 accurate. */
  readonly accuracy: number;
  /** 0 fabricates / 1 overconfident / 2 calibrated (admits uncertainty, abstains on bait). */
  readonly honesty: number;
  /** Maths items with a checkable final answer: 1 when it is right. */
  readonly mathCorrect?: 0 | 1;
  /** 0 poor / 1 adequate / 2 clear, scoped, explains the mechanism. */
  readonly teaching: number;
  /** Visible backtracking or self-correction in the answer itself. */
  readonly flailing?: boolean;
  readonly note?: string;
}

export function resultId(r: Pick<CallResult, 'config' | 'key'>): string {
  return `${r.config}|${r.key}`;
}

/** Visible self-correction in the answer text (a heuristic; grading confirms). */
const BACKTRACK_RE =
  /\b(wait[,.!]|hmm|actually,? (?:no|that's wrong|let me)|let me (?:re-?do|re-?check|recompute|redo|start over|correct)|I made an? (?:error|mistake)|that's not right|oops|scratch that|on second thought)/i;

export function autoFlags(r: CallResult): {
  truncated: boolean;
  empty: boolean;
  tangents: boolean;
  backtracking: boolean;
} {
  const split = splitTangents(r.answer);
  return {
    truncated: r.finishReason === 'length',
    empty: r.error === null && r.answer.trim() === '',
    tangents: split.tangents.length > 0 && !split.partial,
    backtracking: BACKTRACK_RE.test(r.answer),
  };
}

export interface ConfigSummary {
  label: string;
  model: string;
  effort: string;
  maxTokens: number;
  calls: number;
  errors: number;
  truncatedRate: number;
  emptyRate: number;
  tangentsRate: number;
  backtrackRate: number;
  avgCompletion: number;
  avgReasoning: number;
  p90Reasoning: number;
  maxReasoning: number;
  avgAnswerChars: number;
  avgCost: number;
  totalCost: number;
  avgLatencyS: number;
  avgFirstAnswerS: number;
  /** Cached share of prompt tokens on turns that have history (depth >= 2). */
  cacheShareFollowUps: number | null;
  providers: string;
  graded: number;
  avgAccuracy: number | null;
  avgHonesty: number | null;
  /** Correct share of graded maths answers. */
  mathCorrect: number | null;
  avgTeaching: number | null;
  flailRate: number | null;
}

const avg = (xs: readonly number[]): number =>
  xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
const avgOrNull = (xs: readonly number[]): number | null => (xs.length === 0 ? null : avg(xs));

function percentile(xs: readonly number[], p: number): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))]!;
}

export function summarize(
  configs: readonly EvalConfig[],
  results: readonly CallResult[],
  grades: Readonly<Record<string, Grade>>,
): ConfigSummary[] {
  return configs.map((c) => {
    const rs = results.filter((r) => r.config === c.label);
    const ok = rs.filter((r) => r.error === null);
    const flags = ok.map(autoFlags);
    const used = ok.flatMap((r) => (r.usage ? [r.usage] : []));
    const follow = ok.filter((r) => r.depth >= 2 && r.usage);
    const followPrompt = follow.reduce((a, r) => a + r.usage!.promptTokens, 0);
    const followCached = follow.reduce((a, r) => a + r.usage!.cachedTokens, 0);
    const providers = new Map<string, number>();
    for (const r of ok)
      providers.set(r.provider ?? '?', (providers.get(r.provider ?? '?') ?? 0) + 1);
    const gs = ok.flatMap((r) => {
      const g = grades[resultId(r)];
      return g ? [g] : [];
    });
    const share = (pred: (f: ReturnType<typeof autoFlags>) => boolean): number =>
      flags.length === 0 ? 0 : flags.filter(pred).length / flags.length;
    const maths = gs.flatMap((g) => (g.mathCorrect === undefined ? [] : [g.mathCorrect]));
    return {
      label: c.label,
      model: c.model,
      effort: c.effort ?? 'default',
      maxTokens: c.maxTokens,
      calls: rs.length,
      errors: rs.length - ok.length,
      truncatedRate: share((f) => f.truncated),
      emptyRate: share((f) => f.empty),
      tangentsRate: share((f) => f.tangents),
      backtrackRate: share((f) => f.backtracking),
      avgCompletion: avg(used.map((u) => u.completionTokens)),
      avgReasoning: avg(used.map((u) => u.reasoningTokens)),
      p90Reasoning: percentile(
        used.map((u) => u.reasoningTokens),
        0.9,
      ),
      maxReasoning: Math.max(0, ...used.map((u) => u.reasoningTokens)),
      avgAnswerChars: avg(ok.map((r) => r.answer.length)),
      avgCost: avg(used.map((u) => u.cost)),
      totalCost: used.reduce((a, u) => a + u.cost, 0),
      avgLatencyS: avg(ok.map((r) => r.latencyMs / 1000)),
      avgFirstAnswerS: avg(
        ok.flatMap((r) => (r.firstAnswerMs === null ? [] : [r.firstAnswerMs / 1000])),
      ),
      cacheShareFollowUps: followPrompt === 0 ? null : followCached / followPrompt,
      providers: [...providers].map(([p, n]) => `${p}×${n}`).join(', '),
      graded: gs.length,
      avgAccuracy: avgOrNull(gs.map((g) => g.accuracy)),
      avgHonesty: avgOrNull(gs.map((g) => g.honesty)),
      mathCorrect: avgOrNull(maths),
      avgTeaching: avgOrNull(gs.map((g) => g.teaching)),
      flailRate: avgOrNull(gs.map((g) => (g.flailing === true ? 1 : 0))),
    };
  });
}

const f = (n: number | null, digits = 2): string => (n === null ? '–' : n.toFixed(digits));
const pct = (n: number | null): string => (n === null ? '–' : `${Math.round(n * 100)}%`);

export function summaryTable(rows: readonly ConfigSummary[]): string {
  const head =
    '| Config | Model | Effort | Cap | Calls | Err | Acc (0-2) | Honesty (0-2) | Maths ✓ | Teach (0-2) | Flail | Cut off | Empty | Tangents | Avg reasoning tok | p90 reasoning | Avg completion tok | Avg $/answer | Total $ | Avg s | First-answer s | Cache share (turn≥2) | Providers |';
  const sep = `|${'---|'.repeat(23)}`;
  const body = rows.map((r) =>
    [
      r.label,
      `\`${r.model}\``,
      r.effort,
      r.maxTokens,
      r.calls,
      r.errors,
      f(r.avgAccuracy),
      f(r.avgHonesty),
      pct(r.mathCorrect),
      f(r.avgTeaching),
      pct(r.flailRate),
      pct(r.truncatedRate),
      pct(r.emptyRate),
      pct(r.tangentsRate),
      Math.round(r.avgReasoning),
      Math.round(r.p90Reasoning),
      Math.round(r.avgCompletion),
      `$${r.avgCost.toFixed(5)}`,
      `$${r.totalCost.toFixed(4)}`,
      f(r.avgLatencyS, 1),
      f(r.avgFirstAnswerS, 1),
      pct(r.cacheShareFollowUps),
      r.providers,
    ].join(' | '),
  );
  return [head, sep, ...body.map((b) => `| ${b} |`)].join('\n');
}

/** Deterministic shuffle (so a blind report is stable across regenerations). */
function seededOrder<T>(xs: readonly T[], seed: string): T[] {
  let h = 2166136261;
  for (const ch of seed) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i--) {
    h = Math.imul(h ^ (h >>> 15), 2246822507) >>> 0;
    const j = h % (i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

export interface ReportOptions {
  readonly title: string;
  readonly blind: boolean;
}

export interface Report {
  markdown: string;
  /** Blind code → result id (empty unless blind). */
  key: Record<string, string>;
}

export function renderReport(
  items: readonly QuestionItem[],
  configs: readonly EvalConfig[],
  results: readonly CallResult[],
  grades: Readonly<Record<string, Grade>>,
  options: ReportOptions,
): Report {
  const key: Record<string, string> = {};
  const out: string[] = [`# ${options.title}`, ''];
  if (!options.blind) {
    out.push('## Summary', '', summaryTable(summarize(configs, results, grades)), '');
  }
  let code = 0;
  for (const item of items) {
    const turns = item.turns ?? [
      { id: 'q', question: item.question ?? '', expected: item.expected },
    ];
    for (const turn of turns) {
      const k = `${item.id}#${turn.id}`;
      const rs = results.filter((r) => r.key === k);
      if (rs.length === 0) continue;
      out.push(`## ${k} — ${item.category}`, '');
      if (turn.anchor)
        out.push(`> **Excerpt:** ${turn.anchor.replace(/\n/g, ' ').slice(0, 300)}`, '');
      out.push(`**Q:** ${turn.question}`, '');
      const expected = turn.expected ?? (item.turns ? undefined : item.expected);
      if (expected) out.push(`**Expected:** ${expected}`, '');
      if (item.notes) out.push(`**Notes:** ${item.notes}`, '');
      const ordered = options.blind
        ? seededOrder(rs, k)
        : configs.flatMap((c) => rs.filter((r) => r.config === c.label));
      for (const r of ordered) {
        const flags = autoFlags(r);
        let name = r.config;
        if (options.blind) {
          name = `R${String(++code).padStart(3, '0')}`;
          key[name] = resultId(r);
        }
        const u = r.usage;
        const stats = r.error
          ? `ERROR: ${r.error}`
          : [
              options.blind ? null : `provider ${r.provider ?? '?'}`,
              `finish ${r.finishReason ?? '?'}`,
              u ? `prompt ${u.promptTokens} (cached ${u.cachedTokens})` : null,
              u ? `completion ${u.completionTokens} (reasoning ${u.reasoningTokens})` : null,
              u && !options.blind ? `$${u.cost.toFixed(5)}` : null,
              options.blind ? null : `${(r.latencyMs / 1000).toFixed(1)}s`,
              flags.truncated ? '**CUT OFF**' : null,
              flags.empty ? '**EMPTY**' : null,
              flags.tangents ? 'tangents ✓' : 'no tangents',
              flags.backtracking ? 'backtracking?' : null,
            ]
              .filter((s) => s !== null)
              .join(' · ');
        out.push(`### ${name}`, '', `_${stats}_`, '');
        const g = options.blind ? undefined : grades[resultId(r)];
        if (g)
          out.push(
            `**Grade:** acc ${g.accuracy} · honesty ${g.honesty}${g.mathCorrect === undefined ? '' : ` · maths ${g.mathCorrect}`} · teaching ${g.teaching}${g.flailing ? ' · flailing' : ''}${g.note ? ` — ${g.note}` : ''}`,
            '',
          );
        out.push(r.answer.trim() === '' ? '_(no answer)_' : r.answer.trim(), '', '---', '');
      }
    }
  }
  return { markdown: out.join('\n'), key };
}
