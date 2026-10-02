import type { ShareBranch, ShareMessage, SharePayload } from '@tangent/shared';
import { escapeHtml, renderMarkdown } from './markdown.js';
import { messageMarkdown } from './markdown-export.js';

export interface ViewerPageOptions {
  /** 'share' = served at /s/:token; 'export' = downloadable single file. */
  variant: 'share' | 'export';
  /** Absolute canonical URL (share variant) for og:url. */
  url?: string;
  /**
   * Content-Security-Policy to embed as a `<meta http-equiv>` tag, normally
   * `await viewerCsp()`. Omitted → no meta tag (e.g. when the policy is sent
   * as an HTTP header only). Directives that are ignored in meta tags
   * (`frame-ancestors`, `report-uri`, `sandbox`) are dropped from the tag.
   */
  csp?: string;
}

/**
 * App icon (same artwork as apps/web/public/favicon.svg; keep them in sync).
 * Embedded as a data: URI so exported files stay self-contained; the viewer
 * CSP's `img-src https: data:` allows it.
 */
export const FAVICON_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#2f6fdb"/><g fill="none" stroke="#fff" stroke-width="2.5" stroke-linecap="round"><path d="M11 9v14"/><path d="M11 11c0 5 3 7 8.5 7"/></g><circle cx="11" cy="8" r="3" fill="#fff"/><circle cx="11" cy="24" r="3" fill="#fff"/><circle cx="22" cy="18" r="3" fill="#2f6fdb" stroke="#fff" stroke-width="2.5"/></svg>';

/**
 * Constant inline stylesheet of the viewer page. Hashed for the CSP; never
 * interpolate anything into it.
 */
