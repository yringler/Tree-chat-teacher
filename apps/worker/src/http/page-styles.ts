// The public pages' stylesheets (http/layout.tsx inlines one per page). Each
// is a constant, allowed by its hash in the page's Content-Security-Policy
// (`pageCsp`): never interpolate anything into them. Colours follow
// packages/web-shared base.css.

/** The landing page's look, which every other public page builds on. */
export const LANDING_STYLE = `
:root{color-scheme:light dark;--bg:#fbfbfa;--bg-elev:#fff;--bg-sunken:#f2f2ef;--fg:#1d1d1b;--muted:#6b6b66;--border:#e2e2dd;--accent:#2f6fdb;--accent-fg:#fff;--accent-soft:#e6eefc;--branch:#7a45c7;--branch-soft:#f0e8fb;--user-bg:#f1f3f8;--shadow:0 1px 2px rgb(0 0 0/.05),0 12px 32px rgb(0 0 0/.08);--font:ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif}
@media (prefers-color-scheme:dark){:root{--bg:#161616;--bg-elev:#1f1f1e;--bg-sunken:#121212;--fg:#e9e9e4;--muted:#9b9b94;--border:#2f2f2c;--accent:#6b9cf0;--accent-fg:#0d1526;--accent-soft:#1d2a42;--branch:#b893f0;--branch-soft:#2e2242;--user-bg:#22242a;--shadow:0 1px 2px rgb(0 0 0/.4),0 12px 32px rgb(0 0 0/.45)}}
*,*::before,*::after{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.6 var(--font);-webkit-font-smoothing:antialiased}
a{color:var(--accent)}
a:focus-visible{outline:2px solid var(--accent);outline-offset:3px;border-radius:6px}
.wrap{max-width:960px;margin:0 auto;padding:0 20px}
header.top{display:flex;align-items:center;justify-content:space-between;gap:16px;padding-top:20px;padding-bottom:20px}
.brand{display:inline-flex;align-items:center;gap:10px;color:var(--fg);font-weight:650;font-size:1.1rem;text-decoration:none}
.brand svg{color:var(--accent)}
.top nav{display:flex;gap:18px;font-size:.92rem}
@media (max-width:479px){.top nav a+a{display:none}}
.top nav a{color:var(--muted);text-decoration:none}
.top nav a:hover{color:var(--fg)}
.hero{display:grid;gap:40px;padding-top:32px;padding-bottom:56px}
.eyebrow{margin:0 0 12px;color:var(--accent);font-size:.8rem;font-weight:600;letter-spacing:.08em;text-transform:uppercase}
h1{margin:0;font-size:clamp(2rem,7vw,3.1rem);line-height:1.1;letter-spacing:-.02em;font-weight:700}
.lede{margin:20px 0 0;max-width:34rem;color:var(--muted);font-size:1.08rem}
.ctas{display:flex;flex-wrap:wrap;gap:12px;margin:28px 0 0}
.btn{display:inline-flex;align-items:center;justify-content:center;min-height:46px;padding:0 22px;border-radius:999px;border:1px solid var(--border);background:var(--bg-elev);color:var(--fg);font-weight:600;text-decoration:none}
.btn:hover{border-color:var(--accent)}
.btn.primary{background:var(--accent);border-color:var(--accent);color:var(--accent-fg)}
.btn.primary:hover{filter:brightness(1.08)}
.note{margin:14px 0 0;max-width:30rem;color:var(--muted);font-size:.88rem}
.power{margin:18px 0 0;font-size:.92rem}
.free{margin:18px 0 0;max-width:32rem;padding:12px 16px;border:1px solid var(--accent);border-radius:12px;background:var(--accent-soft);font-size:.95rem}
.free strong{color:var(--accent)}
.demo{position:relative;margin:0;padding:20px;border:1px solid var(--border);border-radius:16px;background:var(--bg-elev);box-shadow:var(--shadow);font-size:.9rem}
.msg{margin:0 0 12px;padding:10px 14px;border-radius:12px;max-width:92%}
.msg.you{margin-left:auto;background:var(--user-bg)}
.msg.tutor{border:1px solid var(--border)}
mark{background:var(--accent-soft);color:inherit;border-radius:4px;padding:0 2px;box-shadow:inset 0 -2px 0 var(--accent)}
.next{margin:6px 0 12px;padding:0 4px}
.next .tag{display:block;margin:0 0 6px;color:var(--muted);font-size:.72rem;font-weight:700;letter-spacing:.06em;text-transform:uppercase}
.next span+span{display:block;margin:0 0 6px;padding:6px 10px;border:1px solid var(--border);border-radius:10px;background:var(--bg-elev)}
.next b{font-weight:600}
.next i{color:var(--muted);font-style:normal}
.next .on{border-color:var(--accent);background:var(--accent-soft)}
.side{margin:4px 0 0 18px;padding:12px 14px;border-left:3px solid var(--branch);border-radius:0 12px 12px 0;background:var(--branch-soft)}
.side .tag{display:inline-block;margin:0 0 6px;color:var(--branch);font-size:.75rem;font-weight:700;letter-spacing:.04em;text-transform:uppercase}
.side p{margin:0}
.side p+p{margin-top:6px;color:var(--muted)}
section{padding:56px 0;border-top:1px solid var(--border)}
h2{margin:0 0 8px;font-size:clamp(1.4rem,4vw,1.85rem);line-height:1.2;letter-spacing:-.01em}
.sub{margin:0 0 32px;max-width:36rem;color:var(--muted)}
.grid{display:grid;gap:16px}
.card{padding:22px;border:1px solid var(--border);border-radius:14px;background:var(--bg-elev)}
.card h3{margin:0 0 8px;font-size:1.05rem}
.card p{margin:0;color:var(--muted);font-size:.95rem}
.icon{display:inline-flex;align-items:center;justify-content:center;width:36px;height:36px;margin:0 0 14px;border-radius:10px;background:var(--accent-soft);color:var(--accent)}
.mode h3{font-size:1.2rem}
.mode .for{margin:0 0 14px}
.mode ul{margin:0 0 20px;padding:0 0 0 18px;font-size:.95rem}
.mode li{margin:0 0 6px}
.mode li::marker{color:var(--accent)}
.mode.learn{border-color:var(--accent);box-shadow:var(--shadow)}
.pool{display:grid;gap:20px;padding:24px;border:1px solid var(--accent);border-radius:14px;background:var(--bg-elev);box-shadow:var(--shadow)}
.pool .meter{margin:0;font-size:clamp(1.5rem,5vw,2rem);font-weight:700;line-height:1.2}
.pool .meter small{display:block;margin-top:4px;color:var(--muted);font-size:1rem;font-weight:500}
.pool .fee{margin:0;color:var(--muted);font-size:.88rem}
.pool .ctas{margin:0}
.steps{display:grid;gap:12px;margin:0;padding:0;list-style:none;counter-reset:step}
.steps li{position:relative;padding:12px 14px 12px 48px;border:1px solid var(--border);border-radius:12px;background:var(--bg-sunken);font-size:.95rem;counter-increment:step}
.steps li::before{content:counter(step);position:absolute;top:11px;left:14px;display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;border-radius:50%;background:var(--accent);color:var(--accent-fg);font-size:.8rem;font-weight:700}
@media (min-width:720px){.steps{grid-template-columns:repeat(3,1fr)}}
#pool+.sub{max-width:40rem}
footer{padding:32px 0 48px;border-top:1px solid var(--border);color:var(--muted);font-size:.9rem}
footer .wrap{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:16px}
footer nav{display:flex;flex-wrap:wrap;gap:18px}
footer a{color:var(--muted)}
@media (min-width:720px){.wrap{padding:0 32px}.hero{grid-template-columns:1.15fr 1fr;align-items:center;padding-top:56px;padding-bottom:80px}.grid.four{grid-template-columns:1fr 1fr}.grid.four>:last-child:nth-child(odd){grid-column:1/-1}.grid.two{grid-template-columns:1fr 1fr}section{padding:72px 0}}
`;

