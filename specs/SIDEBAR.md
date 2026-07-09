# DIS Sidebar — Contextual Margin Spec

Add a permanently attached, context-sensitive sidebar to the DIS client. The
sidebar is the ambient margin of whatever *place* the user currently occupies:
place title at the top, live room information below it, decorative faux-code
decaying into the void at the bottom.

This is a **presentation-layer project with one additive protocol change**
(the `panel` op). The database, auth, command handlers, and existing ops are
not targets. Message routing changes live in `specs/PLACES.md`, not here —
the two specs ship as one release but are implemented separately. **Never
hold both specs in one session.**

Read `CLAUDE.md` first. Its architecture rules all still apply. The phosphor
design language (`specs/PHOSPHOR-REDESIGN.md`) is the visual authority.

## Scope

Exactly three places get real margin content in this epic: **/chat, /games,
/main**. Every other screen gets title + filler only. Margins for /market,
/board, /topic, and anything else are explicitly out of scope — Punky will
spec each one separately after considering its contents. Do not sketch,
stub, or "helpfully" pre-build them.

---

## Hard invariants (do not violate, ever)

1. **Ambient, never demanding.** The sidebar contains no unread badges, no
   counters that exist to be cleared, no notification dots, no flashing, no
   sound, no animation. It informs a user who looks at it and does nothing
   to a user who doesn't. This is philosophy, not styling.
2. **The sidebar is never the only home of information.** Every piece of
   content it shows must remain reachable at any width through means that
   already exist — existing commands (`/who`, `/here`, `/activity`,
   `/chrome`), in-flow rendering, or compact inline treatments on narrow
   layouts. Mobile users get a complete BBS; desktop users get the same
   BBS with furniture.
3. **No new terminal commands. None.** This epic adds zero commands. If a
   phase seems to need one, the design is wrong — stop and redesign around
   existing commands or width-dependent rendering. (Rationale: the command
   surface is already unwieldy; a consolidation redesign toward
   parameterized commands — e.g. `/topic new` — is planned separately.
   Nothing in this epic may pre-empt or complicate it.)
4. **It reads as terminal, not widget.** Same `--void` background as the
   terminal — no panel surface, no shadow, no rounded anything. Separated
   from the main pane by a single vertical rule (`--panel-edge` border or
   literal `│` glyphs). Same font, same line-height, content rendered in
   the same color classes the server already emits. Acceptance test: a
   full screenshot must read as one terminal with a framed region, not an
   app with a drawer.
5. **No collapse control.** No command, no chevron, no preference, no
   localStorage. The sidebar exists at or above the breakpoint and does
   not exist below it. The browser decides; the user does not.
6. **Additive protocol only.** One new server→client op (`panel`, defined
   below). No existing op or message shape changes. No schema changes.
7. **User colors are sacred** (phosphor invariant carried forward). Roster
   names render in each user's `preferred_color`. Users remain the only
   polychrome thing on screen.
8. **Accessibility.** The faux-code filler is `aria-hidden="true"`. Roster
   and stats content is real text, readable by screen readers. Nothing in
   the sidebar is focusable (it contains no interactive elements in v1).
   All content honors `prefers-reduced-motion` trivially because nothing
   moves.
9. **Privacy: locations are coarse.** Any roster that shows where a user
   is shows the *place tier only* (`in chat`, `on the board`, `in the
   arcade`, `browsing`). Never a topic title, never a DM state, never a
   specific game. (Full rules in PLACES.md §Roster privacy; duplicated
   here because the sidebar is where violations would render.)

---

## Layout

- `.app` gains a flex-**row** region wrapping the existing terminal column;
  the sidebar is its second child. `#inputbar` stays attached to the
  terminal column. `#status-strip` moves **outside** the row so it spans the
  full viewport width beneath both panes — one continuous baseline, one
  machine, two displays.