export const VIEWER_STYLE = `
:root{color-scheme:light dark;--bg:#fbfaf7;--fg:#1f2328;--muted:#5f6670;--faint:#8b929b;--border:#e2dfd8;--panel:#f3f1ec;--card:#fff;--user:#edf3fe;--user-border:#d3e1fa;--accent:#2d68d3;--accent-soft:rgba(45,104,211,.1);--code-bg:#f5f6f8;--quote:#b0892a;--flash:rgba(234,179,8,.45);--shadow:0 10px 30px rgba(0,0,0,.18);--hl-keyword:#cf222e;--hl-string:#0a3069;--hl-number:#0550ae;--hl-comment:#6e7781;--hl-title:#8250df;--hl-attr:#953800;--hl-tag:#116329;--hl-meta:#6639ba;--hl-add:#116329;--hl-add-bg:#dafbe1;--hl-del:#82071e;--hl-del-bg:#ffebe9}
@media (prefers-color-scheme:dark){:root{--bg:#131417;--fg:#e6e7ea;--muted:#a0a6b0;--faint:#6f7680;--border:#2b2e35;--panel:#181a1f;--card:#1d1f24;--user:#1a2335;--user-border:#293b5e;--accent:#7ea9ff;--accent-soft:rgba(126,169,255,.13);--code-bg:#17191d;--quote:#d6b35c;--flash:rgba(234,179,8,.3);--shadow:0 10px 30px rgba(0,0,0,.6);--hl-keyword:#ff7b72;--hl-string:#a5d6ff;--hl-number:#79c0ff;--hl-comment:#8b949e;--hl-title:#d2a8ff;--hl-attr:#ffa657;--hl-tag:#7ee787;--hl-meta:#d2a8ff;--hl-add:#aff5b4;--hl-add-bg:#033a16;--hl-del:#ffdcd7;--hl-del-bg:#67060c}}
*,*::before,*::after{box-sizing:border-box}
html{-webkit-text-size-adjust:100%;text-size-adjust:100%;scroll-padding-top:4.5rem}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.6 system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,"Noto Sans",sans-serif;-webkit-font-smoothing:antialiased}
a{color:var(--accent);text-underline-offset:2px}
a:focus-visible,button:focus-visible,summary:focus-visible{outline:2px solid var(--accent);outline-offset:2px;border-radius:4px}
code,pre,kbd{font-family:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,"Liberation Mono",monospace}
.topbar{position:sticky;top:0;z-index:30;display:flex;align-items:center;gap:.75rem;height:3.25rem;padding:0 1rem;background:var(--bg);border-bottom:1px solid var(--border)}
.topbar h1{flex:1;min-width:0;margin:0;font-size:1rem;font-weight:650;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.badge{flex:none;font-size:.72rem;color:var(--muted);border:1px solid var(--border);border-radius:999px;padding:.1rem .55rem}
.nav-toggle{display:none;flex:none;align-items:center;gap:.4rem;padding:.35rem .65rem;border:1px solid var(--border);border-radius:8px;background:var(--card);color:var(--fg);font:inherit;font-size:.85rem;cursor:pointer}
.js .nav-toggle{display:inline-flex}
.nav-toggle-icon{display:inline-block;width:1rem;height:.7rem;border-top:2px solid currentColor;border-bottom:2px solid currentColor;position:relative}
.nav-toggle-icon::after{content:"";position:absolute;left:0;right:0;top:50%;margin-top:-1px;border-top:2px solid currentColor}
.layout{display:grid;grid-template-columns:18rem minmax(0,1fr);min-height:calc(100vh - 3.25rem)}
.outline{position:sticky;top:3.25rem;align-self:start;max-height:calc(100vh - 3.25rem);overflow:auto;padding:1rem .75rem 2rem;border-right:1px solid var(--border);background:var(--panel)}
.outline-head{display:flex;justify-content:space-between;align-items:baseline;margin:0 .5rem .5rem;font-size:.75rem;font-weight:650;letter-spacing:.06em;text-transform:uppercase;color:var(--muted)}
.tree,.tree ul{list-style:none;margin:0;padding:0}
.tree ul{margin-left:.7rem;padding-left:.45rem;border-left:1px solid var(--border)}
.tree a{display:flex;align-items:baseline;justify-content:space-between;gap:.5rem;padding:.3rem .5rem;border-radius:6px;color:var(--fg);text-decoration:none;font-size:.9rem;line-height:1.35}
.tree a:hover{background:var(--accent-soft)}
.tree a[aria-current]{background:var(--accent-soft);color:var(--accent);font-weight:600}
.tree .t{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.count{flex:none;color:var(--faint);font-size:.75rem;font-weight:400;font-variant-numeric:tabular-nums}
.scrim{display:none;position:fixed;inset:0;z-index:40;background:rgba(0,0,0,.45)}
.main{min-width:0;padding:1.25rem 1rem 3rem}
.col{max-width:46rem;margin:0 auto}
@media (min-width:801px){.outline-hidden .layout{grid-template-columns:minmax(0,1fr)}.outline-hidden .outline{display:none}}
@media (max-width:800px){
.layout{display:block}
.outline{position:static;max-height:none;border-right:0;border-bottom:1px solid var(--border)}
.js .outline{position:fixed;top:0;left:0;bottom:0;z-index:50;width:min(20rem,86vw);max-height:none;border-right:1px solid var(--border);border-bottom:0;box-shadow:var(--shadow);transform:translateX(-105%);visibility:hidden;transition:transform .2s ease,visibility .2s}
.js.drawer-open .outline{transform:none;visibility:visible}
.js.drawer-open .scrim{display:block}
.js.drawer-open body{overflow:hidden}
.main{padding:1rem .85rem 2.5rem}
.topbar{padding:0 .75rem}
}
@media (prefers-reduced-motion:reduce){.js .outline{transition:none}.flash{animation:none}}
.crumbs{display:none;flex-wrap:wrap;align-items:center;gap:.2rem .45rem;margin:0 0 1.1rem;font-size:.85rem;color:var(--muted)}
.js .crumbs{display:flex}
.crumb{text-decoration:none;max-width:16rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.crumb:hover{text-decoration:underline}
.crumb.current{color:var(--fg);font-weight:600}
.sep{color:var(--faint)}
.context{margin:0 0 1.5rem;border:1px solid var(--border);border-radius:10px;background:var(--panel)}
.context>summary{cursor:pointer;padding:.6rem 1rem;color:var(--muted);font-size:.9rem;font-weight:500}
.context-body{padding:.75rem 1rem .25rem;border-top:1px solid var(--border)}
.context .msg{opacity:.85}
.msg{position:relative;margin:0 0 1.1rem;scroll-margin-top:4.5rem;border-radius:12px}
.msg-user{margin-left:clamp(0rem,10vw,4.5rem);padding:.7rem 1rem;background:var(--user);border:1px solid var(--user-border)}
.msg-assistant{padding:.25rem 0}
.msg-head{display:flex;align-items:center;gap:.5rem;margin-bottom:.2rem;font-size:.72rem;font-weight:650;letter-spacing:.06em;text-transform:uppercase;color:var(--muted)}
.msg-link{color:var(--faint);text-decoration:none;opacity:0;transition:opacity .15s}
.msg:hover .msg-link,.msg-link:focus{opacity:1}
.ancestor{opacity:.7;transition:opacity .15s}
.ancestor:hover,.ancestor:focus-within{opacity:1}
.flash{animation:flash 1.8s ease-out}
@keyframes flash{0%,30%{box-shadow:0 0 0 .4rem var(--flash)}100%{box-shadow:0 0 0 .4rem transparent}}
.msg-body{overflow-wrap:anywhere}
.msg-body>:first-child{margin-top:0}
.msg-body>:last-child{margin-bottom:0}
.msg-body p,.msg-body ul,.msg-body ol,.msg-body pre,.msg-body blockquote,.msg-body table{margin:.7em 0}
.msg-body h1,.msg-body h2,.msg-body h3,.msg-body h4,.msg-body h5,.msg-body h6{margin:1.1em 0 .5em;line-height:1.3}
.msg-body h1{font-size:1.35rem}.msg-body h2{font-size:1.2rem}.msg-body h3{font-size:1.05rem}.msg-body h4,.msg-body h5,.msg-body h6{font-size:1rem}
.msg-body ul,.msg-body ol{padding-left:1.4rem}
.msg-body li+li{margin-top:.2em}
.msg-body pre{overflow:auto;padding:.85rem 1rem;border-radius:8px;background:var(--code-bg);border:1px solid var(--border);font-size:.84rem;line-height:1.5;overflow-wrap:normal}
.msg-body :not(pre)>code{padding:.1em .35em;border-radius:4px;background:var(--code-bg);border:1px solid var(--border);font-size:.87em}
.msg-body blockquote{padding:0 1em;border-left:3px solid var(--border);color:var(--muted)}
.msg-body img{max-width:100%;height:auto;border-radius:6px}
.msg-body hr{border:0;border-top:1px solid var(--border);margin:1.2em 0}
.msg-body table{display:block;max-width:100%;overflow:auto;border-collapse:collapse;font-size:.92rem}
.msg-body th,.msg-body td{padding:.35rem .65rem;border:1px solid var(--border)}
.msg-body th{background:var(--panel)}
.ta-left{text-align:left}.ta-center{text-align:center}.ta-right{text-align:right}
.forks{margin-top:.55rem;font-size:.85rem}
.forks>summary{display:inline-flex;align-items:center;gap:.35rem;padding:.12rem .65rem;border:1px solid var(--border);border-radius:999px;background:var(--card);color:var(--muted);cursor:pointer;list-style:none;user-select:none}
.forks>summary::-webkit-details-marker{display:none}
.forks>summary::before{content:"\\21B3";font-size:.95em;color:var(--accent)}
.forks>summary:hover{color:var(--fg)}
.forks ul{margin:.45rem 0 0;padding:0 0 0 .6rem;list-style:none;border-left:2px solid var(--accent-soft)}
.forks li a{display:flex;justify-content:space-between;gap:.75rem;padding:.2rem .5rem;border-radius:6px;text-decoration:none}
.forks li a:hover{background:var(--accent-soft)}
.forks a.on-path{font-weight:600}
.forks a.on-path>span:first-child::before{content:"\\25B8\\00A0"}
.branch-start{margin:1.75rem 0 1.1rem;padding-top:1rem;border-top:1px dashed var(--border);scroll-margin-top:4.5rem}
.bs-label{display:flex;flex-wrap:wrap;align-items:baseline;gap:.2rem .5rem;font-size:.75rem;color:var(--muted)}
.bs-kicker{font-weight:650;letter-spacing:.06em;text-transform:uppercase}
.bs-title{font-size:1rem;font-weight:650;text-decoration:none}
.bs-title:hover{text-decoration:underline}
.back{display:inline-block;margin-top:.35rem;font-size:.85rem;text-decoration:none}
.back:hover{text-decoration:underline}
.anchor{margin:.7rem 0 0;padding:.45rem .9rem;border-left:3px solid var(--quote);border-radius:0 8px 8px 0;background:var(--panel);font-style:italic;white-space:pre-wrap}
.empty{color:var(--muted);font-style:italic}
.js .store{display:none}
.sb{margin:0 0 2.75rem}
.sb-title{margin:0 0 .35rem;font-size:1.1rem}
.sb-fork{margin:0 0 .75rem}
.sb>.anchor{margin-bottom:1rem}
.foot{margin-top:3rem;padding-top:1rem;border-top:1px solid var(--border);color:var(--faint);font-size:.8rem;text-align:center}
.hljs{color:var(--fg);background:transparent}
.hljs-keyword,.hljs-selector-tag,.hljs-literal,.hljs-doctag{color:var(--hl-keyword)}
.hljs-string,.hljs-regexp,.hljs-char.escape_{color:var(--hl-string)}
.hljs-number,.hljs-built_in,.hljs-symbol,.hljs-variable,.hljs-template-variable,.hljs-attr,.hljs-property,.hljs-selector-attr,.hljs-selector-class,.hljs-selector-id{color:var(--hl-number)}
.hljs-title,.hljs-section{color:var(--hl-title)}
.hljs-attribute,.hljs-params,.hljs-type{color:var(--hl-attr)}
.hljs-comment,.hljs-quote{color:var(--hl-comment);font-style:italic}
.hljs-name,.hljs-tag,.hljs-selector-pseudo,.hljs-bullet{color:var(--hl-tag)}
.hljs-meta{color:var(--hl-meta)}
.hljs-meta .hljs-keyword{color:var(--hl-keyword)}
.hljs-meta .hljs-string{color:var(--hl-string)}
.hljs-addition{color:var(--hl-add);background:var(--hl-add-bg)}
.hljs-deletion{color:var(--hl-del);background:var(--hl-del-bg)}
.hljs-emphasis{font-style:italic}
.hljs-strong{font-weight:700}
.hljs-link{text-decoration:underline}
`;

