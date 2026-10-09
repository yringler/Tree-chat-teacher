// The public pages' stylesheets (http/layout.tsx inlines one per page). Each
// is a constant, allowed by its hash in the page's Content-Security-Policy
// (`pageCsp`): never interpolate anything into them. Colours follow
// packages/web-shared base.css.

/** The look every public page shares: the header, type, buttons, sections and the footer. */
const BASE_STYLE = `
:root{color-scheme:light dark;--bg:#fbfbfa;--bg-elev:#fff;--bg-sunken:#f2f2ef;--fg:#1d1d1b;--muted:#6b6b66;--border:#e2e2dd;--accent:#2f6fdb;--accent-fg:#fff;--accent-soft:#e6eefc;--shadow:0 1px 2px rgb(0 0 0/.05),0 12px 32px rgb(0 0 0/.08);--font:ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif}
@media (prefers-color-scheme:dark){:root{--bg:#161616;--bg-elev:#1f1f1e;--bg-sunken:#121212;--fg:#e9e9e4;--muted:#9b9b94;--border:#2f2f2c;--accent:#6b9cf0;--accent-fg:#0d1526;--accent-soft:#1d2a42;--shadow:0 1px 2px rgb(0 0 0/.4),0 12px 32px rgb(0 0 0/.45)}}
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
.eyebrow{margin:0 0 12px;color:var(--accent);font-size:.8rem;font-weight:600;letter-spacing:.08em;text-transform:uppercase}
h1{margin:0;font-size:clamp(2rem,7vw,3.1rem);line-height:1.1;letter-spacing:-.02em;font-weight:700}
.lede{margin:20px 0 0;max-width:34rem;color:var(--muted);font-size:1.08rem}
.ctas{display:flex;flex-wrap:wrap;gap:12px;margin:28px 0 0}
.btn{display:inline-flex;align-items:center;justify-content:center;min-height:46px;padding:0 22px;border-radius:999px;border:1px solid var(--border);background:var(--bg-elev);color:var(--fg);font-weight:600;text-decoration:none}
.btn:hover{border-color:var(--accent)}
.btn.primary{background:var(--accent);border-color:var(--accent);color:var(--accent-fg)}
.btn.primary:hover{filter:brightness(1.08)}
section{padding:56px 0;border-top:1px solid var(--border)}
h2{margin:0 0 8px;font-size:clamp(1.4rem,4vw,1.85rem);line-height:1.2;letter-spacing:-.01em}
.sub{margin:0 0 32px;max-width:36rem;color:var(--muted)}
.steps{display:grid;gap:12px;margin:0;padding:0;list-style:none;counter-reset:step}
.steps li{position:relative;padding:12px 14px 12px 48px;border:1px solid var(--border);border-radius:12px;background:var(--bg-sunken);font-size:.95rem;counter-increment:step}
.steps li::before{content:counter(step);position:absolute;top:11px;left:14px;display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;border-radius:50%;background:var(--accent);color:var(--accent-fg);font-size:.8rem;font-weight:700}
@media (min-width:720px){.steps{grid-template-columns:repeat(3,1fr)}}
.sr-only{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}
footer{padding:32px 0 48px;border-top:1px solid var(--border);color:var(--muted);font-size:.9rem}
footer .wrap{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:16px}
footer nav{display:flex;flex-wrap:wrap;gap:18px}
footer a{color:var(--muted)}
@media (min-width:720px){.wrap{padding:0 32px}section{padding:72px 0}}
`;

/**
 * The landing page: the hero, its demo, the problem/fix pairs (one card
 * each, labeled when stacked on a phone), the pool and
 * the ways in. The demo plays in CSS alone (the page runs no script): the
 * regular chat fills in on timed animations and stops at a gate, a checkbox
 * whose label is the gate's button switches to the Tangent view, and radio
 * chips pick its branch. Every animation only delays a final state, so
 * reduced motion shows the finished chat and its gate at once.
 */
