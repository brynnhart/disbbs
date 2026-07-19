# DELVE — The Ancestral Caves

A contained push-your-luck roguelite in the LORD "forest fights" tradition.
Players descend into the catacombs beneath the world, fight LORD-simple
battles, and accumulate chrome / minerals / items **in pocket**. Surfacing
banks the pocket. Dying loses it. The deeper you go, the harder the enemies
and the richer the rewards. Command: `/delve`.

Read `CLAUDE.md` first. Its architecture rules all still apply. This spec
follows the conventions established by the existing modal games (see the
`/hack` implementation as the reference pattern) and the PHOSPHOR-REDESIGN
token/frame system.

---

## Hard invariants (do not violate, ever)

1. **No deletions, no destructive migrations.** New tables only
   (`ensureDelveSchema`). Never `DELETE FROM users` or any content table.
   Delve code writes only to Delve tables and mutates balances **only**
   through the existing chrome service and the existing
   `resource_balances` prepared statements. Nothing in this feature
   deletes user accounts or user content, ever.
2. **Server-authoritative run state, persisted.** The run lives in the
   database, not in the modal and not in an in-memory Map. Closing the
   modal, refreshing, disconnecting, or a server restart must all land the
   player back exactly where they were. The client renders state; it never
   owns it.
3. **Full-snapshot reply contract.** Every Delve action from the client is
   answered with one `delve_state` op carrying the *complete* current run
   snapshot plus a `narration` array of new log lines. The client
   re-renders from the snapshot every time. No incremental-diff ops, no
   client-side simulation. (This is deliberately stricter than /hack —
   Delve state is too rich to patch safely.)
4. **All economy mutations are transactional.** Banking a pocket (chrome +
   minerals + items) happens inside one `db.transaction`. An offering
   (consume 3 minerals → create 1 item) is one transaction. No partial
   states are ever observable.
5. **Additive protocol only.** New `type:` messages and new `op:`s. The
   existing dispatcher entries and message shapes are frozen.
6. **100% WebSocket.** No new REST endpoints.
7. **The engine is a service, not inline code.** Per CLAUDE.md, the Delve
   domain lives in `src/services/delve.js` as
   `createDelveService({ db, chrome, timeUtils, hub })` — run engine,
   offering generator, combat math, event deck, persistence. server.js
   gets only the command case, message routing, and thin handlers that
   call the service. (The /hack-style inline pattern is explicitly *not*
   the model here — Delve is a full domain.)
8. **Tone rules are load-bearing** (see next section). Flavor text that
   violates them is a bug, not a style choice.
9. **Commands are global, per the CLAUDE.md world model.** Delve adds
   these global verbs and no others: `/delve` (the caves view — tableau,
   status, command menu), `/descend`, `/offer`, `/gear`, `/equip`,
   `/unequip`, `/sooth`, `/fathoms`. All work from anywhere on the BBS;
   entrance-only functions are gated by *game state* (no active run
   below the surface), never by screen, and rejections are in-fiction
   ("You are fourteen fathoms deep. The altar is far above you.").
   Naming discipline: no generic nouns — which is why records are
   `/fathoms`, not `/records`. If a phase seems to need another verb,
   stop and redesign.
10. **Delve is invisible to presence.** `/delve` and its verbs are
   terminal renders and the run modal — no new routed screen, no
   `currentScreen` changes, so coarse locations are untouched by
   construction. No roster, panel, or presence surface may ever show
   that someone is delving, their depth, or their pocket. Depth
   bragging happens only through published records: the boards, the
   Memorial Wall, and the activity feed.
11. **One phase per session.** Complete a phase, summarize, stop for
   review. Commit per phase. Do not start the next phase without approval.

---

## Fiction & tone

**Setting.** The Ancestral Caves: catacombs beneath the world, older than
anyone's records, where the ancestors mined and delved and eventually
stopped coming back. This is the Goth Girls vs The Goo universe —
gothic-medieval fantasy with magic that happens to *look* electric.
Candlelight and cathedrals; the occasional impossible machine humming in a
crypt, wrought-iron and unexplained.

**At the entrance (the tableau, always rendered when at depth 0):**
- **The Statue of Bahamet** — goat-headed ancestral god of the Goth Girls
  and Bat Fae. Where your shade reconstitutes when you die. Where you make
  **offerings** (three minerals → one item, the crafting system).
- **The Shadowkin fence** — a dark, vaguely demonic mercantile being.
  Friendly in a way that is slightly unsettling in form only. Not evil.
  Buys your castoff gear; sells a small rotating stock of shallow
  minerals. Named: **Sooth** (working name; Punky may rename at review).
