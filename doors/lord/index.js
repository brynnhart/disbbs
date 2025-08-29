// Legend of the Redux Dragon (LORD) — door module (MVP scaffold)
// File: doors/lord/index.js
//
// What you get in this MVP:
// - Per-user player record (created on first enter)
// - Daily turns (reset at midnight UTC)
// - /stats, /fight, /heal, /help  inside the door
// - Simple forest fight loop (1 turn per fight), gold/xp gains/losses
// - Sandcastle-friendly: only essential state is stored
//
// Integration contract (already provided by your core):
// - DoorManager.enter(api, state, 'lord') is called by /play lord
// - Global /leave is handled by your core (no need to implement here)
// - Use api.print / api.printHTML / api.hr like other screens

const DOOR_ID = 'lord';
const DOOR_NAME = 'Legend of the Redux Dragon';

// --- Config knobs ---
const DAILY_TURNS = 20;           // how many turns per day
const FOREST_BASE_HP = 8;         // enemy base HP scaler
const FOREST_GOLD_RANGE = [3,9];  // min/max gold reward
const FOREST_XP_RANGE   = [2,6];  // min/max xp reward
const HEAL_COST = 5;              // gold to fully heal at the inn

// Utility: now (epoch seconds)
function now() { return Math.floor(Date.now()/1000); }
// Midnight UTC epoch for "today"
function todayMidnightUTC() {
  const d = new Date();
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())/1000|0;
}

// Random helpers
function randInt(min, max){ return Math.floor(Math.random()*(max-min+1))+min; }
function clamp(n,a,b){ return Math.max(a, Math.min(b, n)); }