/**
 * Constant inline script of the viewer page. Hashed for the CSP; never
 * interpolate anything into it. It reads the structure JSON, hides the
 * no-JS fallback store, and composes the selected branch path (ancestor
 * messages up to each fork, then the branch's own messages) by cloning the
 * pre-rendered articles. Navigation is hash-based: `#b3` selects a branch,
 * `#m12` selects the branch owning that message and scrolls to it.
 */
export const VIEWER_SCRIPT = `
(function () {
  'use strict';
  var d = document;
  var root = d.documentElement;
  var dataEl = d.getElementById('tangent-data');
  var data = null;
  try { data = JSON.parse(dataEl ? dataEl.textContent || '' : ''); } catch (e) { data = null; }
  if (!data || !data.branches || !data.branches.length) return;
  root.classList.add('js');

  var branches = {}, owner = {}, inContext = {}, articles = {}, sections = {};
  data.branches.forEach(function (b) {
    branches[b.key] = b;
    b.messages.forEach(function (m) { owner[m.key] = b.key; });
  });
  (data.context || []).forEach(function (m) { inContext[m.key] = true; });
  var store = d.getElementById('store');
  if (store) {
    Array.prototype.forEach.call(store.querySelectorAll('[data-key]'), function (el) {
      var k = el.getAttribute('data-key');
      el.removeAttribute('id');
      if (el.tagName === 'ARTICLE') articles[k] = el; else sections[k] = el;
    });
  }
  var thread = d.getElementById('thread');
  var crumbs = d.getElementById('crumbs');
  var ctx = d.getElementById('context');
  var toggle = d.getElementById('outline-toggle');
  var scrim = d.getElementById('scrim');
  var outlineLinks = d.querySelectorAll('#outline a[data-branch]');
  var narrow = window.matchMedia ? window.matchMedia('(max-width: 800px)') : { matches: false };
  var current = null;

  function make(tag, cls, text) {
    var e = d.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function link(key, cls, text) {
    var a = make('a', cls, text);
    a.setAttribute('href', '#' + key);
    return a;
  }
  function chain(key) {
    var out = [], b = branches[key], guard = 0;
    while (b && guard++ < 100000) { out.unshift(b); b = b.parentKey ? branches[b.parentKey] : null; }
    return out;
  }

  function render(key) {
    var ch = chain(key);
    var frag = d.createDocumentFragment();
    ch.forEach(function (b, i) {
      var isCurrent = i === ch.length - 1;
      var next = ch[i + 1];
      if (b.parentKey) {
        var head = make('div', 'branch-start' + (isCurrent ? ' current' : ''));
        var label = make('div', 'bs-label');
        label.appendChild(make('span', 'bs-kicker', isCurrent ? 'Branch' : 'Via branch'));
        label.appendChild(link(b.key, 'bs-title', b.title));
        head.appendChild(label);
        if (isCurrent && b.forkMessageKey) {
          head.appendChild(link(b.forkMessageKey, 'back', '\\u21A9 back to parent message'));
        }
        var quote = sections[b.key] && sections[b.key].querySelector('.anchor');
        if (quote) head.appendChild(quote.cloneNode(true));
        frag.appendChild(head);
      }
      for (var j = 0; j < b.messages.length; j++) {
        var mk = b.messages[j].key;
        var src = articles[mk];
        if (src) {
          var c = src.cloneNode(true);
          c.id = mk;
          if (!isCurrent) c.classList.add('ancestor');
          if (next && mk === next.forkMessageKey) {
            var det = c.querySelector('details.forks');
            var on = c.querySelector('.forks a[data-branch="' + next.key + '"]');
            if (det) det.open = true;
            if (on) { on.classList.add('on-path'); on.setAttribute('aria-current', 'true'); }
          }
          frag.appendChild(c);
        }
        if (next && mk === next.forkMessageKey) break;
      }
      if (isCurrent && !b.messages.length) frag.appendChild(make('p', 'empty', 'No messages in this branch.'));
    });
    thread.textContent = '';
    thread.appendChild(frag);

    crumbs.textContent = '';
    ch.forEach(function (b, i) {
      if (i > 0) crumbs.appendChild(make('span', 'sep', '\\u203A'));
      if (i === ch.length - 1) {
        var s = make('span', 'crumb current', b.title);
        s.setAttribute('aria-current', 'page');
        crumbs.appendChild(s);
      } else {
        crumbs.appendChild(link(ch[i + 1].forkMessageKey || b.key, 'crumb', b.title));
      }
    });

    Array.prototype.forEach.call(outlineLinks, function (a) {
      if (a.getAttribute('data-branch') === key) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    });
  }

  function flash(el) {
    if (!el) return;
    el.scrollIntoView({ block: 'start' });
    el.classList.remove('flash');
    void el.offsetWidth;
    el.classList.add('flash');
  }

  function setDrawer(open) {
    root.classList.toggle('drawer-open', open);
    if (toggle) toggle.setAttribute('aria-expanded', String(open));
  }
  function closeDrawer() {
    if (root.classList.contains('drawer-open')) setDrawer(false);
  }

  function route(initial) {
    var h = location.hash ? location.hash.slice(1) : '';
    try { h = decodeURIComponent(h); } catch (e) { h = ''; }
    var key = data.rootBranchKey;
    if (branches[h]) key = h;
    else if (owner[h]) key = owner[h];
    if (!branches[key]) key = data.branches[0].key;
    if (key !== current) { current = key; render(key); }
    closeDrawer();
    if (branches[h]) {
      var start = thread.querySelector('.branch-start.current');
      if (start) flash(start); else if (!initial) window.scrollTo(0, 0);
    } else if (owner[h]) {
      flash(d.getElementById(h));
    } else if (inContext[h]) {
      if (ctx) ctx.open = true;
      flash(d.getElementById(h));
    }
  }

  if (toggle) {
    toggle.setAttribute('aria-expanded', String(!narrow.matches));
    toggle.addEventListener('click', function () {
      if (narrow.matches) {
        setDrawer(!root.classList.contains('drawer-open'));
      } else {
        var hidden = root.classList.toggle('outline-hidden');
        toggle.setAttribute('aria-expanded', String(!hidden));
      }
    });
  }
  if (scrim) scrim.addEventListener('click', closeDrawer);
  d.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeDrawer(); });
  window.addEventListener('hashchange', function () { route(false); });
  route(true);
})();
`;

