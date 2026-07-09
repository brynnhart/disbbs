# DIS Places — Message Routing & Presence Spec

DIS is growing rooms. This spec codifies where every kind of message lives
now that screens are *places*, and adds the presence feature that makes
places honest: `/away`.

Companion to `specs/SIDEBAR.md` (presentation layer). This spec touches
**message routing and server state** — it is the higher-risk half. Per the
post-incident rule: any change in this spec that touches authentication
paths, user records, or login flows gets **manual review before deploy**,
no exceptions. Nothing in this spec deletes anything, ever.

Read `CLAUDE.md` first.

## Command budget

This epic adds **exactly one** terminal command: `/away`, explicitly
requested by Punky. Nothing else — no sysop utilities, no aliases, no
convenience commands. The command surface is already unwieldy and a
separate consolidation redesign toward parameterized commands (e.g.
`/topic new`) is planned; do not pre-empt it. If a phase seems to need a
new command, stop and redesign around existing surfaces (adminchat,
existing commands, sidebar margins).

---

## The taxonomy (add to CLAUDE.md verbatim on Phase 1)

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
>
> **Activity feed editorial policy: celebration and invitation, not
> logging.** A login is a log line. A first-ever registration, a jackpot,
> a new creation is feed-worthy.

## Current state (verified against the codebase, 2026-07)

Partially built already — this spec finishes it, it doesn't start it:

- **Chat is already scoped.** `broadcastChatFrom` (src/hub/index.js)
  filters `currentScreen === 'chat'`. Same for adminchat. **No change
  needed; codify as an invariant.**
- **Mentions already behave as signals.** `notifyMentions`
  (src/services/notifications.js) persists the notification and drops a
  beep + line to the recipient wherever they are. Keep; restyle only.
- **DMs already live-notify** cross-place via `socketsByUser` in `cmdDM`.
  Keep; restyle only.
- **Registrations already post to the activity feed**
  (`👤 <user> just joined DIS!`, server.js ~5900). Keep — it matches the
  feed policy (rare by nature, gives the community someone to greet).
- **What is still global:** `broadcastSystem` blasts every client for:
  join (`server.js` ~904, ~5190), leave (~818), jackpot (~3099), account
  removal (~4916). These are the retarget list below.

## Hard invariants

1. **Exactly one new command (`/away`).** See Command budget above.
2. **Nothing in this spec deletes data or touches the users table's auth
   columns.** `/away` state is in-memory. No schema changes anywhere.
3. **Bans/fingerprinting/registration gates are untouched.**
4. **Protocol changes are additive:** one extension to the existing
   `status` op (unread count field), no other shape changes.
5. **No algorithmic interruptions.** The only things allowed to print into
   a room from outside it are directed human signals and true system
   notices (e.g. imminent shutdown). If in doubt, it goes to the feed.
6. **Roster privacy: coarse locations only.** Rosters and any presence
   surface show place tier — `in chat`, `on the board`, `in the arcade`,
   `browsing` — never topic titles, never DM activity, never specific
   games. The mapping from `currentScreen` values to coarse labels lives
   in one function; unknown screens map to `browsing`.

---

## Retargeting `broadcastSystem` (audit every call site)

| Event | Today | New routing |
|---|---|---|
| User joins BBS | global line | **Adminchat screen only** (reuse the `broadcastAdminChatFrom`-style filter). Chat *room* entry/exit is conveyed by the sidebar roster update (SIDEBAR.md), silently. |
| User leaves BBS | global line | Same as join. |
| Jackpot | global line + feed + games log | **Feed + games log only** — ✔ decided by Punky 2026-07. Both destinations already exist at the call site (`addActivityEvent` + `gameFeedInsert`, ~3099); the change is purely subtractive: delete the `broadcastSystem` line, touch nothing else. |
| Account removed | global line | Adminchat only. |

`broadcastSystem` itself remains for true system notices (shutdown
warnings). Add a one-line comment above it stating invariant 5.

Sysop visibility after this change: adminchat provides real-time
join/leave awareness while on duty. A "recent visitors / who came back"
review surface is genuinely useful but requires either a new command or
the command redesign's parameterized admin surface — so it is **deferred
to the command consolidation project**, noted here so it isn't lost. The
data it needs (`users.last_login_at`, `created_at`) already exists;
nothing to build now.

## Signals

