'use strict';

// Session C1 balance simulation — specs/DELVE.md Release plan, Session C
// gate. Standalone: no DB, no server, imports only DELVE_CONSTANTS and the
// real generateOffering() from src/services/delve.js. This is intentionally
// a PARALLEL implementation of the encounter/combat/loot math (it can't hit
// the DB the way src/services/delve.js's run engine does), reading the same
// constants so the numbers stay honest.
//
// This script reports; it never retunes. Nothing here writes back to
// DELVE_CONSTANTS or any file — the tuning decision is Punky's, after
// Session C2 adds the event deck to the model.
//
// Usage: node scripts/delve-sim.js

const { DELVE_CONSTANTS, generateOffering } = require('../src/services/delve');

const RUNS_PER_ARCHETYPE = 10000;
const GEAR_SAMPLES = 50; // averaged full-gear draws per archetype (see README below)
const FIGHTS_PER_DAY = DELVE_CONSTANTS.DAILY.FIGHTS_PER_DAY;
const SURFACE_HP_THRESHOLD = 0.35; // policy: surface once HP < 35% of max

function rand(lo, hi) { return lo + Math.random() * (hi - lo); }

function zoneForFathom(fathom) {
  const zones = DELVE_CONSTANTS.ZONES;
  for (const key of Object.keys(zones)) {
    const z = zones[key];
    if (fathom >= z.fathomMin && fathom <= z.fathomMax) return Number(key);
  }
  return 4;
}

function enemyStatsFor(zoneNum, fathom) {
  const zone = DELVE_CONSTANTS.ZONES[zoneNum];
  const growth = Math.pow(zone.growthPerFathom, fathom - zone.fathomMin);
  return {
    hp:  Math.max(1, Math.round(zone.enemyBase.hp  * growth)),
    atk: Math.max(1, Math.round(zone.enemyBase.atk * growth)),
    def: Math.max(0, Math.round(zone.enemyBase.def * growth)),
  };
}

function rollEncounterKind(lck) {
  const E = DELVE_CONSTANTS.ENCOUNTER;
  const eventChance = Math.min(E.EVENT_CHANCE_CAP, E.EVENT_CHANCE + lck * E.LCK_SHIFT_PER_POINT);
  return Math.random() < eventChance ? 'event' : 'fight';
}

function rollDamage(atk, def) {
  const [lo, hi] = DELVE_CONSTANTS.COMBAT.DAMAGE_VARIANCE;
  const base = Math.max(1, atk - def);
  return Math.max(1, Math.round(base * rand(lo, hi)));
}

function fightChromeReward(fathom, grd) {
  const L = DELVE_CONSTANTS.LOOT;
  return Math.round((L.CHROME_BASE + fathom * L.CHROME_PER_FATHOM) * (1 + L.CHROME_GRD_MULT * grd));
}

// Gear archetypes: each simulated run's stats are the base stats plus a
// fixed gear-stat block for that archetype. "Full common/uncommon/rare-tier
// gear" = 4 equipped items (2 weapon/armor/trinket-ish mix), each built via
// the REAL generateOffering() with 3 same-tier minerals, curses rejected
// (no generator parameter exists for either — see README below).
const TIER_MINERALS = {
  common:   ['bismuth', 'cinnabar'],
  uncommon: ['malachite', 'vitriol'],
  rare:     ['brimstone', 'obsidian'],
};
const GEAR_TYPES = ['weapon', 'armor', 'trinket', 'weapon'];

function rollUncursedItem(minerals, itemType) {
  let item;
  let guard = 0;
  do {
    item = generateOffering({ minerals, itemType });
    guard++;
  } while (item.cursed && guard < 500);
  return item;
}

function buildGearSet(tier) {
  if (!tier) return { hp: 0, atk: 0, def: 0, lck: 0, grd: 0 };
  const pool = TIER_MINERALS[tier];
  const total = { hp: 0, atk: 0, def: 0, lck: 0, grd: 0 };
  for (const itemType of GEAR_TYPES) {
    const minerals = [
      pool[Math.floor(Math.random() * pool.length)],
      pool[Math.floor(Math.random() * pool.length)],
      pool[Math.floor(Math.random() * pool.length)],
    ];
    const item = rollUncursedItem(minerals, itemType);
    for (const [stat, value] of Object.entries(item.stats)) {
      total[stat] = (total[stat] || 0) + value;
    }
  }
  return total;
}

