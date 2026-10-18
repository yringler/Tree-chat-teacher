// After the run: what the key's own account says it spent, against what the suite
// committed. OpenRouter updates a key's usage with some delay, so a gap is a warning.
import { describe } from 'vitest';
import { keyInfo, liveSettings, postFooter, scenario } from './harness.js';

/** How long OpenRouter is given to count the run's last calls. */
const USAGE_SETTLE_MS = 20_000;

describe('postflight', () => {
  scenario('the key spent what the run committed', 'openrouter', async () => {
    await new Promise((r) => setTimeout(r, USAGE_SETTLE_MS));
    const info = await keyInfo();
    const { spentUsd, keyUsageStartUsd } = await liveSettings();
    await postFooter({ keyUsageEndUsd: info.usage });
    const warnings: string[] = [];
    if (keyUsageStartUsd !== undefined) {
      const delta = info.usage - keyUsageStartUsd;
      if (Math.abs(delta - spentUsd) > Math.max(0.01, spentUsd / 4))
        warnings.push(
          `the key's usage moved $${delta.toFixed(6)}, the run committed $${spentUsd.toFixed(6)} (OpenRouter counts with a delay)`,
        );
    }
    return { model: null, failures: [], warnings, notes: [`committed $${spentUsd.toFixed(6)}`] };
  });
});
