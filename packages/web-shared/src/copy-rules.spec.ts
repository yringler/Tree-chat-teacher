import { readdirSync, readFileSync } from 'node:fs';
import { FORBIDDEN_POOL_COPY } from '@tangent/shared';
import { describe, expect, it } from 'vitest';

/*
 * Copy rules over the source of every browser app's templates: words some
 * page must never use, checked as text (the rendered tests check what the
 * pages do). Inline `template:`s and `templateUrl` files alike.
 */

const ROOT = new URL('../../../', import.meta.url);
const SOURCES = [
  'apps/web/src',
  'apps/simple/src',
  'apps/canvas/src',
  'apps/admin/src',
  'packages/web-shared/src',
];

/** Each component file's template text, by its path from the repository root. */
function templates(): Map<string, string> {
  const out = new Map<string, string>();
  for (const dir of SOURCES) {
    for (const name of readdirSync(new URL(dir, ROOT), { recursive: true, encoding: 'utf8' })) {
      const path = `${dir}/${name}`;
      if (path.endsWith('.spec.ts') || path.includes('/testing/')) continue;
      const source = () => readFileSync(new URL(path, ROOT), 'utf8');
      if (path.endsWith('.html')) out.set(path, source());
      else if (path.endsWith('.ts')) {
        const inline = [...source().matchAll(/\btemplate:\s*`([^`]*)`/g)].map((m) => m[1]);
        if (inline.length > 0) out.set(path, inline.join('\n'));
      }
    }
  }
  return out;
}

const all = templates();

function only(...paths: string[]): [string, string][] {
  return paths.map((p) => {
    const text = all.get(p);
    expect(text, p).toBeDefined();
    return [p, text!];
  });
}

describe('copy rules', () => {
  it('reads every template', () => {
    expect(all.size).toBeGreaterThan(90);
    expect(all.has('apps/web/src/app/chat/chat-page.html')).toBe(true);
    expect(all.has('packages/web-shared/src/pool/pool-section.ts')).toBe(true);
  });

  it('the pool is free credit Tangent provides: never a donation, a sponsorship or a cause', () => {
    for (const [path, text] of all) expect(text, path).not.toMatch(FORBIDDEN_POOL_COPY);
  });

  it('nobody buys credit for the pool, and nothing promises they will', () => {
    for (const [path, text] of all)
      expect(text, path).not.toMatch(
        /fund-pool|fund the pool|credit for the pool|funded by people|people fund|anyone can add|opens soon/i,
      );
  });

  it('the pool section and its meter sell nothing', () => {
    for (const [path, text] of only(
      'packages/web-shared/src/pool/pool-section.ts',
      'packages/web-shared/src/pool/pool-meter.ts',
    ))
      expect(text, path).not.toMatch(/checkout|presets|buy|purchase/i);
  });

  it('one set of pool caps for everyone: a cap notice never upsells a membership', () => {
    for (const [path, text] of only('packages/web-shared/src/pool/pool-block-notice.ts'))
      expect(text, path).not.toMatch(/member/i);
  });

  it('in Learn, Tangent credit has no member conditions: anyone can buy it', () => {
    for (const [path, text] of only('apps/simple/src/app/shell/model-access-dialog.ts'))
      expect(text, path).not.toMatch(/Members only|Buying more credit|to add more|to buy prepaid/);
  });

  it('the admin pages only adjust credit: nothing simulates a purchase or names a buyer', () => {
    for (const [path, text] of only(
      'apps/admin/src/app/pool-page.ts',
      'apps/admin/src/app/users-page.ts',
    ))
      expect(text, path).not.toMatch(/simulated_purchase|buyer/i);
  });
});