- **The Gravemouth** — the descent itself, yawning behind.

Three stations, three verbs: **statue = death & offerings. Merchant =
buy/sell. Threshold = banking**, by the act of surfacing (automatic — there
is no "deposit" interaction).

**Tone rules (enforced vocabulary).**
- Register: alchemical / gothic / medieval. Vitriol, censers, strata,
  rites, fathoms, marrow, tallow, ossuary, reliquary, the delvers who
  never returned.
- Machines, when they appear (Zone 3), are *wrought*, they *hum*, they
  were *built by the ancestors for purposes unrecorded*. Their light has
  no visible source. No one in-fiction finds this strange.
- **Forbidden vocabulary in all Delve flavor text and names:** data,
  corrupted, glitch, process, protocol, network, net, cyber, jack in,
  upload/download, terminal, code, program, signal, firmware, mainframe,
  hack. (UI *chrome* the currency is fine — it's the established DIS
  currency — but never "chrome-plated cyberware"-style flavor.)
- Neon belongs to the **presentation layer** (phosphor glow, mineral-color
  accents), never to the fiction.

---

## Player model

**Branding note (per the CLAUDE.md world model):** stats and equipment
are the shared **character body** — world spine, not Delve features.
They ship first, unbranded, as the DIS character sheet; the Delve is
their first reader, not their owner. `/gear`, `/equip`, `/unequip`, and
`/offer` are announced as world features. Nothing in their views or
copy may imply they exist only for the Delve.

### Stats

Five stats. **Base (naked) values are constants — all progression is
equipment delta.**

| Stat | Base | Meaning |
|------|------|---------|
| HP   | 20   | Max hit points. Current HP persists across the run. |
| ATK  | 3    | Damage dealt per strike (before enemy DEF). |
| DEF  | 1    | Subtracted from incoming damage. |
| LCK  | 0    | Luck. Improves event odds/quality and flee chance. |
| GRD  | 0    | Greed. Improves chrome and mineral find rates. |

No XP. No levels. A fresh player and a naked veteran are identical.

### Equipment

- **4 equipment slots**, all generic (no weapon/armor slot typing — any
  item type can occupy any slot).
- **3 item types** (chosen at offering time; biases stat generation):
  - **Weapon** — biased toward ATK.
  - **Armor** — biased toward DEF/HP.
  - **Trinket** — biased toward LCK/GRD.
- Items are **account-bound** (not tradeable) for now, so the leaderboard
  means "earned my way down." The future player equipment market
  (Shadowkin network) may revisit this — design decision deferred.
- Equipping/unequipping is free at depth 0. **Mid-run, items found in
  pocket may be equipped between encounters** (equipping banks that item
  permanently — it survives death once worn). Unequipping mid-run is not
  allowed (things put on in the dark do not come off in the dark).
- Effective stats = base + sum of equipped item stats, floored: HP min 1,
  ATK min 1, DEF min 0, LCK/GRD may go negative (cursed builds).

### Inventory

- Unequipped owned items live in a simple inventory list (no cap for v1;
  revisit if hoarding becomes a problem).
- Pocket items (found during the current run) are separate and lost on
  death unless equipped mid-run.

---

## The offering (crafting)

At the Statue of Bahamet, at depth 0 only: choose exactly **3 minerals**
(any mix, duplicates allowed) and an **item type**. The minerals are
consumed. Bahamet grants one randomly generated item.

### Budget

Each mineral is worth **offering points equal to its market price floor**
(single source of truth — reuse `RESOURCE_FLOORS`):

| Mineral | Points | | Mineral | Points |
|---|---|---|---|---|
| Bismuth | 3 | | Brimstone | 25 |
| Cinnabar | 5 | | Obsidian | 40 |
| Malachite | 10 | | Alexandrite | 100 |
| Vitriol | 15 | | | |

`budget = points(a) + points(b) + points(c)` → range **9–300**.

### Variance (tier mixing)

Count distinct **tiers** among the three minerals (tiers per the existing
`RESOURCES` table: common / uncommon / rare / very_rare):

- 1 tier → effective budget × uniform(0.90, 1.10) — "a measured gift"
- 2 tiers → × uniform(0.80, 1.25) — "a curious gift"
- 3 tiers → × uniform(0.70, 1.45) — "a volatile gift"

Round to nearest integer, min 6.

### Curse roll

`curseChance = min(0.35, 0.08 + budget × 0.0009)`
(≈8.8% at budget 9, ≈35% at 300 — big offerings gamble bigger.)