- Sidebar width: fixed `320px` (`clamp(280px, 24vw, 340px)` acceptable).
- **Breakpoint: 1100px, live-evaluated.** Above it the sidebar exists; below
  it the sidebar is absent and the place title falls back to in-flow
  terminal rendering exactly as today. A resize or device rotation across
  the breakpoint must attach/detach cleanly mid-session with no reload and
  no duplicate/missing title. This gets its own acceptance line every phase.
- The sidebar itself does not scroll in v1. Content that would overflow is
  capped at the data layer (roster caps, list limits), not scrolled.
- Behind modal overlays the sidebar dims naturally under the existing
  backdrop (`rgba(10,6,18,.9)`); no special handling.

## Vertical anatomy — the semantic gradient

Top to bottom, each zone dimmer than the one above; importance reads by
altitude, with no boxes or dividers inside the panel:

1. **Place title** — `--phos-bright`, standard glow, uppercase. This is the
   room's fixed nameplate; it never scrolls away. No header label, no frame
   caption — the place name *is* the header.
2. **Contextual content** — the room's margin data (per-place sections
   below; /chat, /games, /main only). System text in `--phos`/`--phos-dim`;
   user names in their own colors.
3. **Filler** — static faux-code in `--phos-faint`, fading to transparent
   over its final ~40% via CSS `mask-image` linear gradient. The panel has
   no bottom border; it dissolves into the void like a phosphor trace.

### Filler rules

- **Static.** No animation, no ticking, no rain. Rendered once per panel
  update, then inert. Zero runtime cost.
- Written as over-the-top haunted diagnostics that cannot be mistaken for a
  real fault: impossible modules (`ectoplasm.sys`, `séance_handler`),
  checksums failing against 1997, `RETRYING... RETRYING... (gave up, it's
  fine)`. If a reasonable user might file a bug report, rewrite it. Punky
  reviews the corpus before ship.
- Client-side library of ~8–12 blocks; one chosen per panel render. Filler
  height flexes to fill remaining space; it is clipped, never scrolled.
- `aria-hidden="true"` on the entire filler region.

## Protocol — the `panel` op

New server→client op; the client owns one panel renderer:

```
{ op:'panel',
  title:  'COMMONS',                  // uppercase place name
  sections: [                          // zero or more, rendered in order
    { kind:'roster', heading:'HERE NOW (4)',
      users:[ { name:'punkyroo', colorHtml:'<span ...>punkyroo</span>',
                away:'gardening'|null, idle:true|false } ] },
    { kind:'lines', heading:'TOP CHROME',
      lines:[ { html:'...' } ] }       // pre-rendered like printHTML
  ] }
```

- The op **replaces** the whole panel. No partial-update ops in v1 —
  simpler client, and panel payloads are tiny.
- **Choke point:** `routeGo()` in server.js is the single place screens
  change; it emits the `panel` op after rendering the screen. Per-place
  panel builders live beside the render functions (`panelForChat()`,
  `panelForGames()`, `panelForMenu()`); every other screen gets
  `{ title, sections:[] }` (title + filler only).
- **Live updates** reuse the existing broadcast discipline: when a room's
  margin data changes (someone enters/leaves chat, a leaderboard moves),
  the server re-sends the `panel` op to clients filtered by
  `currentScreen`, exactly like `broadcastChatFrom` filters today. Entering
  and leaving chat both pass through `routeGo`/disconnect, so occupant
  updates hook those two sites plus the disconnect cleanup path.
- Below the breakpoint the client still receives `panel` ops and uses only
  the title (in-flow fallback); sections and filler are not rendered.

## Title relocation

- At/above breakpoint: the place title renders **only** in the sidebar.
  The terminal keeps printing its arrival text on room entry (scrollback
  remains the travel log), but standing screen headers move to the margin.
- Below breakpoint: titles render in-flow. The server cannot know client
  width, so: the server *stops* printing standing headers for migrated
  screens and always sends the title in the `panel` op; the client renders
  it in the margin (wide) or in-flow (narrow). Width knowledge stays
  client-side only. Migrate screens one at a time (per phase) so nothing
  ever loses its title on either side of the breakpoint.

---

## Per-place margins (complete list — nothing else in this epic)

