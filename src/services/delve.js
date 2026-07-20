'use strict';

// The Delve — src/services/delve.js
// World spine (character body: stats, equipment, offerings) plus every
// tuning table the later Delve sessions will read. Session A wires up
// delve_items only; DELVE_CONSTANTS ships complete now (per specs/DELVE.md)
// so future sessions never invent numbers that drift from the spec.
//
// DELVE_CONSTANTS.MINERALS mirrors server.js's RESOURCES/RESOURCE_FLOORS
// values exactly (offering points = market price floor, per the spec's
// "single source of truth" note). createDelveService's dependency list is
// fixed to { db, chrome, timeUtils, hub } — RESOURCES isn't injected — so
// these numbers are a deliberate, documented duplicate. Keep them in
// lockstep with server.js if RESOURCE_FLOORS/RESOURCES ever change.

const DELVE_CONSTANTS = {
  STATS: {
    BASE: { hp: 20, atk: 3, def: 1, lck: 0, grd: 0 },
    // HP/ATK/DEF floor after equipment; LCK/GRD may go negative (cursed builds).
    FLOOR: { hp: 1, atk: 1, def: 0 },
    POINT_COST: { hp: 2, atk: 6, def: 6, lck: 12, grd: 12 },
  },

  MINERALS: {
    bismuth:     { points: 3,   tier: 'common' },
    cinnabar:    { points: 5,   tier: 'common' },
    malachite:   { points: 10,  tier: 'uncommon' },
    vitriol:     { points: 15,  tier: 'uncommon' },
    brimstone:   { points: 25,  tier: 'rare' },
    obsidian:    { points: 40,  tier: 'rare' },
    alexandrite: { points: 100, tier: 'very_rare' },
  },

  OFFERING: {
    // Keyed by distinct-tier count among the 3 offered minerals.
    VARIANCE_BY_TIER_COUNT: {
      1: [0.90, 1.10],
      2: [0.80, 1.25],
      3: [0.70, 1.45],
    },
    MIN_EFFECTIVE_BUDGET: 6,
    CURSE: {
      base: 0.08,
      perBudget: 0.0009,
      cap: 0.35,
      statWeights: { def: 30, hp: 25, atk: 20, lck: 15, grd: 10 },
      valuePct: [0.25, 0.50], // of effective (post-variance) budget
    },
    // "2 if budget < 30, 2-3 if < 90, 3-4 otherwise" — strict < semantics,
    // evaluated against the raw pre-variance budget.
    AFFIX_COUNT_BRACKETS: [
      { lt: 30, min: 2, max: 2 },
      { lt: 90, min: 2, max: 3 },
      { lt: Infinity, min: 3, max: 4 },
    ],
    TYPE_WEIGHTS: {
      weapon:  { atk: 60, def: 5,  hp: 15, lck: 10, grd: 10 },
      armor:   { atk: 5,  def: 45, hp: 40, lck: 5,  grd: 5 },
      trinket: { atk: 5,  def: 5,  hp: 20, lck: 35, grd: 35 },
    },
    // Minimum roll: if every rolled affix floors to zero, the item
    // instead receives +1 in its type's primary stat. No real offering
    // may produce a statless item.
    PRIMARY_STAT: { weapon: 'atk', armor: 'def', trinket: 'lck' },
    SELL_PCT: 0.4, // Session B: sellPrice = max(1, floor(budget * SELL_PCT))
  },

  NAMING: {
    MINERAL_PREFIX: {
      bismuth:     ['Pale', 'Prismatic', 'Hollow'],
      cinnabar:    ['Vermilion', 'Quicksilver', 'Bleeding'],
      malachite:   ['Verdant', 'Weeping', 'Mossbound'],
      vitriol:     ['Caustic', 'Seething', 'Acrid'],
      brimstone:   ['Sulfurous', 'Smoldering', 'Hellwrought'],
      obsidian:    ['Glasswrought', 'Nightfaced', 'Knapped'],
      alexandrite: ['Twicelit', 'Changeling', 'Sovereign'],
    },
    TYPE_NOUN: {
      weapon:  ['Blade', 'Cleaver', 'Maul', 'Fang', 'Scourge', 'Pick'],
      armor:   ['Shroud', 'Carapace', 'Vestment', 'Aegis', 'Pall', 'Cuirass'],
      trinket: ['Charm', 'Locket', 'Idol', 'Phylactery', 'Censer', 'Knucklebone'],
    },
    STAT_SUFFIX: {
      atk: ['of Rending', 'of the Red Rite', 'of Sharp Prayers'],
      def: ['of the Bulwark', 'of Stone Patience', 'of the Sealed Door'],
      hp:  ['of Deep Roots', 'of Marrow', 'of the Long Vigil'],
      lck: ['of Glimmers', 'of the Fickle Star', 'of Found Things'],
      grd: ['of the Hoard', 'of Grasping', 'of the Tithe'],
    },
    CURSED_PREFIX: ['Cracked', 'Whispering', 'Hungry', 'Thrice-Owned', 'Grudgeful'],
  },

  // Everything below is tuning surface for Session C/D — not read this
  // session, shipped now so numbers never drift from the spec. Names and
  // flavor here are internal identifiers only (never printed to players
  // in Release 1).
  DAILY: {
    FIGHTS_PER_DAY: 15,
  },

  ZONES: {
    1: { name: 'The Gravemouth',     fathomMin: 1,  fathomMax: 10,       minerals: ['bismuth', 'cinnabar'],     bleed: null,                        enemyBase: { hp: 8,   atk: 2,  def: 0  }, growthPerFathom: 1.10 },
    2: { name: 'The Sunken Chapels', fathomMin: 11, fathomMax: 25,       minerals: ['malachite', 'vitriol'],    bleed: { fromZone: 1, chance: 0.25 }, enemyBase: { hp: 30,  atk: 8,  def: 3  }, growthPerFathom: 1.09 },
    3: { name: 'The Old Workings',   fathomMin: 26, fathomMax: 45,       minerals: ['brimstone', 'obsidian'],   bleed: { fromZone: 2, chance: 0.25 }, enemyBase: { hp: 90,  atk: 20, def: 9  }, growthPerFathom: 1.08 },
    4: { name: 'The Nameless Deep',  fathomMin: 46, fathomMax: Infinity, minerals: ['alexandrite'],              bleed: { fromZone: 3, chance: 0.35 }, enemyBase: { hp: 260, atk: 48, def: 22 }, growthPerFathom: 1.07 },
  },

  ZONE_TRANSITIONS: {
    1: 'The Gravemouth swallows you whole. The dark is older than you are.',
    2: 'The chapel air tastes of drowned incense.',
    3: 'The tunnels here are cut too straight to be natural. Something worked this stone.',
    4: 'The dark stops behaving. You are somewhere the ancestors didn’t name.',
  },

  // Approved copy (tone-reviewed in an earlier build) — reuse verbatim.
  ENEMIES: {
    1: [
      { name: 'Bone Mouse',    flavor: 'skitters from a crack in the wall, more joint than flesh.' },
      { name: 'Tallow Wisp',   flavor: 'drifts close, guttering, smelling of old candle-fat.' },
      { name: 'Grave Beetle',  flavor: 'clatters over loose stone, carapace stitched with old coin.' },
      { name: 'Rag Wraith',    flavor: 'unspools from a burial shroud, reaching with borrowed hands.' },
      { name: 'Ossuary Rat',   flavor: 'bares teeth grown long on marrow it wasn’t owed.' },
      { name: 'Candle Mite',   flavor: 'crowds the dark, each one a guttering ember.', swarm: true },
    ],
    2: [
      { name: 'Drowned Ghoul',   flavor: 'hauls itself from the chapel floodwater, bloated with rite-wine.' },
      { name: 'Censer Haunt',    flavor: 'swings on a chain no hand holds, smoke curdling into a shape.' },
      { name: 'Vestry Crawler',  flavor: 'drags itself between the pews on too many elbows.' },
      { name: 'Choir of Teeth',  flavor: 'opens a hundred mouths and sings off-key.' },
      { name: 'Palsied Acolyte', flavor: 'shambles forward, still murmuring a rite it forgot the ending to.' },
      { name: 'Font Leech',      flavor: 'uncoils from the baptismal font, fat on stolen blessings.' },
    ],
    3: [
      { name: 'Delver Who Stayed', flavor: 'turns toward you, wearing gear you nearly recognize.' },
      { name: 'Wrought Warden',    flavor: 'grinds upright on iron joints, its light without a source.' },
      { name: 'Gallery Stalker',   flavor: 'keeps pace along the tunnel roof, patient as rust.' },
      { name: 'Lantern-Eater',     flavor: 'swallows the last of the light and asks, politely, for more.' },
      { name: 'The Foreman’s Echo', flavor: 'repeats an order to workers three centuries gone.' },
      { name: 'Chainswarm',        flavor: 'rises rattling from the workings, each link hungry on its own.', swarm: true },
    ],
    4: [
      { name: 'Goo-Touched Mass',   flavor: 'sloughs toward you, wrong in a way the eye slides off.' },
      { name: 'The Unshaped',       flavor: 'hasn’t decided what it is yet, and studies you for ideas.' },
      { name: 'Fathomer',           flavor: 'measures the distance between you and the dark, and finds it small.' },
      { name: 'Alexandrite Angel',  flavor: 'unfolds too many wings, each one a different color of wrong.' },
      { name: 'It That Tithes',     flavor: 'asks for a piece of you, and doesn’t wait for an answer.' },
      { name: 'The Third Shadow',   flavor: 'falls the wrong direction, and it is not alone.' },
    ],
  },

  ENCOUNTER: {
    FIGHT_CHANCE: 0.75,
    EVENT_CHANCE: 0.25,
    LCK_SHIFT_PER_POINT: 0.005, // toward events
    EVENT_CHANCE_CAP: 0.35,
  },

  COMBAT: {
    DAMAGE_VARIANCE: [0.85, 1.15],
    FLEE_BASE: 0.50,
    FLEE_PER_LCK: 0.02,
    FLEE_CAP: 0.80,
  },

  LOOT: {
    CHROME_BASE: 3,
    CHROME_PER_FATHOM: 1.5,
    CHROME_GRD_MULT: 0.03,
    MINERAL_DROP_BASE: 0.25,
    MINERAL_DROP_PER_GRD: 0.015,
    MINERAL_DROP_CAP: 0.55,
    ITEM_DROP_BASE: 0.04,
    ITEM_DROP_PER_LCK: 0.002,
    ITEM_DROP_CAP: 0.08,
  },

  EVENTS: [
    { id: 'wayside_shrine',       weight: 20, name: 'Wayside Shrine',       effect: 'Restore 50% max HP.' },
    { id: 'chrome_seam',          weight: 16, name: 'Chrome Seam',          effect: 'Pocket +(10 + 4*fathom) * (1 + 0.03*GRD) chrome.' },
    { id: 'mineral_pocket',       weight: 14, name: 'Mineral Pocket',       effect: 'Pocket +2 draws from the zone drop table.' },
    { id: 'cached_memory',        weight: 12, name: 'A Cached Memory',      effect: '+2 fights today.', bonusFights: 2 },
    { id: 'gambler',              weight: 12, name: 'The Gambler',          effect: 'Optional: double-or-nothing on pocket chrome (50/50, LCK +1%/pt, cap 60%).', choice: true },
    { id: 'wandering_shadowkin',  weight: 10, name: 'Wandering Shadowkin',  effect: 'Offers 1 item (zone-budget) at budget * 1.2 chrome, payable from pocket chrome only.', priceMult: 1.2 },
    { id: 'cursed_altar',         weight: 8,  name: 'Cursed Altar',         effect: 'Optional: bleed 25% current HP for a pocket item rolled with curse guaranteed.', choice: true, hpBleedPct: 0.25 },
    { id: 'collapsed_gallery',    weight: 6,  name: 'Collapsed Gallery',    effect: 'Nothing here but dust.' },
    { id: 'alexandrite_seam',     weight: 2,  name: 'Alexandrite Seam',     effect: 'Pocket +1 Alexandrite.', zoneMin: 3 },
  ],

  CAMP: {
    RESUME_HP_PCT: 0.25,
    AMBUSH_CHANCE: 0.35,
  },
};

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function weightedPick(weights) {
  const entries = Object.entries(weights);
  const total = entries.reduce((sum, [, w]) => sum + w, 0);
  let r = Math.random() * total;
  for (const [key, w] of entries) {
    r -= w;
    if (r <= 0) return key;
  }
  return entries[entries.length - 1][0];
}