// Escape just in case
function escapeHTML(s){
  return String(s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

// --- Schema (run at boot via door.migrate(db)) ---
// Tables are namespaced to avoid collisions with other doors.
function migrate(db){
  db.exec(`
    CREATE TABLE IF NOT EXISTS lord_players (
      user_id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,                  -- snapshot of username/display (we'll start with username)
      level INTEGER NOT NULL DEFAULT 1,
      xp INTEGER NOT NULL DEFAULT 0,
      gold INTEGER NOT NULL DEFAULT 0,
      hp INTEGER NOT NULL DEFAULT 10,
      hp_max INTEGER NOT NULL DEFAULT 10,
      turns_left INTEGER NOT NULL DEFAULT ${DAILY_TURNS},
      last_turn_reset INTEGER NOT NULL DEFAULT 0, -- epoch at last reset
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS lord_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      kind TEXT NOT NULL,                  -- 'fight','heal','level','death', etc.
      body TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_lord_logs_user_created ON lord_logs(user_id, created_at DESC);
  `);
}

function getStatements(db){
  return {
    findPlayer:    db.prepare(`SELECT * FROM lord_players WHERE user_id = ?`),
    insertPlayer:  db.prepare(`
      INSERT INTO lord_players (user_id, name, level, xp, gold, hp, hp_max, turns_left, last_turn_reset, created_at, updated_at)
      VALUES (?, ?, 1, 0, 0, 10, 10, ${DAILY_TURNS}, 0, strftime('%s','now'), strftime('%s','now'))
    `),
    updatePlayer:  db.prepare(`
      UPDATE lord_players
         SET level = ?, xp = ?, gold = ?, hp = ?, hp_max = ?, turns_left = ?, last_turn_reset = ?, updated_at = strftime('%s','now')
       WHERE user_id = ?
    `),
    insertLog:     db.prepare(`
      INSERT INTO lord_logs (user_id, kind, body, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?)
    `),
    recentLogs:    db.prepare(`
      SELECT kind, body, created_at
        FROM lord_logs
       WHERE user_id = ?
         AND (expires_at IS NULL OR expires_at > strftime('%s','now'))
       ORDER BY created_at DESC
       LIMIT 20
    `)
  };
}

// --- Per-session helpers ---
function ensurePlayer(db, state, stmts){
  // Create player row if missing
  let p = stmts.findPlayer.get(state.userId);
  if (!p){
    const display = state.displayName ? state.displayName : (state.username || 'adventurer');
    stmts.insertPlayer.run(state.userId, display);
    p = stmts.findPlayer.get(state.userId);
  }
  // Daily turn reset
  const tMid = todayMidnightUTC();
  if (p.last_turn_reset < tMid){
    p.turns_left = DAILY_TURNS;
    p.last_turn_reset = tMid;
    stmts.updatePlayer.run(p.level, p.xp, p.gold, p.hp, p.hp_max, p.turns_left, p.last_turn_reset, state.userId);
  }
  return p;
}

function logEvent(db, stmts, uid, kind, body, ttlDays=7){
  const created = now();
  const expires = ttlDays > 0 ? created + ttlDays*86400 : null;
  try { stmts.insertLog.run(uid, kind, body, created, expires); } catch(_){}
}

function levelCheckAndApply(p){
  // Simple leveling: every 20 XP = +1 level, +2 hp_max, full heal on level-up
  const needed = (p.level * 20);
  if (p.xp >= needed){
    p.level += 1;
    p.xp -= needed;
    p.hp_max += 2;
    p.hp = p.hp_max;
    return { leveled: true };
  }
  return { leveled: false };
}

// --- Rendering helpers ---
function renderHeader(api){
  api.hr();
  api.print('== Legend of the Redux Dragon ==', 'magenta');
  api.print('Type /help for commands. /leave to exit.', 'dim');
  api.hr();
}
function renderStats(api, p){
  api.printHTML(
    `Name: <strong>${escapeHTML(p.name)}</strong>  ` +
    `Level: <strong>${p.level}</strong>  ` +
    `HP: <strong>${p.hp}/${p.hp_max}</strong>  ` +
    `Gold: <strong>${p.gold}</strong>  ` +
    `XP: <strong>${p.xp}</strong>  ` +
    `Turns left: <strong>${p.turns_left}</strong>`
  );
}

function enter(api, state, args){
  if (!state || !state.userId){
    api.print('You must be logged in to play.', 'yellow');
    return;
  }
  // Cache a door-local bag on the session if needed in the future
  state.door = state.door || {};
  state.currentScreen = `door:${DOOR_ID}`;

  const db = require('../../server').__db; // <- lightweight way to access db if you export it (see patch note below)
  const stmts = getStatements(db);
  const p = ensurePlayer(db, state, stmts);

  api.batch(b=>{
    b.clear();
    renderHeader(b);
    b.print('Welcome to the forest trail. The Redux Dragon lurks somewhere beyond…', 'white');
    renderStats(b, p);
    b.hr();
    b.print('Commands: /stats, /fight, /heal, /help, /leave', 'cyan');
  });
}

function handleCommand(cmd, api, state, args){
  const db = require('../../server').__db;
  const stmts = getStatements(db);
  let p = ensurePlayer(db, state, stmts);

  switch(cmd){
    case 'help':
      api.print('LORD commands:', 'yellow');
      api.print('  /stats   Show your current status', 'cyan');
      api.print('  /fight   Spend 1 turn fighting a forest foe', 'cyan');
      api.print(`  /heal    Fully heal for ${HEAL_COST} gold at the Inn`, 'cyan');
      api.print('  /leave   Exit back to the command hub', 'cyan');
      return true;

    case 'stats':
      renderStats(api, p);
      return true;

    case 'heal': {
      if (p.hp >= p.hp_max){
        api.print('You are already at full health.', 'dim');
        return true;
      }
      if (p.gold < HEAL_COST){
        api.print(`You need ${HEAL_COST} gold to heal at the Inn.`, 'yellow');
        return true;
      }
      p.gold -= HEAL_COST;
      p.hp = p.hp_max;
      stmts.updatePlayer.run(p.level, p.xp, p.gold, p.hp, p.hp_max, p.turns_left, p.last_turn_reset, state.userId);
      logEvent(db, stmts, state.userId, 'heal', `Healed to full for ${HEAL_COST} gold.`);
      api.print('You rest at the Inn and feel restored.', 'green');
      renderStats(api, p);
      return true;
    }

    case 'fight': {
      if (p.turns_left <= 0){
        api.print('You are out of turns today. Return tomorrow!', 'yellow');
        return true;
      }
      // Simple enemy stats scale lightly with player level
      const foeHpMax = FOREST_BASE_HP + Math.floor(p.level*1.2);
      let foeHp = foeHpMax;

      // One quick exchange: player hits, foe hits (very simple MVP)
      const playerHit = randInt(2, 4 + p.level);   // player's damage
      foeHp = Math.max(0, foeHp - playerHit);

      api.printHTML(`You strike the forest foe for <strong>${playerHit}</strong>!`);

      let outcome = null;
      if (foeHp <= 0){
        const gold = randInt(...FOREST_GOLD_RANGE);
        const xp   = randInt(...FOREST_XP_RANGE);
        p.gold += gold;
        p.xp   += xp;
        p.turns_left -= 1;

        const check = levelCheckAndApply(p);
        stmts.updatePlayer.run(p.level, p.xp, p.gold, p.hp, p.hp_max, p.turns_left, p.last_turn_reset, state.userId);

        logEvent(db, stmts, state.userId, 'fight', `Victory! +${gold}g, +${xp}xp.`, 7);
        api.printHTML(`Victory! You gain <strong>${gold} gold</strong> and <strong>${xp} xp</strong>.`, 'green');
        if (check.leveled){
          logEvent(db, stmts, state.userId, 'level', `Leveled up to ${p.level}!`, 7);
          api.printHTML(`[cyan]Level up![/cyan] You are now level <strong>${p.level}</strong>. HP fully restored.`);
        }
        renderStats(api, p);
        return true;
      }

      // Foe strikes back if alive
      const foeHit = randInt(1, 3 + Math.floor(p.level/2));
      p.hp = clamp(p.hp - foeHit, 0, p.hp_max);
      p.turns_left -= 1;

      let msg = `The foe hits you for <strong>${foeHit}</strong>!`;
      if (p.hp <= 0){
        // Knocked out: lose some gold, respawn at 1 HP
        const loss = Math.min(p.gold, randInt(1, 5));
        p.gold -= loss;
        p.hp = Math.ceil(p.hp_max/2); // wake up half
        logEvent(db, stmts, state.userId, 'death', `Knocked out. Lost ${loss} gold.`, 7);
        msg += ` You are knocked out and lose ${loss} gold. You wake up later…`;
      }

      stmts.updatePlayer.run(p.level, p.xp, p.gold, p.hp, p.hp_max, p.turns_left, p.last_turn_reset, state.userId);
      api.printHTML(msg, p.hp<=0 ? 'red' : undefined);
      renderStats(api, p);
      return true;
    }

    default:
      return false;
  }
}

function handleRaw(text, api, state){
  // LORD expects commands, but for friendliness let raw "fight" trigger /fight
  const t = String(text || '').trim().toLowerCase();
  if (!t) return true;
  if (t === 'fight') return handleCommand('fight', api, state, []);
  if (t === 'stats') return handleCommand('stats', api, state, []);
  api.print('Unknown input. Use /fight, /stats, /heal, /help, or /leave.', 'dim');
  return true;
}

function leave(api, state){
  // Nothing special yet; if you later add timers, clear them here.
}

module.exports = {
  id: DOOR_ID,
  name: DOOR_NAME,
  migrate,
  enter,
  render: enter,           // <-- add this line
  handleCommand,
  handleRaw,
  leave
};