If cursed: pick one stat (weighted: DEF 30%, HP 25%, ATK 20%, LCK 15%,
GRD 10%) and assign a **negative** value worth uniform(25%, 50%) of the
effective budget. That value is **added back** to the spendable budget —
curses concentrate, they don't diminish. An item never curses the same
stat it primarily rolls positive.

### Stat generation

Convert budget to stats using **point costs**:

| Stat | Cost per +1 |
|------|-------------|
| HP   | 2 |
| ATK  | 6 |
| DEF  | 6 |
| LCK  | 12 |
| GRD  | 12 |

Roll **2–4 positive affixes** (2 if budget < 30, 2–3 if < 90, 3–4
otherwise). Distribute the spendable budget across the chosen affixes
using type weights, then buy stat points at cost (remainders < smallest
affordable point are dropped — the god keeps the change):

| Type    | ATK | DEF | HP | LCK | GRD |
|---------|-----|-----|----|-----|-----|
| Weapon  | 60  | 5   | 15 | 10  | 10  |
| Armor   | 5   | 45  | 40 | 5   | 5   |
| Trinket | 5   | 5   | 20 | 35  | 35  |

(Weights select *which* affixes appear and how the budget splits; an
affix that rolls 0 points after costing is dropped.)

### Naming grammar (deterministic from the roll)

`[Cursed-prefix] <Mineral-prefix> <Type-noun> <Stat-suffix>`

- **Mineral prefix** from the highest-point mineral offered:
  - Bismuth: Pale, Prismatic, Hollow
  - Cinnabar: Vermilion, Quicksilver, Bleeding
  - Malachite: Verdant, Weeping, Mossbound
  - Vitriol: Caustic, Seething, Acrid
  - Brimstone: Sulfurous, Smoldering, Hellwrought
  - Obsidian: Glasswrought, Nightfaced, Knapped
  - Alexandrite: Twicelit, Changeling, Sovereign
- **Type noun**:
  - Weapon: Blade, Cleaver, Maul, Fang, Scourge, Pick
  - Armor: Shroud, Carapace, Vestment, Aegis, Pall, Cuirass
  - Trinket: Charm, Locket, Idol, Phylactery, Censer, Knucklebone
- **Stat suffix** from the positive stat that received the greatest
  **budget spend** (not the highest raw point total — HP's cheap point
  cost would otherwise make "of Marrow" dominate everything):
  - ATK: of Rending, of the Red Rite, of Sharp Prayers
  - DEF: of the Bulwark, of Stone Patience, of the Sealed Door
  - HP: of Deep Roots, of Marrow, of the Long Vigil
  - LCK: of Glimmers, of the Fickle Star, of Found Things
  - GRD: of the Hoard, of Grasping, of the Tithe
- **Cursed prefix** (prepended when cursed): Cracked, Whispering, Hungry,
  Thrice-Owned, Grudgeful

All word choices seeded from the item's generation roll so the name is
reproducible from the stored item row. Names are flavor only — stats are
authoritative.

### Selling to the Shadowkin

`sellPrice = max(1, floor(budget × 0.4))` chrome. Selling deletes the item
row (this is the **only** deletion Delve performs, and only of Delve item
rows owned by the seller, only on their explicit action).

### Merchant stock

Sooth sells a small rotating daily stock (seeded from `dayKeyET()`):
3 slots drawn from {bismuth, cinnabar, malachite, vitriol}, priced at
**current market price × 1.25** (the market stays the better deal; Sooth
is convenience). Quantity 5 per slot per day, shared across all users?
No — **per-user** quantity 5 (simpler, no race conditions, no feed-the
whales problem). Purchases go through `chrome.spend` +
`stmtAddResourceBal`.

---

## The Delve (run structure)

### Depth & zones

Depth is measured in **fathoms**, starting at 0 (the entrance). Each
**descend** action moves one fathom deeper and triggers an encounter.

| Zone | Fathoms | Name | Mineral drops |
|------|---------|------|---------------|
| 1 | 1–10  | The Gravemouth      | Bismuth, Cinnabar |
| 2 | 11–25 | The Sunken Chapels  | Malachite, Vitriol (+ Zone 1 @ 25%) |
| 3 | 26–45 | The Old Workings    | Brimstone, Obsidian (+ Zone 2 @ 25%) |
| 4 | 46+   | The Nameless Deep   | Alexandrite (+ Zone 3 @ 35%) |