export const LANDING_STYLE =
  BASE_STYLE +
  `
:root{--b1:#2f6fdb;--b1-soft:#e6eefc;--b2:#0f7a70;--b2-soft:#ddf2ef;--b3:#a15c00;--b3-soft:#fcefd9;--b4:#7a45c7;--b4-soft:#f0e8fb;--face:#f5c04e;--face-low:#b9c0cb;--face-line:#1d1d1b}
@media (prefers-color-scheme:dark){:root{--b1:#7ea9f3;--b1-soft:#1d2a42;--b2:#5cc6b9;--b2-soft:#15302c;--b3:#e7b35a;--b3-soft:#3a2d14;--b4:#b893f0;--b4-soft:#2e2242;--face-low:#7d8590;--face-line:#121212}}
.b1{--bc:var(--b1);--bs:var(--b1-soft)}.b2{--bc:var(--b2);--bs:var(--b2-soft)}.b3{--bc:var(--b3);--bs:var(--b3-soft)}.b4{--bc:var(--b4);--bs:var(--b4-soft)}
.hero{display:grid;gap:36px;padding-top:24px;padding-bottom:56px}
.note{margin:14px 0 0;max-width:30rem;color:var(--muted);font-size:.88rem}
.free{margin:18px 0 0;max-width:32rem;padding:12px 16px;border:1px solid var(--accent);border-radius:12px;background:var(--accent-soft);font-size:.95rem}
.free strong{color:var(--accent)}
.dm-wrap{position:relative;min-width:0}
.dm{position:relative;display:flex;flex-direction:column;height:29rem;margin:0;border:1px solid var(--border);border-radius:16px;background:var(--bg-sunken);box-shadow:var(--shadow);overflow:hidden}
.dm-bar{display:flex;align-items:center;justify-content:space-between;gap:12px;min-height:48px;padding:0 14px;border-bottom:1px solid var(--border);background:var(--bg-elev);font-weight:650;font-size:.95rem}
.dm-title{display:inline-flex;align-items:center;gap:8px}
.dm-title::before{content:"";width:9px;height:9px;border-radius:50%;background:var(--muted)}
.dm-t2,.dm-replay{display:none}
.dm-replay{min-height:32px;align-items:center;padding:0 12px;border:1px solid var(--border);border-radius:999px;color:var(--muted);font-size:.82rem;font-weight:600;cursor:pointer}
.dm-tangle{position:relative;flex:1;min-height:0}
.dm-chat{position:absolute;inset:0;display:flex;flex-direction:column;justify-content:flex-end;padding:0 14px 14px;overflow:hidden}
.dm-msg{flex:none;margin:10px 0 0;padding:9px 12px;border-radius:12px;font-size:.88rem;line-height:1.45;overflow:hidden;animation:dm-in .5s ease-out backwards}
.dm-msg.q{align-self:flex-end;max-width:80%;border-left:3px solid var(--bc);background:var(--bs);font-weight:600}
.dm-msg.a{align-self:flex-start;width:92%;border:1px solid var(--border);border-left:3px solid var(--bc);background:var(--bg-elev)}
.dm-chat .dm-msg:nth-child(1){animation-delay:.3s}.dm-chat .dm-msg:nth-child(2){animation-delay:1.2s}
.dm-chat .dm-msg:nth-child(3){animation-delay:3.1s}.dm-chat .dm-msg:nth-child(4){animation-delay:4s}
.dm-chat .dm-msg:nth-child(5){animation-delay:5.9s}.dm-chat .dm-msg:nth-child(6){animation-delay:6.8s}
.dm-chat .dm-msg:nth-child(7){animation-delay:8.7s}.dm-chat .dm-msg:nth-child(8){animation-delay:9.6s}
.dm-chat .dm-msg:nth-child(9){animation-delay:11.5s}.dm-chat .dm-msg:nth-child(10){animation-delay:12.4s}
@keyframes dm-in{from{max-height:0;margin-top:0;padding-top:0;padding-bottom:0;opacity:0}to{max-height:9rem;opacity:1}}
.sk{display:inline-block;height:7px;margin:4px 6px 4px 0;border-radius:4px;background:var(--border);vertical-align:middle}
.w30{width:30%}.w45{width:45%}.w60{width:60%}.w75{width:75%}.w90{width:90%}
.dm mark{padding:0 3px;border-radius:4px;background:var(--bs);color:inherit;font-weight:600;white-space:nowrap;box-shadow:inset 0 -2px 0 var(--bc)}
.dm-cap,.dm-note{display:flex;align-items:center;gap:10px;padding:10px 12px;border:1px solid var(--border);border-radius:12px;background:var(--bg-elev);box-shadow:var(--shadow);font-weight:600;font-size:.95rem;line-height:1.35}
.dm-cap svg,.dm-note svg{flex:none}
.dm-caps{margin:0;padding:0;list-style:none}
.dm-cap{position:absolute;z-index:2;top:10px;left:10px;right:10px;visibility:hidden;opacity:0;animation:dm-cap 2.8s both}
.dm-cap:nth-child(2){animation-delay:2.8s}.dm-cap:nth-child(3){animation-delay:5.6s}.dm-cap:nth-child(4){animation-delay:8.4s}.dm-cap:nth-child(5){animation-delay:11.2s}.dm-cap:nth-child(6){animation-delay:14s}
.dm-cap:last-child{visibility:visible;opacity:1;animation:dm-show .4s 16.8s backwards}
@keyframes dm-cap{0%{visibility:visible;opacity:0;transform:translateY(-4px)}10%,90%{visibility:visible;opacity:1;transform:none}100%{visibility:hidden;opacity:0}}
@keyframes dm-show{from{visibility:hidden;opacity:0}}
.face{fill:var(--face);stroke:var(--face-line);stroke-width:1.5}
.face.low{fill:var(--face-low)}
.face-line{fill:none;stroke:var(--face-line);stroke-width:1.6;stroke-linecap:round}
.face-eye{fill:var(--face-line)}
.dm-gate{position:absolute;z-index:1;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;padding:72px 24px 24px;background:color-mix(in srgb,var(--bg-sunken) 72%,transparent);-webkit-backdrop-filter:blur(2px);backdrop-filter:blur(2px);text-align:center;animation:dm-show .5s 17.2s backwards}
.dm-go{display:flex;align-items:center;justify-content:center;width:100%;max-width:20rem;min-height:56px;padding:0 24px;border-radius:999px;background:var(--accent);color:var(--accent-fg);box-shadow:var(--shadow);font-size:1.12rem;font-weight:700;cursor:pointer}
.dm-go:hover{filter:brightness(1.08)}
.dm-gate small{color:var(--muted);font-size:.85rem}
.dm-solve{animation:dm-show .5s 17.2s backwards}
.dm-solve:focus-visible~.dm .dm-go,.dm-solve:focus-visible~.dm .dm-replay,.dm-pick:focus-visible+.chip{outline:2px solid var(--accent);outline-offset:3px}
.dm-solve:checked~.dm .dm-title::before{background:var(--accent)}
.dm-solve:checked~.dm .dm-t1,.dm-solve:checked~.dm .dm-tangle{display:none}
.dm-solve:checked~.dm .dm-t2{display:inline}
.dm-solve:checked~.dm .dm-replay{display:inline-flex}
.dm-solved{position:relative;display:none;flex:1;min-height:0}
.dm-solve:checked~.dm .dm-solved{display:block}
.dm-play,.dm-scene,.dm-live{position:absolute;inset:0;display:flex;flex-direction:column}
.dm-play{visibility:hidden;animation:dm-on 18.6s}
.dm-scene{visibility:hidden;animation:dm-on var(--d) var(--t)}
.sc1{--t:.3s;--d:2.5s}.sc2{--t:2.8s;--d:3.4s}.sc3{--t:6.2s;--d:3.4s}.sc4{--t:9.6s;--d:2.6s}.sc5{--t:12.2s;--d:3.4s}.sc6{--t:15.6s;--d:3s}
@keyframes dm-on{0%,100%{visibility:visible}}
.dm-live{animation:dm-show .3s 18.6s backwards}
.dm-scene .dm-msg,.dm-live .dm-msg{animation:none}
.dm-scene .n1,.dm-scene .n2,.dm-scene .n3{animation:dm-in .5s ease-out backwards}
.dm-scene .n1{animation-delay:calc(var(--t) + .6s)}.dm-scene .n2{animation-delay:calc(var(--t) + 1.2s)}.dm-scene .n3{animation-delay:calc(var(--t) + 2s)}
.dm-scene .dm-from{animation:dm-dim .4s calc(var(--t) + .9s) backwards}
@keyframes dm-dim{from{opacity:1}}
.dm-scene mark.tap{animation:dm-tap 1s calc(var(--t) + .1s) backwards}
@keyframes dm-tap{0%,100%{box-shadow:inset 0 -2px 0 var(--bc)}40%,70%{box-shadow:0 0 0 4px var(--bc)}}
.dm-scene .chip.pop{animation:dm-pop .4s calc(var(--t) + .1s) backwards}
@keyframes dm-pop{from{opacity:0;transform:scale(.6)}}
.dm-chips{display:flex;flex:none;gap:6px;padding:10px 12px;border-bottom:1px solid var(--border);background:var(--bg-elev);overflow-x:auto;scrollbar-width:none}
.chip{display:inline-flex;flex:none;align-items:center;gap:5px;min-height:34px;padding:0 9px;border:1px solid var(--border);border-radius:999px;font-size:.78rem;font-weight:600;white-space:nowrap}
.chip::before{content:"";width:7px;height:7px;border-radius:50%;background:var(--bc)}
label.chip{cursor:pointer}
.chip.on,.dm-pick:checked+.chip{border-color:var(--bc);background:var(--bs)}
.dm-pane{display:flex;flex:1;flex-direction:column;justify-content:flex-end;min-height:0;padding:0 14px 12px;overflow:hidden}
.dm-live .dm-pane{display:none}
.dm-chips:has(#dm-b1:checked)~.p1,.dm-chips:has(#dm-b2:checked)~.p2,.dm-chips:has(#dm-b3:checked)~.p3,.dm-chips:has(#dm-b4:checked)~.p4{display:flex}
.dm-from{opacity:.55}
.dm-fork{display:flex;align-items:center;gap:8px;margin:14px 0 0;color:var(--muted);font-size:.75rem;font-weight:600;letter-spacing:.04em;text-transform:uppercase;white-space:nowrap}
.dm-fork::before,.dm-fork::after{content:"";flex:1;height:1px;background:var(--border)}
.dm-forks{flex:none;margin:6px 0 0;color:var(--muted);font-size:.8rem}
.dm-note{flex:none;margin:12px 0 0}
.pairs-head{display:none}
.pairs{display:grid;gap:14px;margin:0}
.pair{display:grid;border:1px solid var(--border);border-radius:12px;background:var(--bg-elev);overflow:hidden}
.pair dt,.pair dd{margin:0;padding:14px 16px}
.pair dt{background:var(--bg-sunken);color:var(--muted)}
.pair dd{position:relative;border-top:1px solid var(--border);font-weight:600}
.pair dd::before{content:'↓';position:absolute;top:-12px;right:16px;display:flex;align-items:center;justify-content:center;width:24px;height:24px;border-radius:50%;background:var(--accent);color:var(--accent-fg);font-size:.85rem;font-weight:700}
.pair .tag{display:block;margin-bottom:4px;font-size:.72rem;font-weight:600;letter-spacing:.08em;text-transform:uppercase}
.pair dd .tag{color:var(--accent)}
.after{margin:28px 0 0;max-width:36rem;color:var(--muted)}
.grid{display:grid;gap:16px}
.card{padding:22px;border:1px solid var(--border);border-radius:14px;background:var(--bg-elev)}
.card h3{margin:0 0 8px;font-size:1.05rem}
.card p{margin:0;color:var(--muted);font-size:.95rem}
.pool{display:grid;gap:20px;padding:24px;border:1px solid var(--accent);border-radius:14px;background:var(--bg-elev);box-shadow:var(--shadow)}
.pool .meter{margin:0;font-size:clamp(1.5rem,5vw,2rem);font-weight:700;line-height:1.2}
.pool .meter small{display:block;margin-top:4px;color:var(--muted);font-size:1rem;font-weight:500}
.pool .fee{margin:0;color:var(--muted);font-size:.88rem}
.pool .ctas{margin:0}
#pool+.sub{max-width:40rem}
@media (min-width:720px){.hero{grid-template-columns:1fr 1.1fr;align-items:center;padding-top:48px;padding-bottom:72px}.pairs-head,.pair{grid-template-columns:1fr 1fr}.pairs-head{display:grid;margin-bottom:8px;font-size:.72rem;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--muted)}.pairs-head span{padding:0 17px}.pairs-head span+span{padding-left:29px;color:var(--accent)}.pair dd{padding-left:28px;border-top:0;border-left:1px solid var(--border)}.pair dd::before{content:'→';top:calc(50% - 12px);right:auto;left:-12px}.pair .tag{position:absolute;width:1px;height:1px;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}.grid.three{grid-template-columns:repeat(3,1fr)}}
@media (prefers-reduced-motion:reduce){.dm *,.dm-solve{animation:none!important}}
`;

/** `/pricing`: the plan cards, the comparison chart and its notes. */
export const PRICING_STYLE =
  BASE_STYLE +
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
@media (max-width:479px){.chart th,.chart td{padding:8px 10px}.chart thead th,.chart td{width:24%}}
@media (min-width:720px){.plans.two{grid-template-columns:1fr 1fr}.plans.one{max-width:30rem}}
@media (min-width:960px){.plans.three{grid-template-columns:1fr 1fr 1fr}}
@media (min-width:720px) and (max-width:959px){.plans.three{grid-template-columns:1fr 1fr}}
`;

/** Long-form text: the legal pages and `/pool`. */
export const DOC_STYLE =
  BASE_STYLE +
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
