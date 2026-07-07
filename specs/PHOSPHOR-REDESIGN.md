# DIS Phosphor Redesign — "Cybergoth CRT" Theme Spec

Reskin the DIS client so it reads as a haunted purple-phosphor CRT terminal
instead of a dark-mode web app. This is a **presentation-layer project**: nearly
all work happens in `public/index.html`. The server's print API, WebSocket
protocol, database, and command handlers are not redesign targets.

Read `CLAUDE.md` first. Its architecture rules all still apply.

---

> **Canonical visual reference:** `specs/phosphor-mockup.png`.
> When any styling decision is ambiguous, match the screenshot.
> The mockup shows /main in crt-soft mode; extrapolate its treatment
> (glow, scanlines, box-drawing frames, purple voice / teal structure)
> to all other screens and modals.

## Hard invariants (do not violate, ever)

1. **No server print-call rewrites.** The server emits color class names
   (`red green yellow blue magenta cyan white dim` — see `ALLOWED_COLORS` in
   `src/utils/formatting.js`). The retheme happens by redefining what those
   classes render as in the client CSS. Do not edit `b.print(...)` /
   `api.print(...)` call sites except where a phase explicitly says so.
2. **User colors are sacred.** Chat messages carry per-user inline
   `<span style="color:...">` from `preferred_color` (see `bodyWithColor` in
   server.js). These must render exactly as before. Users are the only
   polychrome thing on the screen; the system itself is near-monochrome.
3. **No database changes. No schema changes. Nothing destructive.** This
   project needs zero migrations. If you believe a phase needs one, stop and
   ask instead.
4. **Protocol changes are additive-only** and only where a phase explicitly
   allows a new op. The existing op dispatcher and message shapes are frozen.
5. **Accessibility is not optional.** Real `<label>`s, focus-visible styles,
   and keyboard operability survive every reskin. All motion effects respect
   `prefers-reduced-motion` (resolve to CRT `off` mode).
6. **One phase per session.** Complete a phase, summarize what changed, stop
   for review. Do not start the next phase without approval. Commit per phase.

---

## Design language

**Concept:** RobCo terminal energy, cybergoth palette. One dominant phosphor
color for the machine, restrained accents, glow and scanlines as an optional
layer, box-drawing furniture, and system fiction in the chrome. The machine is
monochrome and haunted; the users glow in their own colors inside it.

### Token palette (new `:root` layer)

Replace the current `:root` colors with a token layer. Suggested defaults
below — Punky may substitute canonical GvG palette hexes at review:

```css
:root{
  /* surfaces */
  --void:#0a0612;          /* page bg — near-black with violet cast */
  --panel-new:#100920;     /* modal / inputbar surface — see naming note below */
  --panel-edge:#2a1a3e;    /* borders, dividers */

  /* phosphor (ichor purple) — the machine's voice */
  --phos-bright:#e6d5ff;   /* headings, emphasis */
  --phos:#c9a8ff;          /* default system text */
  --phos-dim:#7a5ba8;      /* secondary, metadata, timestamps */
  --phos-faint:#4a3568;    /* disabled, hints, ghost text */

  /* accents — used sparingly */
  --venom:#3ddbc4;         /* secondary accent: frames, success, links */
  --venom-dim:#1d8f80;
  --spite:#ff5a7a;         /* alerts, errors, destructive */
  --gold:#e8c15a;          /* warnings, section headers, treasure */

  /* effects */
  --glow-phos:0 0 6px rgba(178,122,255,.45);
  --glow-venom:0 0 6px rgba(61,219,196,.4);
  --glow-spite:0 0 7px rgba(255,90,122,.5);
}
```