function pickWeightedWithoutReplacement(weights, excludeStat, count) {
  const pool = Object.keys(weights)
    .filter(s => s !== excludeStat)
    .map(s => ({ stat: s, weight: weights[s] }));
  const picked = [];
  const n = Math.min(count, pool.length);
  for (let i = 0; i < n; i++) {
    const total = pool.reduce((sum, p) => sum + p.weight, 0);
    let r = Math.random() * total;
    let idx = 0;
    for (; idx < pool.length; idx++) {
      r -= pool[idx].weight;
      if (r <= 0) break;
    }
    if (idx >= pool.length) idx = pool.length - 1;
    picked.push(pool[idx].stat);
    pool.splice(idx, 1);
  }
  return picked;
}

function pickAffixCount(budget) {
  for (const bracket of DELVE_CONSTANTS.OFFERING.AFFIX_COUNT_BRACKETS) {
    if (budget < bracket.lt) {
      const span = bracket.max - bracket.min;
      return bracket.min + Math.floor(Math.random() * (span + 1));
    }
  }
  return 3; // unreachable (last bracket lt: Infinity), kept for safety
}

function pickMineralPrefixKey(minerals) {
  let best = minerals[0];
  let bestPoints = DELVE_CONSTANTS.MINERALS[best].points;
  for (const m of minerals.slice(1)) {
    const p = DELVE_CONSTANTS.MINERALS[m].points;
    if (p > bestPoints) { best = m; bestPoints = p; }
  }
  return best;
}