Zone transitions get a one-time narration beat per run ("The chapel air
tastes of drowned incense…").

### Daily fights

- **15 fights per board day** (`dayKeyET()`), tracked in `delve_daily`.
- A **fight consumes one fight**. **Events consume zero.** Some events
  grant `bonus_fights` (added to today's allowance).
- Dying does not refund fights. If fights remain, a new run may begin
  immediately. **Multiple runs per day is a deliberate design decision:**
  depth is gated by the fight budget plus depth-reset-on-surface, so deep
  zones already demand one committed run — a lockout would only punish
  cheap shallow deaths (i.e., new players). *Tuning dial, post-launch
  only:* if live data shows deaths are too cheap, "death ends the delving
  day" is a one-constant hard-mode switch. Do not ship it in v1.
- When fights hit 0 mid-run, the player may only: resolve the current
  encounter (if any), **surface**, or **camp**.

### Encounters

On each descend, roll: **75% fight, 25% event** (LCK shifts this by
+0.5%/point toward events, capped at 35% events).

### Combat (LORD-simple)

Turn order: player first. Actions: **Attack** or **Flee**.

- Damage: `max(1, ATK − targetDEF)` then × uniform(0.85, 1.15), rounded.
- **Flee**: success = `50% + 2%×LCK` (capped 80%). Success ends the
  encounter, retreats one fathom (fight still consumed). Failure = enemy
  gets one free strike, combat continues.
- Enemy death → loot (below). Player death → death sequence (below).
- No potions, no skills, no items-in-combat for v1. The complexity budget
  goes to the meta-loop, not the battle screen.

### Enemy scaling

Per-zone base stats × per-fathom growth. One constants table drives it all
(single tuning surface — expect to iterate):

| Zone | Base HP | Base ATK | Base DEF | Growth/fathom (all stats) |
|------|---------|----------|----------|---------------------------|
| 1 | 8   | 2  | 0  | ×1.10 (compounding from zone start) |
| 2 | 30  | 8  | 3  | ×1.09 |
| 3 | 90  | 20 | 9  | ×1.08 |
| 4 | 260 | 48 | 22 | ×1.07 |

(Naked player comfortably handles fathoms 1–5; full common-tier gear
clears Zone 1; the wall between zones is intentional and gear-gated.
These numbers are starting guesses — Session C includes a simulation
script, see the Release plan.)

### Enemy roster (approved copy — written and tone-reviewed in an
earlier build; use verbatim, stats come from the scaling table)

**Zone 1 — The Gravemouth:** Bone Mouse — "skitters from a crack in the
wall, more joint than flesh." · Tallow Wisp — "drifts close, guttering,
smelling of old candle-fat." · Grave Beetle — "clatters over loose
stone, carapace stitched with old coin." · Rag Wraith — "unspools from a
burial shroud, reaching with borrowed hands." · Ossuary Rat — "bares
teeth grown long on marrow it wasn't owed." · Candle Mite (swarm) —
"crowds the dark, each one a guttering ember."

**Zone 2 — The Sunken Chapels:** Drowned Ghoul — "hauls itself from the
chapel floodwater, bloated with rite-wine." · Censer Haunt — "swings on
a chain no hand holds, smoke curdling into a shape." · Vestry Crawler —
"drags itself between the pews on too many elbows." · Choir of Teeth —
"opens a hundred mouths and sings off-key." · Palsied Acolyte —
"shambles forward, still murmuring a rite it forgot the ending to." ·
Font Leech — "uncoils from the baptismal font, fat on stolen blessings."

**Zone 3 — The Old Workings:** Delver Who Stayed — "turns toward you,
wearing gear you nearly recognize." · Wrought Warden — "grinds upright
on iron joints, its light without a source." · Gallery Stalker — "keeps
pace along the tunnel roof, patient as rust." · Lantern-Eater —
"swallows the last of the light and asks, politely, for more." · The
Foreman's Echo — "repeats an order to workers three centuries gone." ·
Chainswarm — "rises rattling from the workings, each link hungry on its
own."

**Zone 4 — The Nameless Deep:** Goo-Touched Mass — "sloughs toward you,
wrong in a way the eye slides off." · The Unshaped — "hasn't decided
what it is yet, and studies you for ideas." · Fathomer — "measures the
distance between you and the dark, and finds it small." · Alexandrite
Angel — "unfolds too many wings, each one a different color of wrong." ·
It That Tithes — "asks for a piece of you, and doesn't wait for an
answer." · The Third Shadow — "falls the wrong direction, and it is not
alone."

**Zone transitions (approved copy, one-time beat per zone per run):**
Z1 "The Gravemouth swallows you whole. The dark is older than you are."
· Z2 "The chapel air tastes of drowned incense." · Z3 "The tunnels here
are cut too straight to be natural. Something worked this stone." · Z4
"The dark stops behaving. You are somewhere the ancestors didn't name."

### Loot (per fight won) — the pocket

- **Chrome:** `round((3 + fathom × 1.5) × (1 + 0.03×GRD))`.
- **Mineral drop chance:** `25% + 1.5%×GRD` (cap 55%). On hit, draw from
  the zone's drop table (weights within zone proportional to the existing
  `RESOURCES` weights among eligible minerals).