// A single lucky/unlucky draw shouldn't define an archetype's whole power
// level, so this averages GEAR_SAMPLES independent full gear sets and holds
// the rounded average fixed across all RUNS_PER_ARCHETYPE simulated runs.
// This is a modeling choice, not spec-mandated — trivial to change (just
// the GEAR_SAMPLES constant) if a pure natural-roll model is wanted instead.
function averagedArchetypeGear(tier) {
  const sums = { hp: 0, atk: 0, def: 0, lck: 0, grd: 0 };
  for (let i = 0; i < GEAR_SAMPLES; i++) {
    const g = buildGearSet(tier);
    for (const stat of Object.keys(sums)) sums[stat] += g[stat] || 0;
  }
  const out = {};
  for (const stat of Object.keys(sums)) out[stat] = Math.round(sums[stat] / GEAR_SAMPLES);
  return out;
}

// One simulated run: descend repeatedly (events are the Session C1 stub —
// zero fight cost, no effect) until HP drops below the surface threshold,
// then surface; or die trying. No flee (not part of this policy).
function simulateRun(gear) {
  const base = DELVE_CONSTANTS.STATS.BASE;
  const maxHp = Math.max(1, base.hp + (gear.hp || 0));
  let hp = maxHp;
  const atk = Math.max(1, base.atk + (gear.atk || 0));
  const def = Math.max(0, base.def + (gear.def || 0));
  const lck = base.lck + (gear.lck || 0);
  const grd = base.grd + (gear.grd || 0);

  let depth = 0;
  let fightsUsed = 0;
  let chrome = 0;

  while (fightsUsed < FIGHTS_PER_DAY) {
    if (hp < SURFACE_HP_THRESHOLD * maxHp) {
      return { outcome: 'surfaced', depth, fightsUsed, chrome };
    }

    depth += 1;
    const zoneNum = zoneForFathom(depth);

    if (rollEncounterKind(lck) === 'event') continue; // Collapsed Gallery stub: zero cost

    fightsUsed += 1;
    const enemy = enemyStatsFor(zoneNum, depth);

    for (;;) {
      enemy.hp -= rollDamage(atk, enemy.def);
      if (enemy.hp <= 0) {
        chrome += fightChromeReward(depth, grd);
        break;
      }
      hp -= rollDamage(enemy.atk, def);
      if (hp <= 0) {
        return { outcome: 'died', depth, deathZone: zoneNum, fightsUsed, chrome: 0 };
      }
    }
  }

  return { outcome: 'surfaced', depth, fightsUsed, chrome };
}

function percentile(sortedArr, p) {
  if (!sortedArr.length) return 0;
  return sortedArr[Math.min(sortedArr.length - 1, Math.floor(p * (sortedArr.length - 1)))];
}
function median(arr) {
  const s = arr.slice().sort((a, b) => a - b);
  return percentile(s, 0.5);
}

function runArchetype(label, tier) {
  const gear = averagedArchetypeGear(tier);
  const results = [];
  for (let i = 0; i < RUNS_PER_ARCHETYPE; i++) results.push(simulateRun(gear));

  const depths = results.map(r => r.depth).sort((a, b) => a - b);
  const deaths = results.filter(r => r.outcome === 'died');
  const deathsByZone = { 1: 0, 2: 0, 3: 0, 4: 0 };
  for (const d of deaths) deathsByZone[d.deathZone] = (deathsByZone[d.deathZone] || 0) + 1;
  // Includes 0 for died runs — reflects actual expected chrome per attempt,
  // not just per successful surface.
  const chromeBanked = results.map(r => r.chrome);
  const fightsUsed = results.map(r => r.fightsUsed);

  console.log(`\n=== ${label} ===`);
  console.log(`gear: ${JSON.stringify(gear)}`);
  console.log(`runs: ${RUNS_PER_ARCHETYPE}`);
  console.log(`median depth: ${median(depths)}   p90 depth: ${percentile(depths, 0.9)}`);
  console.log(`death rate: ${(deaths.length / RUNS_PER_ARCHETYPE * 100).toFixed(1)}%`);
  console.log('deaths by zone: ' + Object.entries(deathsByZone)
    .map(([z, n]) => `Z${z}: ${n} (${(n / RUNS_PER_ARCHETYPE * 100).toFixed(1)}%)`).join('  '));
  console.log(`median chrome banked (incl. deaths as 0): ${median(chromeBanked)}`);
  console.log(`median fights used: ${median(fightsUsed)}`);
}

console.log('Delve balance simulation — Session C1');
console.log(`policy: descend until HP < ${SURFACE_HP_THRESHOLD * 100}% max, then surface. No flee. No self-tuning — report only.`);

runArchetype('Naked', null);
runArchetype('Full common-tier gear', 'common');
runArchetype('Full uncommon-tier gear', 'uncommon');
runArchetype('Full rare-tier gear', 'rare');