// Pure computation: budget -> variance -> curse -> affixes -> point costs
// -> name. No DB access, no side effects — reused for real offerings and
// (in later sessions) for zone-budget item drops.
function generateOffering({ minerals, itemType }) {
  const C = DELVE_CONSTANTS;
  const points = minerals.map(m => C.MINERALS[m].points);
  const budget = points.reduce((a, b) => a + b, 0);

  const tierCount = new Set(minerals.map(m => C.MINERALS[m].tier)).size;
  const [lo, hi] = C.OFFERING.VARIANCE_BY_TIER_COUNT[tierCount];
  const varianceFactor = lo + Math.random() * (hi - lo);
  const effectiveBudget = Math.max(
    C.OFFERING.MIN_EFFECTIVE_BUDGET,
    Math.round(budget * varianceFactor)
  );

  const curseChance = Math.min(C.OFFERING.CURSE.cap, C.OFFERING.CURSE.base + budget * C.OFFERING.CURSE.perBudget);
  const cursed = Math.random() < curseChance;

  let curseStat = null;
  let curseBudgetAmount = 0;
  let spendableBudget = effectiveBudget;

  if (cursed) {
    curseStat = weightedPick(C.OFFERING.CURSE.statWeights);
    const [pctLo, pctHi] = C.OFFERING.CURSE.valuePct;
    const pct = pctLo + Math.random() * (pctHi - pctLo);
    curseBudgetAmount = Math.round(effectiveBudget * pct);
    spendableBudget = effectiveBudget + curseBudgetAmount;
  }

  const affixCount = pickAffixCount(budget);
  const typeWeights = C.OFFERING.TYPE_WEIGHTS[itemType];
  const chosenStats = pickWeightedWithoutReplacement(typeWeights, curseStat, affixCount);
  const chosenTotalWeight = chosenStats.reduce((sum, s) => sum + typeWeights[s], 0);

  const stats = {};
  const spendPerStat = {};
  for (const stat of chosenStats) {
    const share = typeWeights[stat] / chosenTotalWeight;
    const spend = spendableBudget * share;
    spendPerStat[stat] = spend;
    const pts = Math.floor(spend / C.STATS.POINT_COST[stat]);
    if (pts > 0) stats[stat] = pts; // 0-point affixes are dropped — the god keeps the change
  }

  // Minimum roll: every affix floored to zero — grant +1 in the type's
  // primary stat rather than shipping a statless item.
  if (Object.keys(stats).length === 0) {
    stats[C.OFFERING.PRIMARY_STAT[itemType]] = 1;
  }

  if (cursed) {
    const curseStatPoints = -Math.floor(curseBudgetAmount / C.STATS.POINT_COST[curseStat]);
    if (curseStatPoints < 0) stats[curseStat] = curseStatPoints;
  }

  // Naming: mineral prefix from the highest-point mineral offered; stat
  // suffix from the positive stat with the greatest BUDGET SPEND (not
  // highest raw point total).
  const mineralKey = pickMineralPrefixKey(minerals);
  const mineralPrefix = pickRandom(C.NAMING.MINERAL_PREFIX[mineralKey]);
  const typeNoun = pickRandom(C.NAMING.TYPE_NOUN[itemType]);

  // Greatest budget spend among positive stats — not highest raw point
  // total, and not restricted to the rolled affix pool: a minimum-roll
  // stat has no recorded spend (defaults to 0) but is the only positive
  // stat present, so it still wins the suffix pick.
  let suffixStat = null;
  let bestSpend = -Infinity;
  for (const [stat, value] of Object.entries(stats)) {
    if (value <= 0) continue;
    const spend = spendPerStat[stat] !== undefined ? spendPerStat[stat] : 0;
    if (spend > bestSpend) { bestSpend = spend; suffixStat = stat; }
  }
  if (!suffixStat) suffixStat = chosenStats[0] || Object.keys(C.NAMING.STAT_SUFFIX)[0];
  const statSuffix = pickRandom(C.NAMING.STAT_SUFFIX[suffixStat]);

  let name = `${mineralPrefix} ${typeNoun} ${statSuffix}`;
  if (cursed) {
    name = `${pickRandom(C.NAMING.CURSED_PREFIX)} ${name}`;
  }

  return {
    name,
    itemType,
    stats,
    budget: spendableBudget,
    cursed,
  };
}