> **Naming collision found in Phase 0:** `index.html`'s existing `:root` already
> defines `--panel:#050505` (used by `#inputbar` and elsewhere). The token
> layer above is named `--panel-new` instead of `--panel` to avoid silently
> redefining that existing variable while both layers coexist. Phase 1's
> remap must retire the old `--panel:#050505` usage sites and rename
> `--panel-new` → `--panel` at that point (same pattern already anticipated
> for `--red/--cyan/...` below — this one just wasn't called out).
> **Resolved in Phase 1:** `--panel-new` renamed to `--panel:#100920`,
> replacing the old `#050505` value outright (no alias indirection needed —
> unlike the color classes, nothing needed the old surface value preserved).

### Server color-class remap

Keep the class names; change their meaning. Every existing server print
retunes itself automatically:

| Class      | Old meaning     | New rendering                          |
|------------|-----------------|----------------------------------------|
| `.cyan`    | cyan            | `--phos` (system default voice)        |
| `.white`   | white           | `--phos-bright`                        |
| `.magenta` | magenta         | `--phos-bright`                        |
| `.blue`    | blue            | `--venom-dim`                          |
| `.green`   | green           | `--venom` (success)                    |
| `.yellow`  | yellow          | `--gold` (headers, emphasis)           |
| `.red`     | red             | `--spite` (alerts, errors)             |
| `.dim`     | opacity .75     | `color:var(--phos-dim); opacity:1`     |

Links: `--venom` with underline; hover `--phos-bright`.
`--accent` becomes `var(--phos)`; audit every place `--accent`, `--cyan`, and
raw `#19C3C3`-family hexes appear in index.html and migrate them to tokens.

Inside game modals, internal semantics stay but recolor to palette equivalents
(e.g. Wordle: correct = `--venom`, present = `--gold`, absent = panel gray).

### Typography

- Self-host **Web IBM VGA 8x16** from the Ultimate Oldschool PC Font Pack
  (CC BY-SA 4.0 — include attribution in `/about`) in `public/fonts/`
  (woff2 + woff). It has full CP437 box-drawing/block coverage.
  > **Correction found in Phase 0:** the pack's official web-fonts download
  > (`oldschool_pc_font_pack_v2.2_web.zip`) ships **`.woff` only** —
  > `Web437_IBM_VGA_8x16.woff`. There is no upstream `.woff2`. The `.woff2`
  > in `public/fonts/` was generated locally (woff→ttf via `fonteditor-core`,
  > then ttf→woff2 via `wawoff2`) and verified to round-trip decompress with
  > box-drawing/block glyphs intact at their Unicode codepoints. If the font
  > is ever re-fetched from upstream, redo this conversion — don't expect a
  > `.woff2` to already exist in the download.
- Font stack: `'Web IBM VGA', 'VT323', ui-monospace, Menlo, Consolas, monospace`.
- Base size up from 14px to 16–17px (bitmap fonts need it); verify mobile
  legibility at the smallest breakpoint. Never below 14px anywhere.
- Line height stays tight (~1.35) — terminal, not blog.

### CRT effect layer (`/crt` modes)

Three modes, client-side, persisted in `localStorage`, new terminal command:

- `/crt off`  — tokens + typography only, zero effects. Also forced by
  `prefers-reduced-motion`.
- `/crt soft` — **default.** Scanlines (one full-viewport overlay div with a
  `repeating-linear-gradient`, `pointer-events:none`), subtle vignette
  (radial-gradient overlay), glow via `text-shadow` on *system chrome only*
  (headers, banner, prompt, status strip, modal frames) — **not** on every
  chat line (perf: thousands of lines with text-shadow will jank scroll).
- `/crt full` — soft + slow phosphor flicker on the overlay (CSS animation,
  opacity ±2–3%, several-second period, nothing seizure-adjacent) + blinking
  block cursor everywhere + slightly stronger glow.

Implementation: a `data-crt="off|soft|full"` attribute on `<body>`; all
effect CSS keys off it. Overlays are two fixed divs appended once, not
per-element decoration. No WebGL in this project (a shader pass may come
later from the GvG CRT work; leave a seam, don't build it).

### Furniture

- `.rule` becomes a box-drawing divider (`─` repeat or styled border), phosphor.
- `.banner` becomes a framed header: `╔═[ TITLE ]═╗` aesthetic. Provide a small
  client-side helper that wraps a title into a frame so future features reuse it.
- Progress/meter rendering helper using `▓▒░` block characters (used by
  mining/chrome displays where they already render bars, and by the status strip).

---

## Phases

### Phase 0 — Scaffolding (no visible change)
- Add font files + `@font-face` (don't switch the stack yet).
- Add the token layer to `:root` alongside existing vars (unused for now).
- Add `data-crt` attribute plumbing, `/crt` command (client-side handling of
  the command input before send, like other local commands if any exist —
  otherwise a minimal server command that just echoes; prefer pure client),
  localStorage persistence, `prefers-reduced-motion` override.
- Gate: nothing looks different; `/crt` toggles the attribute (verify in
  devtools).

### Phase 1 — Tokens, remap, typography
- Switch font stack; bump base size; retune spacing where the new font breaks
  alignment.
- Apply the color-class remap table. Migrate all raw hexes and `--accent`
  usages in index.html to tokens. Old `--red/--cyan/...` vars may remain as
  aliases pointing at the new tokens during transition.
- Restyle `.line.me` (currently cyan wash) to a faint phosphor wash with
  `--phos-dim` left border, `border-radius:0`.
- Links, scrollbars, selection color (`::selection` in dim phosphor) to match.
- Gate: full screenshot review of `/main`, `/chat`, `/help`, `/mining` text
  output. User chat colors must be visibly unchanged.

### Phase 2 — CRT effect layer
- Implement `soft` and `full` per spec. Verify: 60fps scroll in a chat with
  500+ lines (glow must not be on `.line`), overlay doesn't intercept clicks,
  modals render above or below the scanlines consistently (pick: scanlines
  above everything at very low opacity — it's a monitor).
- Gate: screenshots of all three modes + a scroll-perf sanity check.

### Phase 3 — Input bar + status strip
- **Input bar** stops looking like a web form. Kill the rounded bordered
  input box: transparent background, no border, no radius; the input sits on
  the `--panel` bar directly after the `DIS>` prompt like one continuous
  terminal line. Caret in `--phos`. Placeholder in `--phos-faint`.
  Keep `#cmdTextarea` expanded mode working (it may keep a faint top border
  to show its extent). Restyle `.btn` and `.input-toggle` as terminal keycaps:
  square, `--panel-edge` border, uppercase bracket labels (`[SEND]`, `[⇕]`),
  hover = phosphor border + glow. Char-limit prompt states: keep the existing
  `.limit` / `.limit-over` hooks; over-limit renders `--spite`.
- **Status strip**: new one-line footer under the input bar (or integrated at
  its edge): `USR: <handle> · NODE 01 · <screen> · <HH:MM:SS>` in
  `--phos-dim`, clock ticking client-side. Populate from state the client
  already has (username, current screen). **Optional, allowed additive op:**
  a `status` op (`{op:'status', chrome:<n>}`) the server can send after
  chrome-affecting actions so the strip can show `CHR <n>`; wire it into at
  most the chrome service's existing mutation points. If this turns invasive,
  ship the strip without chrome and note it.
- Gate: screenshots desktop + narrow mobile width; expanded textarea mode;
  keyboard-only walkthrough (tab order, focus visibility).

### Phase 4 — Unified modal frame system
- Build one shared CSS system: `.term-window` (frame), `.term-titlebar`
  (`═[ TITLE ]═` style, `--phos-bright` + glow), `.term-window-controls`
  (close as `[X]`), `.term-btn`, `.term-input`, `.term-select` primitives.
  Overlay backdrop: near-black violet (`rgba(10,6,18,.9)`).
- Migrate all ten modals to it: `pxa, grf, wordle, slots, mining, bj, synth,
  tracker, hack, dots`. Preserve every modal's internal layout and JS hooks
  (IDs and classes used by scripts must keep working — restyle, don't rename;
  add new classes alongside where needed).
- The hack modal is already green-CRT flavored — restyle its *frame* to match
  the system, but its interior may keep RobCo green as an in-fiction "foreign
  terminal" Easter egg. Punky decides at review.
- Gate: screenshot every modal, desktop + mobile. Play one round of each game
  to confirm no JS broke.

### Phase 5 — Auth / landing
- Replace the tabbed web card with a terminal boot experience:
  1. Boot sequence types itself out (fast, skippable on click/keypress, and
     instant when `prefers-reduced-motion`): fake ROM lines, e.g.
     `DEADNET UNIFIED ACCESS SYSTEM v0.13` / `(C) 1997-∞ DEAD INTERNET
     SOCIETY` / `NODE 01 · 2400 BAUD (EMULATED)` / `CARRIER DETECTED` /
     `HANDSHAKE OK`. Keep total under ~2.5s.
  2. Splash: keep the existing `#auth-splash` SVG slot; frame it in
     box-drawing. (ANSI-art splash rotation is future work — leave the slot.)
  3. Login form restyled as terminal fields: uppercase `--phos-dim` labels
     (`HANDLE:`, `PASSCODE:`), underline-only inputs on the void background,
     block caret, `[ LOG IN ]` / `[ JOIN ]` as keycap buttons instead of
     tabs (same show/hide logic as current tabs). Error box in `--spite`
     with glow. Forgot-password flow keeps working, restyled.
  4. Real `<form>`, real labels, autocomplete attrs for password managers
     untouched.
- Gate: screenshots of boot, login, join, error, forgot states; confirm a
  real login round-trip works.

### Phase 6 — System fiction polish
- Rework the `/main` banner and welcome output: framed `DEADNET` masthead,
  fake copyright, node line. This phase MAY touch the specific server
  handlers that print the banner/menu (`cmdHelp` / main menu around
  `'Programs:'` in server.js) — formatting only, same commands listed,
  two-column layout using padded monospace.
- Post-login connect sequence in the terminal: 2–3 lines
  (`CARRIER DETECTED... WELCOME BACK, <HANDLE>`) printed client-side.
- `/about` gains the font attribution and a line of lore.
- Gate: final full walkthrough, all screens, both CRT soft and off.

## Phase 7 — Rule + header primitives

1. RULE RESTYLE (client-side only). Reimplement the op_hr handler / .rule
   rendering: instead of the gradient div, emit a character rule —
   ─ repeated with a single centered ornament glyph:
     ─────────────────◆─────────────────
   - Run characters: --phos-dim, no glow. Ornament: --venom, no glow.
   - Same text reset as the frame helper: letter-spacing:0; line-height:1.
   - Generate the string generously long and clip via overflow:hidden on the
     line (authentic terminal behavior; no resize listeners needed).
   - Keep the ornament glyph in one named constant (RULE_ORNAMENT = '◆') so
     it can be swapped later. Verify ◆ has a glyph in the VGA webfont; if
     not, fall back to '×'.
   - This upgrades every existing b.hr()/api.hr() site-wide with ZERO server
     changes. Do not touch server hr call sites.

2. TITLED RULE (shared helper, client-rendered, server-triggered). Add a
   'hrTitled' op + api helper (api.hrTitled('POLLS')) rendering:
     ──[ POLLS ]─────────────────────────
   - Left-anchored. Title: --phos-bright with standard glow. Runs: --phos-dim.
   - Additive protocol change only: new op, new api method, nothing existing
     modified.

3. While in the /main render path, fix the unread-DM alert line: remove the
   hardcoded color:#ff6b6b inline style and the 📬 emoji. Use the .main-alert
   (--spite) treatment: !! NEW DIRECT MESSAGES: <n> !!

Gate: screenshot /main and /announcements (which already uses hr heavily).
Stop for review.

## Phase 8 — View migration (run in batches, one batch per session)

Convert every terminal view's section headers from the legacy pattern
  b.print('== Title ==', 'magenta'); b.hr();
to a single api.hrTitled('TITLE') call. Rules that merely separate content
stay as plain hr (already restyled by Phase 7).

Conventions for all views:
- Full box frames (renderBoxFrame) are reserved for menus and menu-like
  screens ONLY (/main, /help, /games list). Everything else uses titled
  rules — do not frame ordinary content views.
- Column/tabular output (e.g. /market prices) aligns with padTo like the
  main menu; audit for hardcoded hex colors and emoji in view output and
  migrate to palette classes / text glyphs. Report anything ambiguous
  rather than guessing.
- Never modify the CONTENT of what views print — headers, rules, colors,
  and alignment only.

Batch A: /help, /about, /rules, /announcements, /profile
Batch B: /board, /links, /polls, /feed
Batch C: /chat, /messages, /market, /chrome, /activity, /games list

Gate per batch: screenshot every view in the batch, desktop + narrow
mobile, and stop. /chat additionally requires a live message send/receive
check and confirmation that user preferred_color spans are unchanged.

---

## Testing checklist (every phase)
- `/crt off|soft|full` all render correctly for the phase's surfaces.
- Narrow mobile viewport (≈390px) usable and legible.
- User `preferred_color` spans render unchanged in `/chat`.
- No console errors; WebSocket flows (chat send, a game open/close) still work.
- `prefers-reduced-motion` produces the `off` experience.


