// The live suite's report (apps/worker/.live/report.md): one row per scenario, written
// again after every row so a run that stops halfway still leaves what it found. Shared
// by the Node host (host.ts renders it) and the scenarios (which post rows).

export type ScenarioStatus = 'PASS' | 'WARN' | 'FAIL' | 'SKIPPED';

export interface ReportRow {
  scenario: string;
  /** The adapter and endpoint: `openrouter`, `anthropic`, `openai`. */
  adapter: string;
  model: string | null;
  /** The upstream that served the call (OpenRouter's `provider`). */
  servedBy: string | null;
  /** `in/out (cache read/write, reasoning)`, as reported. */
  tokens: string | null;
  /** The cost the stream reported, USD. */
  reportedUsd: number | null;
  /** The same tokens at the price credit holds the model at, USD. */
  recomputedUsd: number | null;
  status: ScenarioStatus;
  notes: string[];
}

export interface ReportFooter {
  budgetUsd: number;
  /** Committed against the budget: actual costs, and worst cases where none was reported. */
  spentUsd?: number;
  /** The key's `usage` at the preflight and the postflight (OpenRouter `GET /api/v1/key`). */
  keyUsageStartUsd?: number;
  keyUsageEndUsd?: number;
  keyLimitUsd?: number | null;
  /** Shapes of OpenRouter's streams the host saw (host.ts `StreamFacts`). */
  facts?: {
    completions: number;
    withGenerationIdHeader: number;
    withToolCalls: number;
    withAnnotations: number;
    errorChunk: string | null;
  };
  /** Answers to one-off questions about the endpoints, by question. */
  probes?: Record<string, string>;
}

function usd(n: number | null | undefined): string {
  return n === null || n === undefined ? '–' : `$${n.toFixed(6)}`;
}

function cell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

export function renderReport(rows: readonly ReportRow[], footer: ReportFooter): string {
  const counts = new Map<ScenarioStatus, number>();
  for (const r of rows) counts.set(r.status, (counts.get(r.status) ?? 0) + 1);
  const reported = rows.reduce((sum, r) => sum + (r.reportedUsd ?? 0), 0);
  const lines = [
    '# Live contract report',
    '',
    `${rows.length} scenarios: ${(['PASS', 'WARN', 'FAIL', 'SKIPPED'] as const)
      .map((s) => `${counts.get(s) ?? 0} ${s}`)
      .join(', ')}.`,
    '',
    '| Scenario | Adapter | Model | Served by | Tokens in/out (cache r/w, reasoning) | Reported | Recomputed | Ratio | Status | Notes |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...rows.map((r) => {
      const ratio =
        r.reportedUsd !== null && r.recomputedUsd !== null && r.recomputedUsd > 0
          ? (r.reportedUsd / r.recomputedUsd).toFixed(3)
          : '–';
      return `| ${[
        r.scenario,
        r.adapter,
        r.model ?? '–',
        r.servedBy ?? '–',
        r.tokens ?? '–',
        usd(r.reportedUsd),
        usd(r.recomputedUsd),
        ratio,
        `**${r.status}**`,
        r.notes.join('; '),
      ]
        .map(cell)
        .join(' | ')} |`;
    }),
    '',
    `- Budget: ${usd(footer.budgetUsd)}; committed: ${usd(footer.spentUsd)}; reported by the streams: ${usd(reported)}.`,
  ];
  if (footer.keyUsageStartUsd !== undefined) {
    const delta =
      footer.keyUsageEndUsd === undefined
        ? '–'
        : usd(footer.keyUsageEndUsd - footer.keyUsageStartUsd);
    lines.push(
      `- Key usage: ${usd(footer.keyUsageStartUsd)} at the preflight, ${usd(footer.keyUsageEndUsd)} at the postflight (delta ${delta}); limit ${footer.keyLimitUsd === null ? 'none' : usd(footer.keyLimitUsd)}.`,
    );
  }
  const { facts, probes } = footer;
  if (facts && facts.completions > 0)
    lines.push(
      `- OpenRouter streams: ${facts.completions} successful chat completions; ${facts.withGenerationIdHeader} with an \`x-generation-id\` header, ${facts.withToolCalls} with \`tool_calls\`, ${facts.withAnnotations} with \`annotations\`.`,
      `- In-stream error chunk: ${facts.errorChunk === null ? 'none seen' : `\`${facts.errorChunk}\``}.`,
    );
  for (const [question, answer] of Object.entries(probes ?? {}))
    lines.push(`- ${question}: ${answer}`);
  return `${lines.join('\n')}\n`;
}