/** `/pricing`: the plan cards, the comparison chart and its notes. */
export const PRICING_STYLE =
  LANDING_STYLE +
  `
.intro{padding-top:24px;padding-bottom:40px}
.intro .lede{max-width:40rem}
.why{padding-bottom:56px}
.why .sub{max-width:40rem}
.plans{display:grid;gap:16px;padding-bottom:56px}
.plan{display:flex;flex-direction:column;padding:24px;border:1px solid var(--border);border-radius:14px;background:var(--bg-elev)}
.plan.featured{border-color:var(--accent);box-shadow:var(--shadow)}
.plan h3{margin:0;font-size:1.15rem}
.plan .price{margin:12px 0 6px;font-size:2.1rem;font-weight:700;line-height:1.15;letter-spacing:-.02em}
.plan .price small{color:var(--muted);font-size:1rem;font-weight:500;letter-spacing:0}
.plan .for{margin:0 0 16px;color:var(--muted)}
.plan ul{margin:0 0 24px;padding:0 0 0 18px;font-size:.95rem}
.plan li{margin:0 0 6px}
.plan li::marker{color:var(--accent)}
.plan .btn{align-self:flex-start;margin-top:auto}
.plan .while{display:block;width:fit-content;margin-top:6px;padding:3px 10px;border:1px solid var(--accent);border-radius:999px;background:var(--accent-soft);font-size:.82rem;font-weight:600}
.chart{overflow-x:auto;border:1px solid var(--border);border-radius:14px;background:var(--bg-elev)}
.chart table{width:100%;border-collapse:collapse;font-size:.92rem}
.chart th,.chart td{padding:10px 14px;border-bottom:1px solid var(--border);text-align:left;vertical-align:top}
.chart thead>tr>*{background:var(--bg-sunken);font-size:.95rem}
.chart thead th,.chart td{width:30%;text-align:center}
.chart tbody th{font-weight:500}
.chart .group th{padding-top:20px;color:var(--muted);font-size:.75rem;font-weight:700;letter-spacing:.06em;text-transform:uppercase}
.chart tbody tr:last-child>*{border-bottom:0}
.chart .yes{color:var(--accent)}
.chart .no{color:var(--muted)}
sup.fn{margin-left:1px;font-size:.72em;line-height:0}
sup.fn a{font-weight:600;text-decoration:none}
.plan .price sup.fn{font-size:.8rem}
.notes h3{margin:32px 0 8px;font-size:1rem}
.notes ol{margin:0;padding-left:22px;color:var(--muted);font-size:.9rem}
.notes li{margin:0 0 10px}
.notes li:target{color:var(--fg)}
.notes .back{text-decoration:none}
.sr-only{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}
@media (max-width:479px){.chart th,.chart td{padding:8px 10px}.chart thead th,.chart td{width:24%}}
@media (min-width:720px){.plans.two{grid-template-columns:1fr 1fr}.plans.one{max-width:30rem}}
@media (min-width:960px){.plans.three{grid-template-columns:1fr 1fr 1fr}}
@media (min-width:720px) and (max-width:959px){.plans.three{grid-template-columns:1fr 1fr}}
`;