interface ViewModel {
  payload: SharePayload;
  byKey: Map<string, ShareBranch>;
  /** Child branches by fork message key, in payload order. */
  forksAt: Map<string, ShareBranch[]>;
  /** Child branches by parent branch key, in payload order. */
  children: Map<string, ShareBranch[]>;
}

function viewModel(payload: SharePayload): ViewModel {
  const byKey = new Map<string, ShareBranch>();
  const forksAt = new Map<string, ShareBranch[]>();
  const children = new Map<string, ShareBranch[]>();
  for (const b of payload.branches) byKey.set(b.key, b);
  for (const b of payload.branches) {
    if (b.parentKey !== null && byKey.has(b.parentKey)) {
      const list = children.get(b.parentKey);
      if (list) list.push(b);
      else children.set(b.parentKey, [b]);
    }
    if (b.forkMessageKey !== null) {
      const list = forksAt.get(b.forkMessageKey);
      if (list) list.push(b);
      else forksAt.set(b.forkMessageKey, [b]);
    }
  }
  return { payload, byKey, forksAt, children };
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

function breadcrumbText(vm: ViewModel, branch: ShareBranch): string {
  const titles: string[] = [];
  const seen = new Set<string>();
  let cur: ShareBranch | undefined = branch;
  while (cur !== undefined && !seen.has(cur.key)) {
    seen.add(cur.key);
    titles.unshift(cur.title);
    cur = cur.parentKey === null ? undefined : vm.byKey.get(cur.parentKey);
  }
  return titles.join(' › ');
}

function renderMessage(vm: ViewModel, m: ShareMessage): string {
  const role = m.role === 'user' ? 'User' : 'Assistant';
  const key = escapeHtml(m.key);
  const forks = vm.forksAt.get(m.key) ?? [];
  let forksHtml = '';
  if (forks.length > 0) {
    const items = forks
      .map(
        (b) =>
          `<li><a href="#${escapeHtml(b.key)}" data-branch="${escapeHtml(b.key)}"><span>${escapeHtml(b.title)}</span>` +
          `<span class="count">${escapeHtml(plural(b.messages.length, 'message', 'messages'))}</span></a></li>`,
      )
      .join('');
    forksHtml =
      `<details class="forks"><summary>${escapeHtml(plural(forks.length, 'branch', 'branches'))}</summary>` +
      `<ul>${items}</ul></details>`;
  }
  return (
    `<article class="msg ${m.role === 'user' ? 'msg-user' : 'msg-assistant'}" id="${key}" data-key="${key}">` +
    `<div class="msg-head"><span class="msg-role">${role}</span>` +
    `<a class="msg-link" href="#${key}" aria-label="Link to this message">#</a></div>` +
    `<div class="msg-body">${renderMarkdown(messageMarkdown(m))}</div>${forksHtml}</article>\n`
  );
}

function renderOutlineItem(vm: ViewModel, b: ShareBranch, seen: Set<string>): string {
  seen.add(b.key);
  const kids = (vm.children.get(b.key) ?? []).filter((c) => !seen.has(c.key));
  const sub =
    kids.length > 0 ? `<ul>${kids.map((c) => renderOutlineItem(vm, c, seen)).join('')}</ul>` : '';
  const key = escapeHtml(b.key);
  return (
    `<li><a href="#${key}" data-branch="${key}"><span class="t">${escapeHtml(b.title)}</span>` +
    `<span class="count" title="${escapeHtml(plural(b.messages.length, 'message', 'messages'))}">${b.messages.length}</span></a>${sub}</li>`
  );
}

function renderStoreBranch(vm: ViewModel, b: ShareBranch): string {
  const key = escapeHtml(b.key);
  const back =
    b.forkMessageKey === null
      ? ''
      : `<p class="sb-fork"><a class="back" href="#${escapeHtml(b.forkMessageKey)}">↩ back to parent message</a></p>`;
  const anchor =
    b.anchorQuote === null
      ? ''
      : `<blockquote class="anchor">${escapeHtml(b.anchorQuote)}</blockquote>`;
  const body =
    b.messages.length === 0
      ? '<p class="empty">No messages in this branch.</p>'
      : b.messages.map((m) => renderMessage(vm, m)).join('');
  return (
    `<section class="sb" id="${key}" data-key="${key}"><h2 class="sb-title">${escapeHtml(breadcrumbText(vm, b))}</h2>` +
    `${back}${anchor}${body}</section>\n`
  );
}

/** Structure only (no message content), safe to embed in a `<script type="application/json">`. */
function structureJson(payload: SharePayload): string {
  const structure = {
    rootBranchKey: payload.rootBranchKey,
    context:
      payload.context === null ? null : payload.context.map((m) => ({ key: m.key, role: m.role })),
    branches: payload.branches.map((b) => ({
      key: b.key,
      parentKey: b.parentKey,
      forkMessageKey: b.forkMessageKey,
      title: b.title,
      messages: b.messages.map((m) => ({ key: m.key, role: m.role })),
    })),
  };
  return JSON.stringify(structure)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return `${MONTHS[date.getUTCMonth()] ?? ''} ${date.getUTCDate()}, ${date.getUTCFullYear()}`;
}

const META_IGNORED_DIRECTIVES = new Set(['frame-ancestors', 'report-uri', 'report-to', 'sandbox']);

function metaCsp(policy: string): string {
  return policy
    .split(';')
    .map((d) => d.trim())
    .filter((d) => d !== '' && !META_IGNORED_DIRECTIVES.has(d.split(/\s+/)[0]?.toLowerCase() ?? ''))
    .join('; ');
}

/**
 * Self-contained, read-only viewer page: tree outline (collapsible, works
 * offline), linear chat view of the selected branch path, breadcrumbs back to
 * the root, "N branches" fork indicators, collapsible ancestor context,
 * mobile-friendly layout, Open Graph + Twitter tags, and a strict CSP meta tag.
 *
 * Messages are pre-rendered with `renderMarkdown`; the inline script and style
 * are constant strings (VIEWER_SCRIPT / VIEWER_STYLE) so hash-based CSP works
 * for both the HTTP response and the exported file. The payload structure
 * (keys only, no content) is embedded as `<script type="application/json">`.
 * Without JavaScript the page degrades to every branch listed in order.
 */
export function renderViewerPage(payload: SharePayload, options: ViewerPageOptions): string {
  const vm = viewModel(payload);
  const title = escapeHtml(payload.title);
  const description = escapeHtml(payload.description);
  const isShare = options.variant === 'share';

  const head: string[] = [
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
  ];
  if (options.csp !== undefined) {
    head.push(
      `<meta http-equiv="Content-Security-Policy" content="${escapeHtml(metaCsp(options.csp))}">`,
    );
  }
  head.push('<meta name="referrer" content="no-referrer">');
  if (isShare) head.push('<meta name="robots" content="noindex">');
  head.push(
    '<meta name="color-scheme" content="light dark">',
    `<title>${title}</title>`,
    `<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,${encodeURIComponent(FAVICON_SVG)}">`,
    `<meta name="description" content="${description}">`,
    `<meta property="og:title" content="${title}">`,
    `<meta property="og:description" content="${description}">`,
    '<meta property="og:type" content="article">',
  );
  if (isShare && options.url !== undefined)
    head.push(`<meta property="og:url" content="${escapeHtml(options.url)}">`);
  head.push(
    '<meta name="twitter:card" content="summary">',
    `<meta name="twitter:title" content="${title}">`,
    `<meta name="twitter:description" content="${description}">`,
    `<style>${VIEWER_STYLE}</style>`,
  );

  const rootBranch = vm.byKey.get(payload.rootBranchKey) ?? payload.branches[0];
  const seen = new Set<string>();
  let outlineHtml = rootBranch === undefined ? '' : renderOutlineItem(vm, rootBranch, seen);
  // Branches unreachable from the root (malformed payloads) are still listed.
  for (const b of payload.branches) {
    if (!seen.has(b.key)) outlineHtml += renderOutlineItem(vm, b, seen);
  }

  const context =
    payload.context === null || payload.context.length === 0
      ? ''
      : `<details class="context" id="context"><summary>Earlier context · ${escapeHtml(
          plural(payload.context.length, 'message', 'messages'),
        )}</summary><div class="context-body">${payload.context.map((m) => renderMessage(vm, m)).join('')}</div></details>\n`;

  const footer = isShare
    ? 'Shared with Tangent · read-only'
    : `Exported from Tangent on ${escapeHtml(formatDate(payload.generatedAt))}`;

  return (
    '<!doctype html>\n<html lang="en">\n<head>\n' +
    head.join('\n') +
    '\n</head>\n<body>\n' +
    '<header class="topbar">' +
    '<button type="button" class="nav-toggle" id="outline-toggle" aria-controls="outline" aria-expanded="false">' +
    '<span class="nav-toggle-icon" aria-hidden="true"></span>Outline</button>' +
    `<h1>${title}</h1><span class="badge">Read-only</span></header>\n` +
    '<div class="layout">\n' +
    `<nav class="outline" id="outline" aria-label="Branches"><div class="outline-head"><span>Branches</span>` +
    `<span class="count">${payload.branches.length}</span></div><ul class="tree">${outlineHtml}</ul></nav>\n` +
    '<div class="scrim" id="scrim"></div>\n' +
    '<main class="main" id="main"><div class="col">\n' +
    '<nav class="crumbs" id="crumbs" aria-label="Branch path"></nav>\n' +
    context +
    '<div class="thread" id="thread"></div>\n' +
    `<div class="store" id="store">\n${payload.branches.map((b) => renderStoreBranch(vm, b)).join('')}</div>\n` +
    `<footer class="foot">${footer}</footer>\n` +
    '</div></main>\n</div>\n' +
    `<script type="application/json" id="tangent-data">${structureJson(payload)}</script>\n` +
    `<script>${VIEWER_SCRIPT}</script>\n` +
    '</body>\n</html>\n'
  );
}

async function sha256Base64(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  let bin = '';
  for (const b of new Uint8Array(digest)) bin += String.fromCharCode(b);
  return btoa(bin);
}

let cspPromise: Promise<string> | null = null;

/**
 * Content-Security-Policy for viewer pages, e.g.
 * "default-src 'none'; script-src 'sha256-…'; style-src 'sha256-…'; img-src https: data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'".
 * Computed (and memoized) from the constant inline script/style with Web Crypto.
 */
export function viewerCsp(): Promise<string> {
  cspPromise ??= Promise.all([sha256Base64(VIEWER_SCRIPT), sha256Base64(VIEWER_STYLE)]).then(
    ([script, style]) =>
      `default-src 'none'; script-src 'sha256-${script}'; style-src 'sha256-${style}'; img-src https: data:; ` +
      "base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    (err: unknown) => {
      cspPromise = null;
      throw err;
    },
  );
  return cspPromise;
}
