# DIS BBS — Dead Internet Society

A terminal-styled BBS ("punk zine mini web OS") running on Node.js + SQLite,
deployed on Fly.io. Single server process, single database file. No build step.

## Architecture (non-negotiable)

- **WebSocket-only for all authenticated features.** REST endpoints exist only
  for pre-auth concerns (e.g. `/api/stats`, webhooks). Never add authenticated
  REST routes.
- **Terminal for information/navigation, modals for interaction.** Commands and
  text views render in the terminal; games and tools open full-screen modal
  overlays. Never mix the two roles.
- **Server is authoritative.** All state lives server-side in SQLite. Clients
  send intents; the server validates, mutates, and broadcasts.

## Layout

- `server.js` — HTTP/WS setup, command dispatch, message routing, most handlers.
- `src/database/index.js` — schema. All tables created via `ensure*Schema(db)`
  functions using `CREATE TABLE IF NOT EXISTS`. Never destructive migrations.
- `src/hub/index.js` — client registry (`HUB.clients`), `sendOps`, `makeApi`,
  broadcast helpers.
- `src/services/*.js` — self-contained domains (chrome economy, notifications,
  etc.) as factory functions receiving explicit deps: `createXService({ db,
  nowEpoch, ... })`. New domains go here, not inline in server.js.
- `public/index.html` — the entire core client: inline CSS + vanilla JS.
- `public/*.js` — larger/lazier client features may live in separate files
  loaded on demand.

## Protocol conventions

- Server → client: `{ type: 'ops', ops: [{ op: '...', ... }] }`. The client has
  a single op dispatcher; every new server-driven behavior is a new `op`.
- Client → server: `{ type: '<feature>_<action>', ... }` messages, routed in
  the `ws.on('message')` chain in server.js. Binary frames are ignored — the
  protocol is JSON only.
- Every authenticated message handler calls `requireAuth(api, state)` first.
- Feature messages are namespaced: `graffiti_paint`, `slots_spin`,
  `blackjack_hit`. Follow the pattern.
- Broadcasts target the relevant audience only — filter `HUB.clients` by
  connection state (e.g. `state.currentScreen === 'chat'`), never blast
  everyone unless it's genuinely global.

## Terminal commands

- Added as `case '<name>':` in the command switch in server.js, handler named
  `cmd<Name>(api, state, args)`.
- Handlers print via the `api` (`api.print`, `api.printHTML`, `api.batch`) or
  open a modal by sending an `open*` op.

## Client conventions

- Vanilla JS, no frameworks, no build step, ES5-ish style consistent with the
  existing code. Inline in index.html for small features; separate lazy-loaded
  `public/*.js` for large ones.
- Modals: `#<feature>-overlay` (fixed, inset 0, rgba black, z-index 1000)
  containing `#<feature>-modal` (dark panel, `#0a0a0a`, 1px `#222` border).
  Built with `document.createElement`, removed entirely on close. Esc closes.
  Key handlers attach on open, detach on close, and never leak input into the
  terminal.
- Aesthetic: goth/punk/cybergoth terminal. Dark backgrounds, monospace,
  restrained neon accents. `image-rendering: pixelated` for pixel art.

## Database conventions

- better-sqlite3-style prepared statements (`db.prepare(...)`) hoisted once and
  reused; no ad-hoc query strings in hot paths.
- Timestamps are epoch seconds via `nowEpoch()`.
- Users are keyed by `username` (TEXT), lowercase for comparisons.
- Attribution matters: shared/persistent artifacts record who did what
  (see graffiti cells, block logs).

## Economy

- Chrome (₢) is the site currency. All credits/debits go through the chrome
  service (`award`/`spend`) so `chrome_transactions` stays complete. Never
  update balances directly.
- Minerals live in `resource_balances` and trade on `/market`. New sources of
  minerals must go through the existing award path so wallet/market see them.

## Activity feed

- `addActivityEvent(category, event_type, message)` for notable happenings.
- Throttle per user per day for repeatable actions (see the graffiti log
  pattern) — the feed is ambience, not spam.

## Safety/admin

- Ban and fingerprinting systems exist; do not weaken auth or registration
  gates. Rate-limit anything a client can spam.

## Working style

- Surgical changes. Match surrounding style exactly. Don't reformat, don't
  rename, don't "improve" adjacent code, don't add dependencies without asking.
- Feature specs live in `specs/`; read the referenced spec before implementing
  and check work against its acceptance checklist.