- **Item drop chance:** `4% + 0.2%×LCK` (cap 8%). Dropped items are
  generated exactly like offerings, with budget = a virtual 3-mineral
  offering drawn from the zone's drop table, random type. Found items go
  to **pocket**.
- Everything above accrues **in pocket**, prominently displayed. Nothing
  is real until surfaced.

### Events (25% of encounters; weighted deck)

| Weight | Event | Effect |
|--------|-------|--------|
| 20 | **Wayside Shrine** | Restore 50% max HP. |
| 16 | **Chrome Seam** | Pocket +`(10 + 4×fathom) × (1+0.03×GRD)` chrome. |
| 14 | **Mineral Pocket** | Pocket +2 draws from zone drop table. |
| 12 | **A Cached Memory** | +2 fights today. ("Someone left strength here for whoever came next.") |
| 12 | **The Gambler** | Optional: double-or-nothing on pocket **chrome** (50/50, LCK +1%/pt, cap 60%). Decline freely. |
| 10 | **Wandering Shadowkin** | Sooth's cousin. Offers 1 randomly generated item (zone-budget) at `budget × 1.2` chrome, payable **from pocket chrome only**. |
| 8  | **Cursed Altar** | Optional: bleed `25% current HP` → receive a pocket item rolled with **curse guaranteed** (and its budget bonus). |
| 6  | **Collapsed Gallery** | Nothing here but dust. (A miss keeps the deck honest.) |
| 2  | **Alexandrite Seam** *(Zone 3–4 only)* | Pocket +1 Alexandrite. |

LCK also upgrades quality where noted. Choice events resolve via
`delve_event_choice`. The deck is data — adding events post-launch is a
row, not a feature. (Future hook, not v1: an UwU egg event in Zone 4.)

### Surfacing (banking)

Available **between encounters only** (never mid-combat). One transaction:
- Pocket chrome → `chrome.award(username, n, 'delve surfaced from N fathoms')`
- Pocket minerals → `resource_balances`
- Pocket items → owned inventory
- HP restored to max. Run ends. Depth recorded in `delve_log` as
  `outcome='surfaced'`.

### Camping

If the player is out of fights (or just wants to stop) they may **camp**
at depth instead of surfacing: the run pauses in place, pocket intact,
until they next enter the Delve (any later day). On resume: restore 25%
max HP, then **35% ambush chance** — a zone-appropriate fight begins
immediately (consuming a fight; if none remain, the ambush still
happens — the cave does not check your ledger). Camping is the greedy
option and should feel like one.

### Death

HP ≤ 0: the pocket is lost where it fell. Narration beat, then the player
wakes at the feet of the Statue of Bahamet ("Your shade gathers itself at
the statue's feet. Your hands are empty."). Equipped items are kept
(including pocket items equipped mid-run). Run ends; `delve_log` records
`outcome='died'` at that fathom. No other penalty — losing the pocket is
the penalty.

### Leaderboards

Derived from `delve_log` by query (no separate tables):
- **Deepest surfaced this week** — headline board. Depth counts **only on
  a surfaced run** (you must come back alive). Week = ISO week of
  `dayKeyET()`.
- **Deepest surfaced, all time** — hall of fame.
- **The Memorial Wall** — deepest *deaths*, all time, carved-stone styled.
  Grim honor. ("Here fell <handle>, at 44 fathoms.")

**Sidebar (SIDEBAR.md integration).** The GAMES panel's YOUR STATS
section gains exactly one line, following the existing wordle/hack
pattern in `panelForGames`: `delve: N fights left` (or
`delve: camped at N fathoms` when a camped run exists, or
`delve: out of fights today`). One line, no new section, no other margin
content — further Delve margin presence is out of scope per SIDEBAR.md.

Activity feed hooks (`addActivityEvent('games', 'delve_…', …)` — category
`games`, so lines surface in the arcade sidebar's ACTIVITY section like
the other games): new weekly-board
leader, first Zone 3 / Zone 4 reach per user, deaths below 30 fathoms,
Alexandrite-grade offerings, cursed-item jackpots. Per CLAUDE.md the feed
is ambience, not spam: throttle repeatable Delve events to one per user
per day (graffiti-log pattern); one-time milestones are exempt. All
lines must pass the PLACES.md editorial policy — celebration and
invitation, not logging. A routine surfacing is a log line; a first
descent below 30 fathoms is feed-worthy.

---

## Database (all new; `ensureDelveSchema(db)` in src/database/index.js —
grown additively per session: Session A creates delve_items; Session B
adds delve_merchant_purchases; Session C adds delve_runs, delve_daily,
delve_log)

