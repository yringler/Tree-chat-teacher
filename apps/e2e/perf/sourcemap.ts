/*
 * Minimal source-map lookup (v3, no sections) for mapping CPU-profile call
 * frames of the built bundles back to the repository's source files.
 */

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_INDEX = new Map([...B64].map((c, i) => [c, i]));

interface RawMap {
  sources: string[];
  names?: string[];
  mappings: string;
  sourceRoot?: string;
}

/** One mapping: generated column → original source, line (0-based), name. */
interface Segment {
  col: number;
  source: number;
  line: number;
  name: number;
}

export interface Original {
  source: string;
  /** 1-based. */
  line: number;
  name: string | null;
}

export class SourceMap {
  private readonly lines: Segment[][] = [];
  private readonly sources: string[];
  private readonly names: string[];

  constructor(raw: RawMap) {
    this.sources = raw.sources.map((s) => (raw.sourceRoot ? raw.sourceRoot + s : s));
    this.names = raw.names ?? [];
    let source = 0;
    let line = 0;
    let col = 0;
    let name = 0;
    for (const lineText of raw.mappings.split(';')) {
      const segs: Segment[] = [];
      let genCol = 0;
      for (const segText of lineText.split(',')) {
        if (segText === '') continue;
        const v = decodeVlq(segText);
        genCol += v[0] ?? 0;
        if (v.length >= 4) {
          source += v[1]!;
          line += v[2]!;
          col += v[3]!;
          if (v.length >= 5) name += v[4]!;
          segs.push({ col: genCol, source, line, name: v.length >= 5 ? name : -1 });
        }
      }
      this.lines.push(segs);
    }
    void col;
  }

  /** `line` and `column` 0-based (as in CDP call frames). */
  lookup(line: number, column: number): Original | null {
    const segs = this.lines[line];
    if (!segs || segs.length === 0) return null;
    let lo = 0;
    let hi = segs.length - 1;
    let best = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (segs[mid]!.col <= column) {
        best = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    const seg = segs[best < 0 ? 0 : best]!;
    return {
      source: this.sources[seg.source] ?? '?',
      line: seg.line + 1,
      name: seg.name >= 0 ? (this.names[seg.name] ?? null) : null,
    };
  }
}

function decodeVlq(text: string): number[] {
  const out: number[] = [];
  let value = 0;
  let shift = 0;
  for (const c of text) {
    const digit = B64_INDEX.get(c);
    if (digit === undefined) throw new Error(`bad VLQ ${text}`);
    value += (digit & 31) << shift;
    if (digit & 32) shift += 5;
    else {
      const negative = value & 1;
      value >>>= 1;
      out.push(negative ? -value : value);
      value = 0;
      shift = 0;
    }
  }
  return out;
}