| Place | Margin content |
|---|---|
| /chat | Occupants roster: names in user colors; `/away` users dimmed with message; idle (10 min no input) rendered `--phos-dim`. Human declaration (away) wins over machine observation (idle). No timestamps, no counts beyond the heading. Narrow-width equivalent: existing `/here` and `/who` — nothing new to build. |
| /games | Chrome/game leaderboard (top 5), games activity log (last 8 — the prepared statement already exists in server.js), your own stats block. Unlocks: at wide widths the games menu goes dual-column like /main with inline stats stripped (they've moved to the margin). **At narrow widths the menu keeps a compact inline stats treatment** — stats are never removed from a layout that has no margin, and no command is added to compensate (invariants 2 and 3). Leaderboard and activity remain reachable via existing `/chrome` and `/activity`. |
| /main | Sitewide roster: everyone online, coarse location, away status. Cap at 20 + `+ N more · /who for all` (existing command). Below it, the activity feed's most recent 5 lines (ambience finally gets a home; full feed remains at existing `/activity`). |
| Everything else | Title + filler only. The node is attached; the room just has quiet margins. Future margins (/market, /board, ...) are separate future specs. |

Place taxonomy (add to CLAUDE.md as part of Phase 1):
**places** (screens with presence and a margin), **readouts** (screens that
are information only — title + filler), **programs** (modals — sidebar dims
behind the overlay). Every future feature answers "is this a place?" first.

---

## Phases

### Phase 1 — Skeleton + /chat occupants (ships the user request)
- Layout wrapper, full-width footer, breakpoint with live attach/detach.
- `panel` op, client renderer, semantic-gradient anatomy, filler library
  (initial corpus of 4+ blocks, flagged for Punky's review).
- Title relocation for /chat and /main only (in-flow fallback below
  breakpoint; server stops printing standing headers for these two).
- `panelForChat()`: occupants roster with user colors + idle dimming.
  (Away rendering lands with PLACES.md Phase 3; roster schema includes the
  `away` field from day one so no protocol change later.)
- Re-broadcast panel to chat occupants on enter/leave/disconnect.
- Gate: screenshots ≥1100px and ≤1099px of /chat and /main; live resize
  across the breakpoint mid-session; two-browser test showing roster
  updating on join/leave; `preferred_color` spans verified in roster;
  screen reader pass (filler silent, roster read); **grep confirms zero
  new `case '...':` command entries in the diff.**

### Phase 2 — /games margin + dual-column menu
- `panelForGames()`: leaderboard, games log, personal stats.
- Games menu to dual-column at wide widths (reuse /main's `padTo` +
  narrow-width pattern, see the existing check near line ~5262), inline
  stats stripped there; compact inline stats retained at narrow widths.
- Gate: screenshots wide/narrow; confirm every game still launches; narrow
  menu shows compact stats; zero new commands in the diff.

### Phase 3 — /main roster + activity ambience
- Sitewide roster with coarse locations (invariant 9), 20-cap, away/idle
  states; activity feed tail (5 lines).
- Depends on PLACES.md Phase 3 (/away) for away data; ships after it.
- Gate: screenshots; verify coarse-location mapping covers every screen
  name (unknown screens → `browsing`); cap behavior with fake load; zero
  new commands in the diff.

Out of scope / future specs: /market ticker, /board and /topic margins,
filler corpus expansion, any `/sidebar`-style control, and any command
consolidation work.

---

## Testing checklist (every phase)
- Live breakpoint crossing attaches/detaches cleanly; title never doubled
  or missing on either side.
- Full-screenshot "one terminal, not an app with a drawer" review.
- No sidebar element is focusable; filler is `aria-hidden`.
- `/crt off|soft|full` all render the sidebar correctly.
- User `preferred_color` spans unchanged wherever names render.
- No console errors; chat send/receive and one game open/close still work.
- Mobile (~390px) sees no sidebar and loses no information (invariant 2
  spot-check for anything the phase moved into the margin).
- Diff contains zero new terminal commands (invariant 3).