```sql
-- One live/camped run per user. State is a JSON blob: this is a single
-- actively-mutated document, not queryable data. Log/board queries use
-- delve_log, never this.
CREATE TABLE IF NOT EXISTS delve_runs (
  username   TEXT PRIMARY KEY,
  state      TEXT NOT NULL,      -- JSON: see Run state shape
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS delve_items (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  username     TEXT NOT NULL,
  name         TEXT NOT NULL,
  item_type    TEXT NOT NULL,     -- 'weapon' | 'armor' | 'trinket'
  stats        TEXT NOT NULL,     -- JSON {hp,atk,def,lck,grd} (any subset, curses negative)
  budget       INTEGER NOT NULL,
  cursed       INTEGER NOT NULL DEFAULT 0,
  equipped_slot INTEGER,          -- NULL or 1..4, UNIQUE per user per slot (enforce in code)
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_delve_items_user ON delve_items(username);

CREATE TABLE IF NOT EXISTS delve_daily (
  username     TEXT NOT NULL,
  day          TEXT NOT NULL,     -- dayKeyET()
  fights_used  INTEGER NOT NULL DEFAULT 0,
  bonus_fights INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (username, day)
);

-- Sooth's per-user daily purchase caps (created in Session B).
CREATE TABLE IF NOT EXISTS delve_merchant_purchases (
  username TEXT NOT NULL,
  day      TEXT NOT NULL,          -- dayKeyET()
  resource TEXT NOT NULL,
  qty      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (username, day, resource)
);

CREATE TABLE IF NOT EXISTS delve_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL,
  day           TEXT NOT NULL,
  depth         INTEGER NOT NULL,
  outcome       TEXT NOT NULL,    -- 'surfaced' | 'died'
  chrome_banked INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_delve_log_outcome ON delve_log(outcome, depth DESC);
CREATE INDEX IF NOT EXISTS idx_delve_log_user ON delve_log(username, created_at DESC);
```

### Run state shape (the `delve_runs.state` JSON)

```jsonc
{
  "depth": 14,
  "hp": 31,                    // current HP (max derives from equipment)
  "status": "idle",            // 'idle' (between encounters) | 'combat' | 'event' | 'camped'
  "pocket": {
    "chrome": 262,
    "minerals": { "malachite": 3, "vitriol": 1 },
    "items": [ { /* full item objects, not yet persisted to delve_items */ } ]
  },
  "encounter": {               // present when status is combat/event
    "kind": "fight",           // 'fight' | 'event'
    "enemy": { "name": "Censer Haunt", "hp": 41, "maxHp": 58, "atk": 11, "def": 4 },
    "event":  null             // or { id, ...choice payload } for events
  },
  "seed": "…",                 // run RNG seed material (audit/repro)
  "startedDay": "2026-07-07"
}
```

Server computes effective player stats fresh from `delve_items` on every
action (equipment is authoritative in SQL, not in the blob).

---

## Interaction model v2 — global verbs, one district

Per the CLAUDE.md world model, the Delve is a **district**: it consumes
minerals (offerings), produces chrome, minerals, and gear, and lives
fictionally at the Ancestral Caves. Its verbs are **global commands**,
exactly like `/mining` → `/market` → `/sell` — each one command, one
function, one view. There is no routed caves screen and no place-scoped
handler; `/delve` is the district's front door and menu, and the other
verbs work from anywhere their game state allows.

| command | function |
|---------|----------|
| `/delve` | the caves view: entrance tableau, your status (fights left, camped-run notice, equipped summary), and the menu of the verbs below |
| `/descend` | open the run modal (starts a run, or resumes an active/camped one) |
| `/offer <mineral> <mineral> <mineral> <weapon\|armor\|trinket>` | make an offering; the god's gift prints in the terminal |
| `/gear` | terminal view: 4 slots + inventory, stats, cursed stats in spite-red |
| `/equip <id> <slot>` / `/unequip <slot>` | change equipment |
| `/sooth` | terminal view: the stall — daily stock + your sellable gear with prices |
| `/sooth buy <mineral>` / `/sooth sell <id>` | trade with Sooth |
| `/fathoms` | terminal view: weekly board, all-time board, the Memorial Wall |