function createDelveService({ db, chrome, timeUtils, hub }) {
  const { nowEpoch } = timeUtils;
  const service = {};

  const stmtInsertItem      = db.prepare(`INSERT INTO delve_items (username, name, item_type, stats, budget, cursed, equipped_slot, created_at) VALUES (?, ?, ?, ?, ?, ?, NULL, ?)`);
  const stmtGetItemsByUser  = db.prepare(`SELECT * FROM delve_items WHERE username = ? ORDER BY created_at ASC`);
  const stmtGetItemById     = db.prepare(`SELECT * FROM delve_items WHERE id = ?`);
  const stmtGetSlotOccupant = db.prepare(`SELECT * FROM delve_items WHERE username = ? AND equipped_slot = ?`);
  const stmtSetEquippedSlot = db.prepare(`UPDATE delve_items SET equipped_slot = ? WHERE id = ?`);

  // Same table/semantics as server.js's resource_balances statements
  // (prepared fresh here since createDelveService's dependency list — per
  // specs/DELVE.md — doesn't inject server.js's statement objects).
  const stmtGetResourceBal    = db.prepare(`SELECT amount FROM resource_balances WHERE username = ? AND resource = ?`);
  const stmtDeductResourceBal = db.prepare(`UPDATE resource_balances SET amount = amount - ? WHERE username = ? AND resource = ?`);

  const stmtDeleteItem = db.prepare(`DELETE FROM delve_items WHERE id = ?`);

  function rowToItem(row) {
    if (!row) return null;
    return {
      id: row.id,
      username: row.username,
      name: row.name,
      item_type: row.item_type,
      stats: JSON.parse(row.stats),
      budget: row.budget,
      cursed: !!row.cursed,
      equipped_slot: row.equipped_slot,
      created_at: row.created_at,
    };
  }

  // Session C makes this real (delve_runs lookup). Returns null (no active
  // run) until then, so entrance gating is wired correctly from day one.
  // Gating checks below call `service.getActiveRun(...)` (not this local
  // function directly) so the lookup can be swapped on the returned
  // instance — e.g. injecting a fake active run in tests, or Session C
  // replacing the implementation outright — without touching call sites.
  service.getActiveRun = function getActiveRun(username) {
    return null;
  };

  function computeEffectiveStats(username) {
    const base = DELVE_CONSTANTS.STATS.BASE;
    const total = { hp: base.hp, atk: base.atk, def: base.def, lck: base.lck, grd: base.grd };
    const rows = stmtGetItemsByUser.all(username);
    for (const row of rows) {
      if (row.equipped_slot == null) continue;
      const stats = JSON.parse(row.stats);
      for (const key of Object.keys(stats)) {
        if (total[key] !== undefined) total[key] += stats[key];
      }
    }
    const floor = DELVE_CONSTANTS.STATS.FLOOR;
    total.hp  = Math.max(floor.hp, total.hp);
    total.atk = Math.max(floor.atk, total.atk);
    total.def = Math.max(floor.def, total.def);
    return total;
  }

  function getInventory(username) {
    const rows = stmtGetItemsByUser.all(username);
    const equipped = { 1: null, 2: null, 3: null, 4: null };
    const unequipped = [];
    for (const row of rows) {
      const item = rowToItem(row);
      if (item.equipped_slot) equipped[item.equipped_slot] = item;
      else unequipped.push(item);
    }
    return { equipped, unequipped, effectiveStats: computeEffectiveStats(username) };
  }

  function createOffering({ username, minerals, itemType }) {
    if (service.getActiveRun(username)) return { error: 'gated' };
    if (!Array.isArray(minerals) || minerals.length !== 3) return { error: 'bad_args' };

    const type = String(itemType || '').toLowerCase().trim();
    if (!DELVE_CONSTANTS.OFFERING.TYPE_WEIGHTS[type]) return { error: 'bad_type' };

    const normMinerals = minerals.map(m => String(m || '').toLowerCase().trim());
    for (const m of normMinerals) {
      if (!DELVE_CONSTANTS.MINERALS[m]) return { error: 'bad_mineral', mineral: m };
    }

    const counts = {};
    for (const m of normMinerals) counts[m] = (counts[m] || 0) + 1;
    for (const [m, need] of Object.entries(counts)) {
      const row = stmtGetResourceBal.get(username, m);
      const have = row ? row.amount : 0;
      if (have < need) return { error: 'insufficient', mineral: m };
    }

    const generated = generateOffering({ minerals: normMinerals, itemType: type });

    const insertId = db.transaction(() => {
      for (const [m, need] of Object.entries(counts)) {
        stmtDeductResourceBal.run(need, username, m);
      }
      const info = stmtInsertItem.run(
        username, generated.name, type, JSON.stringify(generated.stats),
        generated.budget, generated.cursed ? 1 : 0, nowEpoch()
      );
      return info.lastInsertRowid;
    })();

    return {
      ok: true,
      item: {
        id: insertId,
        username,
        name: generated.name,
        item_type: type,
        stats: generated.stats,
        budget: generated.budget,
        cursed: generated.cursed,
      },
    };
  }

  function equipItem({ username, itemId, slot }) {
    if (service.getActiveRun(username)) return { error: 'gated' };
    slot = parseInt(slot, 10);
    if (!Number.isInteger(slot) || slot < 1 || slot > 4) return { error: 'bad_slot' };

    const row = stmtGetItemById.get(itemId);
    if (!row || row.username !== username) return { error: 'not_found' };

    const result = db.transaction(() => {
      const occupantRow = stmtGetSlotOccupant.get(username, slot);
      let evicted = null;
      if (occupantRow && occupantRow.id !== row.id) {
        stmtSetEquippedSlot.run(null, occupantRow.id);
        evicted = rowToItem(occupantRow);
      }
      stmtSetEquippedSlot.run(slot, row.id);
      return { evicted };
    })();

    return { ok: true, item: rowToItem(stmtGetItemById.get(row.id)), evicted: result.evicted };
  }

  function unequipItem({ username, slot }) {
    if (service.getActiveRun(username)) return { error: 'gated' };
    slot = parseInt(slot, 10);
    if (!Number.isInteger(slot) || slot < 1 || slot > 4) return { error: 'bad_slot' };

    const row = stmtGetSlotOccupant.get(username, slot);
    if (!row) return { error: 'empty_slot' };

    stmtSetEquippedSlot.run(null, row.id);
    return { ok: true, item: rowToItem(row) };
  }

  // Sooth (Session B, revised): buys unequipped castoffs only. No stock,
  // no purchase caps — selling minerals would duplicate /market, and
  // selling gear would make Sooth a second gear faucet (see specs/DELVE.md,
  // "Sooth's role").
  function sellItem({ username, itemId }) {
    if (service.getActiveRun(username)) return { error: 'gated' };

    const row = stmtGetItemById.get(itemId);
    if (!row || row.username !== username) return { error: 'not_found' };
    if (row.equipped_slot != null) return { error: 'equipped' };

    const sellPrice = Math.max(1, Math.floor(row.budget * DELVE_CONSTANTS.OFFERING.SELL_PCT));

    db.transaction(() => {
      stmtDeleteItem.run(row.id);
      chrome.award(username, sellPrice, `sooth: sold ${row.name}`);
    })();

    return { ok: true, sellPrice, item: rowToItem(row) };
  }

  Object.assign(service, {
    DELVE_CONSTANTS,
    generateOffering,
    createOffering,
    equipItem,
    unequipItem,
    computeEffectiveStats,
    getInventory,
    sellItem,
  });
  return service;
}

module.exports = {
  createDelveService,
  DELVE_CONSTANTS,
};
