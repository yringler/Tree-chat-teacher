import { escapeHtml } from '@tangent/render';
import {
  poolImpactDepthText,
  poolImpactHeadline,
  poolImpactTopicText,
  type PoolImpactResponse,
} from '@tangent/shared';
import type { AppEnv } from '../env.js';
import { readPoolImpact } from '../pool/impact.js';

/**
 * The open pool's impact feed as the server-rendered pages show it (the
 * landing page and `/pool`): one weekly snapshot's headline, its branch-depth
 * line and the topics it names. Styled by `.impact` in LANDING_STYLE (which
 * LEGAL_STYLE extends). Aggregates only, as stored by pool/impact.ts.
 */
export function renderImpactBlock(impact: PoolImpactResponse, topicLimit?: number): string {
  const topics = topicLimit === undefined ? impact.named : impact.named.slice(0, topicLimit);
  const list = topics.length
    ? `<ul class="topics">${topics
        .map((t) => `<li>${escapeHtml(poolImpactTopicText(t))}</li>`)
        .join('')}</ul>`
    : '<p class="note">No topic had enough different learners to be named that week.</p>';
  return `<div class="impact">
<p class="head">${escapeHtml(poolImpactHeadline(impact))}</p>
<p class="depth">${escapeHtml(poolImpactDepthText(impact))}</p>
${list}
</div>`;
}

/**
 * The latest snapshot for a page, or undefined when there is none or it
 * can't be read (the page renders without it).
 */
export async function latestImpactForPage(env: AppEnv): Promise<PoolImpactResponse | undefined> {
  try {
    return (await readPoolImpact(env.DB)) ?? undefined;
  } catch (err) {
    console.warn('The pool impact snapshot could not be read', err);
    return undefined;
  }
}
