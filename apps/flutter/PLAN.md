# Tangent Learn in Flutter: plan

A working document for the sessions building this app. When a phase is done,
delete its section; what stays undone at the end moves to `docs/DEFERRED.md`
and this file goes.

## Goal

A small Flutter version of Learn (`apps/simple`) that runs on the web now and
on Android and iOS later, from one codebase:

- **Sign in** by magic link. Signing in for the first time creates the
  account; there is no separate sign-up.
- **Lessons:** a list of the user's lessons (trees), start one from a topic,
  delete one.
- **Chat:** the lesson's thread, the reply streaming in as Markdown, Stop,
  the Normal/Max switch, and the reply's tangents ("Where next?") opening a
  side question.
- The brand icon and name, light and dark themes.

Not in scope: Compare, "Ask about this" on a selection, instructions, export
and import, keys, buying credit, the pool meter, the admin and power
features. A user who needs those uses the web apps.

## How it talks to the Worker

The Flutter web build is served by the Worker at `/app/`, the same origin as
the API, so it signs in and calls `/api/*` exactly as the Angular apps do:
Better Auth's session cookie, sent by the browser. No server change to
auth is needed for the web.

- Every API call sends `x-tangent-mode: simple` and `x-tangent-payment`
  (`pool`, `credit` or `own-key`).
- **Sign-in:** `GET /api/login-options` gives the Turnstile site key.
  `POST /api/auth/sign-in/magic-link` with `{email, callbackURL: "/app/",
  errorCallbackURL: "/app/login"}` and the Turnstile token in
  `x-captcha-response`. The emailed link signs in, sets the cookie and
  redirects to `/app/`. `GET /api/me` answers 401 `unauthorized` when signed
  out. Sign-out is `POST /api/auth/sign-out`.
- **Who pays:** the pool when `GET /api/pool/status` says `enabled`; else
  credit when `/api/me` says `builtInCredit`; else own-key, which fails with
  `key_required` and the app points the user to the web app to add a key.
  The server moves a credit send that can't be covered to the pool on its
  own.
- **Replies** stream as SSE in the body of `POST
  /api/branches/:id/messages` (`event: <type>\ndata: <json>\n\n`, `:`
  keepalive comments). Refusals (pool empty, caps, payment) arrive as a JSON
  error before any event. A body that ends without `done` or `error` is
  resumed with `GET /api/nodes/:id/stream`.
- **Threads:** a lesson's trunk is the nodes of `tree.trunkBranchId` sorted
  by `seq`. A side branch shows its parent's path up to `branchPointNodeId`,
  then its own nodes. A tangent is `POST /api/branches {fromNodeId, contextMode: "path", title}`, then its title sent as the branch's first message.
- **Tangents** are a `<tangents>` block at the end of the reply text,
  parsed as `packages/shared/src/tangents.ts` does.

The Dart types are in `lib/api/models.dart` and the calls in
`lib/api/tangent_api.dart`; both are the contract between the phases below.

## Layout

```
lib/
  main.dart, app.dart        runApp, MaterialApp.router, go_router routes
  config.dart                the API origin (web: the page's; native: --dart-define)
  api/                       models, TangentApi, HttpTangentApi, the SSE parser, tangents
  state/                     ChangeNotifier controllers: session, lessons, chat
  ui/                        theme, pages, widgets; turnstile/ with web and stub variants
test/                        mirrors lib/
```

Routes: `/login`, `/` (lessons), `/t/:treeId` and `/t/:treeId/b/:branchId`
(chat). Path URLs under the `/app/` base href.

## Phases

The phases run as separate agents. Each keeps to its own files, runs
`dart format`, `flutter analyze` (no issues) and `flutter test` before it
hands back, and never edits `lib/api/models.dart` or `tangent_api.dart`
without saying so.

1. **API (`lib/api/`).** `HttpTangentApi({required Uri baseUri,
   http.Client? client})` implementing `TangentApi` over `package:http`;
   the SSE parser; `splitTangents`. Unit tests with `MockClient`, the SSE
   parser fed chunked bytes, and `tangents.ts`'s cases ported.
2. **App (`lib/state/`, `lib/ui/`, `main.dart`, `app.dart`).** The
   controllers and screens above, against `TangentApi`. Widget tests with a
   fake `TangentApi`. Turnstile through `package:web` on the web; a stub
   elsewhere.
3. **Serving and CI.** The Flutter app becomes a workspace package so
   `pnpm build`, `test` and `typecheck` run its build, tests and analysis
   through turbo. `scripts/assemble-assets.mjs` copies the web build to
   `apps/worker/site/app/`. The Worker serves `/app/*` with a CSP that
   Flutter's web build runs under (`wasm-unsafe-eval`, Turnstile, local
   CanvasKit and fonts). CI and deploy install Flutter.
4. **End to end.** Against `wrangler dev` with real local sign-in (Option B
   in `.dev.vars.example`) and the offline fake provider (Option C): sign
   in, start a lesson, watch a reply stream, follow a tangent, sign out, in
   headless Chromium. Then the docs.

## Android and iOS

The project already builds for both (`flutter build apk`, `flutter build
ios` on a Mac). Running against the Worker needs `--dart-define=TANGENT_BASE_URL=https://…`.
What doesn't work yet is **sign-in**, for three reasons in the Worker:

- The session is a cookie, and the API reads nothing else. A native app
  needs a token it can send itself, e.g. Better Auth's `bearer` plugin.
- The magic link opens in the phone's browser, which gets the session, not
  the app. Something has to hand the session to the app: a Worker route the
  link's callback lands on, which redirects to the app (an app link, or a
  custom scheme with a one-time code the app exchanges, so another app
  can't catch the token).
- Turnstile checks the token's hostname, so the widget has to run in a page
  on the Worker's origin (a WebView), not in the app.

That is a change to sign-in, which the owner decides on. Until then the
native builds show that sign-in is web-only.
