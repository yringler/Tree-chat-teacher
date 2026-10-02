// Numeric vars (wrangler.jsonc strings): a non-negative integer, else the fallback.

/** Parses a var holding a non-negative integer; empty, malformed or unsafe values give `fallback`. */
export function intVar(raw: string | undefined, fallback: number): number {
  const s = raw?.trim();
  if (!s || !/^\d+$/.test(s)) return fallback;
  const n = Number(s);
  return Number.isSafeInteger(n) ? n : fallback;
}
