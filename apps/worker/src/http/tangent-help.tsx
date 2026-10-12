import {
  HELP_ANALOGY,
  HELP_DEFAULT,
  HELP_ITEMS,
  HELP_RULE,
  HELP_TITLE,
  MAIN_THREAD_LABEL,
  TANGENT_ACTION,
} from '@tangent/shared';

/**
 * A main thread running down, with tangents hanging off it and one tangent
 * off a tangent: the shape the help card describes. Colours come from
 * LANDING_STYLE's `.th-*` rules, so the drawing follows the colour scheme.
 */
function TangentDiagram() {
  return (
    <svg
      class="th-diagram"
      viewBox="0 0 240 200"
      role="img"
      aria-label="A main thread with tangents hanging off it"
    >
      <text class="th-label" x="8" y="16">
        {MAIN_THREAD_LABEL}
      </text>
      <path class="th-main" d="M20 32V190" />
      <path class="th-side" d="M20 70q0 24 24 24h60" />
      <path class="th-side" d="M104 94q0 22 22 22h36" />
      <path class="th-side" d="M20 136q0 24 24 24h80" />
      <circle class="th-dot main" cx="20" cy="40" r="6" />
      <circle class="th-dot main" cx="20" cy="70" r="6" />
      <circle class="th-dot main" cx="20" cy="136" r="6" />
      <circle class="th-dot main" cx="20" cy="184" r="6" />
      <circle class="th-dot" cx="104" cy="94" r="6" />
      <circle class="th-dot" cx="162" cy="116" r="6" />
      <circle class="th-dot" cx="124" cy="160" r="6" />
      <text class="th-label side" x="44" y="86">
        {TANGENT_ACTION.label}
      </text>
      <text class="th-label side" x="44" y="152">
        {TANGENT_ACTION.label}
      </text>
    </svg>
  );
}

/**
 * The landing page's "How tangents work" card: when to reply and when to go
 * on a tangent, in the words the apps' help sheet uses (@tangent/shared's
 * tangent-help.ts). Always shown rather than folded away, so the guidance is
 * on the page for anyone who scrolls; the hero and header link to it.
 */
export function TangentHelpCard() {
  return (
    <section id="how-tangents" class="tangent-help" aria-labelledby="how-tangents-h">
      <div class="wrap">
        <div class="th-card">
          <div>
            <h2 id="how-tangents-h">{HELP_TITLE}</h2>
            <p class="th-rule">{HELP_RULE}</p>
            <dl class="th-items">
              {HELP_ITEMS.map((item) => (
                <div class="th-item">
                  <dt>
                    <span
                      class={item.label === TANGENT_ACTION.label ? 'th-chip tangent' : 'th-chip'}
                    >
                      {item.label}
                    </span>
                  </dt>
                  <dd>{item.text}</dd>
                </div>
              ))}
              <div class="th-item default">
                <dt>{HELP_DEFAULT.label}</dt>
                <dd>{HELP_DEFAULT.text}</dd>
              </div>
            </dl>
            <p class="th-analogy">{HELP_ANALOGY}</p>
          </div>
          <TangentDiagram />
        </div>
      </div>
    </section>
  );
}
