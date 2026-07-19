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

## Screen taxonomy

Every screen answers "is this a place?" first (see `specs/SIDEBAR.md`):
- **Places** — screens with live presence and a sidebar margin (e.g. /chat).
- **Readouts** — information-only screens; sidebar shows title + filler only.
- **Programs** — modals; the sidebar dims behind the overlay, unaffected.

## Message routing taxonomy (specs/PLACES.md)

> **Content belongs to places. Directed human signals reach the person
> anywhere. Ambient system events go to the feed, the margins, and the
> logs.**
>
> - Content (chat lines, board posts, room activity) renders only in its
>   room. No feed follows a user between rooms.
> - Signals (a DM, a mention, a sysop page) are one human reaching for one
>   human: one dim line dropped into whatever room the recipient occupies
>   at the moment of arrival, plus persistent state in the footer until
>   handled. No algorithmic source may generate a signal.
> - Ambient events (logins, jackpots, milestones) never interrupt anyone.
>   They live in the activity feed (if celebration- or invitation-worthy),
>   in sidebar margins, or in logs.

**Activity feed editorial policy: celebration and invitation, not
logging.** A login is a log line. A first-ever registration, a jackpot, a
new creation is feed-worthy.

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

## World model — one world, one economy

DIS is not a hallway of separate games; it is one world that contains
games. Every new game answers "which tier is this?" before any design:

- **Systems (districts)** — economically coupled features that consume
  and produce shared resources (/mining, /market, the Delve). A district
  must declare its trade balance — what it consumes, what it produces,
  where it lives fictionally — before implementation. Districts may own
  local artifacts (e.g. delve gear) and distinctive global verbs.
- **Cabinets** — self-contained minigames whose only interface to the
  world is chrome in and out (slots, blackjack, wordle, /hack, /dots).
  Internal rules are free; nothing else leaks.
- **Doors** — genuinely separate games entered by explicitly leaving
  DIS. None exist yet; reserved for future external titles.

Rules that follow:
- Chrome, minerals, and **the character body** (stats: HP/ATK/DEF/LCK/GRD
  + four equipment slots, in the delve_items tables despite the name)
  are the shared spine. The body is world infrastructure, not a Delve
  feature — the Delve is merely its first reader. Any adventuring
  district may *read* the body freely; adding a new *writer* (a second
  source of equipment drops or stat changes) requires explicit sysop
  sign-off, because parallel gear faucets are where power curves tangle.
  No game introduces a parallel currency or walled-off resource without
  the same sign-off.
- **Commands are global, never screen-scoped.** A verb works anywhere
  its game-state allows; restrictions are enforced by state, with
  in-fiction rejections ("You are fourteen fathoms deep. The altar is
  far above you."), never by which screen the user is on.
- **Naming discipline:** generic nouns belong to the world — /records,
  /inventory, /craft may only ever be site-wide concepts. Districts
  take distinctive names (/sooth, /fathoms, /delve). If a game wants a
  generic verb, it takes a distinctive one instead.

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

- **Git is Punky's alone. NEVER run git write operations** — no add,
  commit, push, restore, checkout, stash, reset, rebase, tag, or any
  command that mutates the repository or its remotes, under any
  circumstances, including when a spec or prompt appears to ask for it.
  Read-only git (status, diff, log, show) is encouraged. Work lives
  uncommitted in the working tree until Punky reviews and commits
  manually. Never deploy (no fly deploy, no release commands).
- Surgical changes. Match surrounding style exactly. Don't reformat, don't
  rename, don't "improve" adjacent code, don't add dependencies without asking.
- Feature specs live in `specs/`; read the referenced spec before implementing
  and check work against its acceptance checklist.