**State gating (server-enforced, in-fiction rejections):** `/offer`,
`/equip`, `/unequip`, and `/sooth` actions require no active run below
the surface — mid-run they reject with depth-flavored refusals.
`/descend` with an exhausted fight budget and no active run rejects
with "The cave will not have you again today." Views (`/delve`,
`/gear`, `/sooth` stock, `/fathoms`) always work.

All entrance functions are **server-rendered command handlers** — they
call the delve service and print via `api` (the `/market` pattern). They
are not WS message types. Mid-run pocket-equip remains in the modal (it
happens at depth, between encounters, per the Equipment rules).

## Run-modal WebSocket protocol

The retired entrance message types (`delve_offer`, `delve_equip`,
`delve_unequip`, `delve_sell`, `delve_buy`, `delve_board`) and the
`delve_offer_result` op must be **removed** — sanctioned as the one
exception to "additive protocol" because the feature never shipped.
The surviving protocol serves only the run modal:

**Client → server (`msg.type`):**

| type | payload | notes |
|------|---------|-------|
| `delve_getstate` | — | sent on modal open & reconnect |
| `delve_descend` | — | idle only; rolls encounter |
| `delve_attack` | — | combat only |
| `delve_flee` | — | combat only |
| `delve_event_choice` | `{choice}` | event only; 'accept'/'decline' etc. |
| `delve_surface` | — | idle only |
| `delve_camp` | — | idle only |
| `delve_pocket_equip` | `{pocketIndex, slot}` | mid-run idle only; pocket items only |

**Server → client (ops):**

| op | payload |
|----|---------|
| `openDelve` | — (emitted by `/descend`, never by `/delve`) |
| `delve_state` | full snapshot: run state, effective stats, equipment, pocket, fights remaining, `narration:[{text, cls}]` |
| `delve_error` | `{message}` — mirrors `hack_error` style |

Every action handler: `requireAuth` → validate against current
server-side state (reject out-of-phase actions with `delve_error`) →
mutate → persist → reply full `delve_state`.

State-phase validation is also the spam guard: an action that doesn't
match the run's current `status` is rejected without mutation, so
click-spamming `[ATTACK]` or `[DESCEND]` can never double-resolve. The
service must process one message per user at a time (better-sqlite3 is
synchronous, so ordinary sequential handling suffices — just never make
a handler `async` mid-mutation).

---

## UI (client, `public/index.html`)

**Terminal.** `cmdDelve` prints the caves view: tableau, status, and
command menu. `/gear`, `/sooth`, `/fathoms`, and offering results are
server-rendered terminal views in the `/market` style — box-drawing
frames welcome, no client-side state. The Records view is carved-stone
styled in phosphor; the Memorial Wall lists the deepest deaths. Item
names print in `--gold`, cursed stats in `--spite`, mineral names in
their `RESOURCES` colors.