/** Long-form text: the legal pages and `/pool`. */
export const DOC_STYLE =
  LANDING_STYLE +
  `
.doc{max-width:46rem;padding-top:16px;padding-bottom:64px}
.doc h1{font-size:clamp(1.8rem,6vw,2.4rem)}
.doc h2{margin:40px 0 8px;font-size:1.3rem}
.doc h3{margin:24px 0 6px;font-size:1.05rem}
.doc p,.doc li{color:var(--fg)}
.doc ul{padding-left:20px}
.doc li{margin:0 0 6px}
.doc .updated{margin:8px 0 24px;color:var(--muted);font-size:.92rem}
.doc .summary{margin:0 0 8px;padding:16px 20px;border:1px solid var(--border);border-radius:14px;background:var(--bg-elev)}
.doc table{width:100%;border-collapse:collapse;font-size:.92rem}
.doc th,.doc td{padding:8px 10px;border-bottom:1px solid var(--border);text-align:left;vertical-align:top}
.doc code{font-size:.88em}
@media (max-width:479px){.top nav a+a{display:inline}}
`;

/** The Turnstile interstitial (`/verify`). */
export const VERIFY_STYLE =
  DOC_STYLE +
  `
.verify{max-width:30rem;padding-top:48px;padding-bottom:64px}
.verify form{display:grid;gap:16px;justify-items:start;margin-top:24px}
.verify .error{color:#c0392b;font-weight:600}
`;