- **Arrival line (the knock):** recipient gets one dim line in their
  current view. Restyle both existing delivery points to a shared format:
  `* incoming from <name> — /dm to read` / `* <name> mentioned you in
  <place> — /mentions to read`, printed with cls `dim`, keep the existing
  beep. No emoji (phosphor Phase 7 precedent). Uses existing commands in
  the hint text only.
- **Standing state (the mail flag):** the footer/status strip gains a
  `MSG <n>` field showing unread DM count. Plumbing: extend the existing
  additive `status` op (phosphor Phase 3) with `unread`; the server sends
  it on login, on DM receipt, and on read-clear in the messages view. The
  field renders in `--phos-dim` like the rest of the strip — **it is
  state, not an alert; no color escalation, no blink** (SIDEBAR invariant
  1 applies to the footer too). The existing `/main` unread banner stays.

## /away

IRC semantics, explicit-only. The epic's one new command.

- `/away <message>` sets away with a message (cap 60 chars, sanitized
  through the existing DIS-Markdown sanitizer, rendered plain).
  `/away` with no argument clears it. **No auto-clear on input** in v1 —
  respect declared intent; revisit if real usage shows staleness.
- State lives in-memory keyed by canonical username (on `HUB`, not on
  socket state — it must survive reconnects within a session but does not
  persist across full logout; cleared when `HUB.online` drops the user).
  No schema.
- Rendering: away users appear dimmed (`--phos-dim`) in all rosters with
  the message beside them: `punkyroo — away: gardening`. Away (human
  declaration) overrides idle (machine observation).
- **Auto-reply:** a DM or mention targeting an away user immediately sends
  the sender one dim line: `* punkyroo is away: gardening`. The signal
  still delivers and still counts as unread. Rate-limit the auto-reply to
  once per sender per away-session (don't echo on every line of a
  multi-message DM burst).
- Existing `/who` and `/here` output gains away annotations (and `/who`
  gains coarse-location annotations) so the terminal-native equivalents of
  the rosters stay complete at any width (SIDEBAR invariant 2) — these
  are output changes to existing commands, not new commands.

---

## Phases

### Phase 1 — Taxonomy + retarget broadcastSystem
- Add taxonomy + feed policy to CLAUDE.md. Comment on `broadcastSystem`.
- Route join/leave/removal to adminchat; delete the global jackpot line
  (decided — see table above).
- Gate: two-browser test — a login is invisible to a normal user in /chat
  and visible in adminchat; a test jackpot appears in `/activity` and the
  games log but prints no line to any other user's terminal (the winner
  still sees their own win message in the slots modal); grep shows zero
  remaining `broadcastSystem` sites outside system notices; zero new
  commands in the diff.

### Phase 2 — Signal restyle + footer MSG state
- Shared arrival-line format for DM + mention delivery. `status` op
  `unread` extension; footer field; send points (login, DM receipt,
  read-clear).
- ⚠ Touches the login path (sending unread count at auth time): manual
  review before deploy.
- Gate: DM a user on the board — they see one dim line + footer `MSG 1`;
  reading clears it; second DM from same sender re-raises it; mobile
  footer truncation behavior checked (existing responsive hides apply);
  zero new commands in the diff.

### Phase 3 — /away
- Command, HUB state, roster rendering hooks (consumed by SIDEBAR Phases
  1/3 via the roster `away` field), auto-reply with rate limit, `/who` and
  `/here` annotations.
- Gate: set/clear/reconnect-persistence/logout-clearing all verified;
  auto-reply fires once per sender; sanitizer round-trip on the message;
  the diff's only new command is `/away`.

### Phase 4 — Release announcement
- Draft the sysop `/news` post (machine's voice: "the BBS is growing
  rooms — here's what moved where, here's how to keep a foot in the
  commons") for Punky to edit and post at release.
- Gate: Punky approves the draft.

Deferred to the command consolidation project: sysop visitors/returns
review surface; any parameterized re-homing of `/away` (e.g. under a
future `/status`).

---

## Testing checklist (every phase)
- No global broadcast reaches a user in an unrelated room except directed
  signals and system notices.
- Nothing deleted, no schema changes, no auth-column writes.
- Mentions/DMs deliver to every open socket of the recipient
  (`socketsByUser` multi-socket case).
- Existing retention sweeps (chat, DM, adminchat) unaffected.
- Mobile: every capability reachable through existing commands (`/who`,
  `/here`, `/mentions`) plus the single new `/away`; no sidebar required.
- Diff audit: no new commands beyond `/away` across the entire epic.