**The run modal (combat only).** Standard modal conventions per
CLAUDE.md: `#delve-overlay` containing `#delve-modal`, built with
`document.createElement`, removed entirely on close, key handlers attach
on open / detach on close and never leak into the terminal. `.term-window`
frame, `.term-titlebar` (`═[ THE DELVE ]═`), `[X]` close, Esc-to-close
(closing ≠ surfacing; the run persists — hint line: "The cave keeps your
place."). Opened only by `/descend`.

**Modal layout, top to bottom:**
1. **Depth strip** — the signature element. Neon progress bar in mineral
   colors marking zone bands, current fathom numeral glowing
   `--phos-bright`, zone name beneath in `--phos-dim`.
   `FATHOM 14 — THE SUNKEN CHAPELS`.
2. **Pocket strip** — always visible, `--gold` with glow:
   `IN POCKET: 262 ₢ · 3 malachite · 1 vitriol · 1 item` and
   `FIGHTS LEFT: ▓▓▓▓▓▓░░░░░░░░░` (hack-style block meter).
3. **Scene panel** — narration log (scrolling, newest last), enemy line
   with HP bar during combat (`--spite` bar), event prompts with choice
   buttons.
4. **Action bar** — context-sensitive `.term-btn` keycaps:
   - idle: `[DESCEND]` `[SURFACE]` `[CAMP]` (+ `[EQUIP]` when pocket
     items exist → minimal in-modal pocket-equip prompt, the one
     equipment act that happens at depth)
   - combat: `[ATTACK]` `[FLEE]`
   - event: choice buttons
   On surfacing or death the modal closes itself back to the place, and
   the outcome (bank summary or the wake-at-the-statue beat) prints in
   the terminal.

No entrance sub-panels exist in the modal — offering altar, equipment
management, Sooth, and records are all terminal territory.

Palette semantics: system voice `--phos`; treasure/pocket `--gold`;
danger/enemy `--spite`; success/banked `--venom`. Respect
`prefers-reduced-motion` for the depth-bar pulse.

---

## Release plan & implementation sessions (fresh build; one production push per release)

**This is a clean-tree build.** An earlier build of this feature was
developed and then deliberately reverted before commit; no Delve code
exists in the codebase. Where this spec marks copy as "approved," it
was reviewed during that build — reuse it verbatim rather than
rewriting. Each release below is self-contained and carries the promise
of the next; sessions are one-per-sitting with a stop-for-review gate.

**Session A → Release 1: The Body & The Statue.**
From scratch: `ensureDelveSchema` with `delve_items` only;
`src/services/delve.js` — `createDelveService({ db, chrome, timeUtils,
hub })` exporting `DELVE_CONSTANTS` (every tuning table in this spec in
one object, the single tuning surface) and implementing the offering
generator (budget → variance → curse → affixes → point costs), the
naming grammar (budget-spend suffix rule), and
`computeEffectiveStats(username)`. Global command handlers printing via
`api` in the `/market` style: `/gear`, `/equip <id> <slot>`,
`/unequip <slot>`, `/offer <m> <m> <m> <type>`, with state gating
per Interaction Model v2 (gates ship now even though no run can exist
yet). Unbranded per the Player model note — no Delve, caves, or game
references anywhere in Release 1 surfaces. No modal code of any kind
this session. *Gate: full offer→gear→equip→unequip loop via typed
commands on the live board; transaction audit (minerals debited + item
row in one transaction); bad-input rejections in-fiction with no
mutation; curse spot-check (200 draws at budget 300 vs ~35% expected);
20 sample names reviewed — weapons carry ATK suffixes; grep confirms
zero forbidden vocabulary and zero Delve branding.*

**Session B → Release 2: Sooth arrives.**
Add `delve_merchant_purchases`; `/sooth`, `/sooth buy <mineral>`,
`/sooth sell <id>` per the Merchant sections (daily seeded stock,
market × 1.25 pricing, per-user cap 5, sale = floor(budget × 0.4) and
the only row deletion Delve ever performs); stall view in the `/market`
style; one activity-feed arrival line (celebration policy). *Gate:
buy/sell round-trips with cap enforcement; equipped/foreign-item sales
rejected without mutation; Sooth's bits tone-reviewed.*

**Session C → Release 3: The Gravemouth opens.** (Two sittings, one
production push: C1 then C2.)
*C1 — the run engine + modal:* `delve_runs`/`delve_daily`/`delve_log`;
the full run lifecycle per The Delve sections (descend/combat/flee/
surface/death/banking, daily fights, enemy scaling with the approved
roster copy, loot incl. item drops, persistence across
reconnect/restart, full-snapshot protocol); `/delve` (caves view) +
`/descend` + the run-only modal per the UI section, with mid-run
pocket-equip. *Gate: original run-engine gates — live round-trip with
balance audit, kill-server-mid-combat resume, two-tab no-double-resolve,
plus scripts/delve-sim.js (10k runs × naked/common/uncommon/rare
archetypes built via the real generator) with results reported, no
self-tuning.*
*C2 — events & camping:* the full event deck, choice events, bonus
fights, camping + ambush resume, per the Events and Camping sections.
*Gate: each event forced via a temporary sysop-only hook then removed;
restart-mid-choice resume; camp/ambush rates verified; sim extended
with the event deck and the full table reported for Punky's tuning
decision; all narration tone-reviewed.*

**Session D → Release 4: `/fathoms`.**
The records view (weekly board, all-time, Memorial Wall — depth counts
only on surfaced runs), remaining activity feed lines per the feed
policy, `renderGames`/`panelForGames` lines updated to what's live,
final flavor pass against the tone checklist, reduced-motion audit,
mobile pass. *Gate: boards populate from real log rows; Punky reads
every string; final full walkthrough.*

---

## Deferred (explicitly out of scope for v1)

Player-to-player equipment market (Shadowkin network), UwU
creatures/pets (Zone 4 egg event is the future hook), potions/consumables,
combat skills, inventory caps, item trading, seasonal board resets beyond
the weekly window, ANSI splash art for the tableau.
