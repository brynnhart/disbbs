// doors/lord.js
// Legend of the Redux Dragon — safe-at-require, lazy DB init, creation flow, Town Square, combat, shops.

module.exports = {
  id: 'lord',
  name: 'Legend of the Redux Dragon',
  create(api, state, meta) {
    // ─────────────────────────────────────────────────────────────
    // Safe/lazy DB — fallback to memory if anything fails
    const G = (globalThis || global);
    const MEMKEY = '__LORD_MEM_STORE__';
    if (!G[MEMKEY]) G[MEMKEY] = { players: new Map(), proposals: [], nextProposalId: 1, mail: [], nextMailId: 1 };
    const MEM = G[MEMKEY];
    if (!MEM.players) MEM.players = new Map();
    if (!Array.isArray(MEM.proposals)) MEM.proposals = [];
    if (typeof MEM.nextProposalId !== 'number') MEM.nextProposalId = 1;
    if (!Array.isArray(MEM.mail)) MEM.mail = [];
    if (typeof MEM.nextMailId !== 'number') MEM.nextMailId = 1;

    let dbReady = false;
    let useDB = false;
    let db = null, selectPlayer = null, insertPlayer = null, updatePlayer = null, topHeroesStmt = null, opponentsStmt = null,
      selectMarriageCandidatesStmt = null, insertProposalStmt = null, selectProposalsForStmt = null, checkProposalStmt = null,
      deleteProposalStmt = null, deleteProposalsByPlayerStmt = null, selectMarriedPairsStmt = null,
      insertMailStmt = null, selectInboxMailStmt = null, selectMailByIdStmt = null, markMailReadStmt = null,
      selectOnlinePlayersStmt = null;

    function lazyInitDB() {
      if (dbReady) return;
      dbReady = true;
      try {
        const path = require('path');
        const Database = require('better-sqlite3');
        const DB_PATH = process.env.DB_PATH || path.resolve(__dirname, '..', 'dis.sqlite3');
        db = new Database(DB_PATH);

        db.exec(`
          CREATE TABLE IF NOT EXISTS lord_players (
            user_id      INTEGER PRIMARY KEY,
            char_name    TEXT NOT NULL,
            gender       TEXT,
            created_at   INTEGER NOT NULL,
            updated_at   INTEGER NOT NULL,
            last_seen    INTEGER NOT NULL DEFAULT 0,
            level        INTEGER NOT NULL DEFAULT 1,
            xp           INTEGER NOT NULL DEFAULT 0,
            hp           INTEGER NOT NULL DEFAULT 30,
            max_hp       INTEGER NOT NULL DEFAULT 30,
            gold         INTEGER NOT NULL DEFAULT 50,
            bank         INTEGER NOT NULL DEFAULT 0,
            weapon_idx   INTEGER NOT NULL DEFAULT 0,
            armor_idx    INTEGER NOT NULL DEFAULT 0,
            charm        INTEGER NOT NULL DEFAULT 0,
            kills        INTEGER NOT NULL DEFAULT 0,
            deaths       INTEGER NOT NULL DEFAULT 0,
            day_count    INTEGER NOT NULL DEFAULT 1,
            daily_json   TEXT,
            expert       INTEGER NOT NULL DEFAULT 0,
            screen       TEXT,
            gems         INTEGER NOT NULL DEFAULT 0,
            spouse_id    TEXT,
            spouse_name  TEXT,
            married_on   INTEGER NOT NULL DEFAULT 0,
            class_id     TEXT
          );
          CREATE INDEX IF NOT EXISTS idx_lord_players_updated ON lord_players(updated_at DESC);
          CREATE INDEX IF NOT EXISTS idx_lord_players_last_seen ON lord_players(last_seen DESC);
        `);

        db.exec(`ALTER TABLE lord_players ADD COLUMN IF NOT EXISTS gems INTEGER NOT NULL DEFAULT 0;`);
        db.exec(`ALTER TABLE lord_players ADD COLUMN IF NOT EXISTS spouse_id TEXT;`);
        db.exec(`ALTER TABLE lord_players ADD COLUMN IF NOT EXISTS spouse_name TEXT;`);
        db.exec(`ALTER TABLE lord_players ADD COLUMN IF NOT EXISTS married_on INTEGER NOT NULL DEFAULT 0;`);
        db.exec(`ALTER TABLE lord_players ADD COLUMN IF NOT EXISTS class_id TEXT;`);
        db.exec(`ALTER TABLE lord_players ADD COLUMN IF NOT EXISTS last_seen INTEGER NOT NULL DEFAULT 0;`);
        db.exec(`
          CREATE TABLE IF NOT EXISTS lord_proposals (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            from_id   TEXT,
            from_name TEXT,
            to_id     TEXT,
            to_name   TEXT,
            ts        INTEGER NOT NULL
          );
        `);

        db.exec(`
          CREATE TABLE IF NOT EXISTS lord_mail (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            to_id        TEXT NOT NULL,
            to_name      TEXT NOT NULL,
            from_id      TEXT NOT NULL,
            from_name    TEXT NOT NULL,
            ts           INTEGER NOT NULL,
            subject      TEXT NOT NULL,
            body         TEXT NOT NULL,
            unread       INTEGER NOT NULL DEFAULT 1,
            deleted_to   INTEGER NOT NULL DEFAULT 0,
            deleted_from INTEGER NOT NULL DEFAULT 0
          );
          CREATE INDEX IF NOT EXISTS idx_lord_mail_to_ts ON lord_mail(to_id, ts DESC);
          CREATE INDEX IF NOT EXISTS idx_lord_mail_from_ts ON lord_mail(from_id, ts DESC);
        `);

        selectPlayer = db.prepare(`SELECT * FROM lord_players WHERE user_id = ?`);
        insertPlayer = db.prepare(`
          INSERT INTO lord_players (
            user_id, char_name, gender, created_at, updated_at, last_seen,
            level, xp, hp, max_hp, gold, bank, weapon_idx, armor_idx,
            charm, kills, deaths, day_count, daily_json, expert, screen, gems,
            spouse_id, spouse_name, married_on, class_id
          ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        `);
        updatePlayer = db.prepare(`
          UPDATE lord_players
             SET char_name=?, gender=?, updated_at=?, last_seen=?,
                 level=?, xp=?, hp=?, max_hp=?, gold=?, bank=?, weapon_idx=?, armor_idx=?,
                 charm=?, kills=?, deaths=?, day_count=?, daily_json=?, expert=?, screen=?, gems=?,
                 spouse_id=?, spouse_name=?, married_on=?, class_id=?
           WHERE user_id=?
        `);
        topHeroesStmt = db.prepare(`
          SELECT char_name AS name, level, kills, deaths, (gold+bank) AS wealth
            FROM lord_players
           ORDER BY level DESC, kills DESC, wealth DESC
           LIMIT 20
        `);
        opponentsStmt = db.prepare(`
          SELECT user_id, char_name AS name, level, kills, deaths, gold
            FROM lord_players
           WHERE user_id != ?
           ORDER BY level DESC, xp DESC, kills DESC
           LIMIT 20
        `);
        selectMarriageCandidatesStmt = db.prepare(`
          SELECT user_id, char_name, level, charm
            FROM lord_players
           WHERE user_id != ? AND (spouse_id IS NULL OR spouse_id = '')
           ORDER BY level DESC, xp DESC, charm DESC
           LIMIT 20
        `);
        insertProposalStmt = db.prepare(`
          INSERT INTO lord_proposals (from_id, from_name, to_id, to_name, ts)
          VALUES (?, ?, ?, ?, ?)
        `);
        selectProposalsForStmt = db.prepare(`
          SELECT id, from_id, from_name, to_id, to_name, ts
            FROM lord_proposals
           WHERE to_id = ?
           ORDER BY ts ASC
           LIMIT 50
        `);
        checkProposalStmt = db.prepare(`
          SELECT id FROM lord_proposals WHERE from_id = ? AND to_id = ? LIMIT 1
        `);
        deleteProposalStmt = db.prepare(`DELETE FROM lord_proposals WHERE id = ?`);
        deleteProposalsByPlayerStmt = db.prepare(`DELETE FROM lord_proposals WHERE from_id = ? OR to_id = ?`);
        selectMarriedPairsStmt = db.prepare(`
          SELECT user_id, char_name, spouse_id, spouse_name, married_on
            FROM lord_players
           WHERE spouse_id IS NOT NULL AND spouse_id != ''
           ORDER BY married_on ASC, char_name ASC
        `);
        insertMailStmt = db.prepare(`
          INSERT INTO lord_mail (to_id, to_name, from_id, from_name, ts, subject, body, unread, deleted_to, deleted_from)
          VALUES (?, ?, ?, ?, ?, ?, ?, 1, 0, 0)
        `);
        selectInboxMailStmt = db.prepare(`
          SELECT id, to_id, to_name, from_id, from_name, ts, subject, body, unread
            FROM lord_mail
           WHERE to_id = ? AND deleted_to = 0
           ORDER BY ts DESC
           LIMIT 20
        `);
        selectMailByIdStmt = db.prepare(`
          SELECT id, to_id, to_name, from_id, from_name, ts, subject, body, unread
            FROM lord_mail
           WHERE id = ? AND to_id = ? AND deleted_to = 0
           LIMIT 1
        `);
        markMailReadStmt = db.prepare(`UPDATE lord_mail SET unread = 0 WHERE id = ?`);
        selectOnlinePlayersStmt = db.prepare(`
          SELECT user_id, char_name, level, last_seen
            FROM lord_players
           WHERE last_seen >= ?
           ORDER BY last_seen DESC
           LIMIT 60
        `);
        useDB = true;
      } catch (e) {
        useDB = false; // fall back silently; don't break DoorManager
        console.error('[lord] DB unavailable, using in-memory store:', e && e.message ? e.message : e);
      }
    }

    // ─────────────────────────────────────────────────────────────
    // Utilities & data
    const PROMPT = 'LORD>';
    const randInt = (a, b) => (a + Math.floor(Math.random() * (b - a + 1)));
    const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
    const nowEpoch = () => Math.floor(Date.now() / 1000);
    const ONLINE_WINDOW_SEC = 300;
    const FEATURE_GEMS = true;
    const GEM_DROP_RATE_SEARCH = 0.01;
    const JEWELER_DAILY_LIMIT = 3;
    const HEARTSTONE_HP = 2;
    const RING_CHARM_INC = 1;
    const CHARM_MAX = 10;
    const FLIRT_GOLD_MAX = 20;
    const FLIRT_XP_MAX = 10;
    const PROPOSAL_DAILY_LIMIT = 1;
    const DIVORCE_GOLD_COST = 25;
    const DIVORCE_CHARM_COST = 1;
    const DRAGON_LEVEL_REQ = 12;
    const DRAGON_FIND_CHANCE = 0.15;
    const DRAGON_GOLD_MIN = 500;
    const DRAGON_GOLD_MAX = 700;
    const CAMP_HEAL_PCT = 0.30;
    const DAILY_HEALS = 2;
    const BARD_XP = 10;
    const BARD_BANK_RATE = 0.005;
    const BARD_ENABLED = true;
    const FOREST_EVENT_CHANCE = 0.20;
    const EVENT_HP_MAX = 8;
    const EVENT_GOLD_MAX = 25;
    const EVENT_XP_MAX = 12;
    const CLASS_ENABLED = true;
    const THIEF_SEARCH_BONUS_RATE = 0.10;
    const MYSTIC_VICTORY_HEAL = 2;
    const DEATHKNIGHT_FIRST_STRIKE_BONUS = 1;
    const ALLOW_CLASS_RESPEC = false;
    const RESPEC_COST_GOLD = 500;
    const MAIL_SEND_DAILY_LIMIT = 5;
    const MAIL_SUBJECT_MAX = 40;
    const MAIL_BODY_MAX = 500;
    const ANNOUNCE_SUBJECT_MAX = 60;
    const CLASS_OPTIONS = [
      { id:'thief', key:'t', name:'Thief', description:'Cunning and quick. Finds a bit more gold while Searching.' },
      { id:'mystic', key:'m', name:'Mystic', description:'Calm and attuned. Heals slightly after victorious combat.' },
      { id:'deathknight', key:'d', name:'Death Knight', description:'Relentless. Strikes harder on the first blow each combat.' },
    ];
    const CLASS_LOOKUP = CLASS_OPTIONS.reduce((acc,opt)=>{ acc[opt.id] = opt; return acc; }, {});
    const CLASS_KEY_LOOKUP = CLASS_OPTIONS.reduce((acc,opt)=>{ acc[opt.key] = opt; acc[opt.name.toLowerCase()] = opt; return acc; }, {});
    function timeLeftMMSS() {
      const now = new Date(); const end = new Date(now); end.setHours(23,59,59,999);
      const s = Math.max(0, Math.floor((end - now)/1000));
      const mm = String(Math.floor(s/60)).padStart(2,'0'); const ss = String(s%60).padStart(2,'0');
      return `${mm}:${ss}`;
    }
    function safeName(name){
      const cleaned = String(name || '').replace(/[\x00-\x1F\x7F]/g, '').trim();
      return cleaned || 'Unknown';
    }
    function stripControls(text, allowNewlines){
      const pattern = allowNewlines ? /[\x00-\x09\x0B-\x1F\x7F]/g : /[\x00-\x1F\x7F]/g;
      return String(text || '').replace(pattern, '');
    }
    function sanitizeMailSubject(text){
      const cleaned = stripControls(text, false).trim();
      return cleaned.slice(0, MAIL_SUBJECT_MAX);
    }
    function sanitizeMailBody(text){
      const cleaned = stripControls(text, true).trim();
      return cleaned.slice(0, MAIL_BODY_MAX);
    }
    function sanitizeAnnouncement(text){
      const cleaned = stripControls(text, false).trim();
      return cleaned.slice(0, ANNOUNCE_SUBJECT_MAX);
    }
    function formatDate(epoch){
      if (!epoch) return 'unknown';
      const d = new Date(epoch * 1000);
      if (Number.isNaN(d.getTime())) return 'unknown';
      const y = d.getFullYear();
      const m = String(d.getMonth()+1).padStart(2,'0');
      const day = String(d.getDate()).padStart(2,'0');
      return `${y}-${m}-${day}`;
    }
    function formatDateTime(epoch){
      if (!epoch) return 'unknown';
      const d = new Date(epoch * 1000);
      if (Number.isNaN(d.getTime())) return 'unknown';
      const y = d.getFullYear();
      const m = String(d.getMonth()+1).padStart(2,'0');
      const day = String(d.getDate()).padStart(2,'0');
      const h = String(d.getHours()).padStart(2,'0');
      const min = String(d.getMinutes()).padStart(2,'0');
      return `${y}-${m}-${day} ${h}:${min}`;
    }
    function getClassInfo(id){ return id ? CLASS_LOOKUP[id] || null : null; }
    function getClassName(id){ const info = getClassInfo(id); return info ? info.name : null; }

    const ENEMIES = ['Rat','Mangy Wolf','Highway Thief','Goblin','Skeleton','Bandit','Ogre','Wraith','Warlock','Black Knight'];
    const WEAPONS = [
      { name:'Dagger', atk:3, cost:0 }, { name:'Shortsword', atk:5, cost:75 },
      { name:'Broadsword', atk:7, cost:200 }, { name:'Battle Axe', atk:10, cost:600 },
      { name:'Warhammer', atk:13, cost:1500 }, { name:'Dragon Claw', atk:17, cost:3500 },
    ];
    const ARMOR = [
      { name:'Cloth', def:1, cost:0 }, { name:'Leather', def:3, cost:80 },
      { name:'Chain', def:5, cost:220 }, { name:'Plate', def:8, cost:700 },
      { name:'Knight', def:11, cost:1600 }, { name:'Dragon Scale', def:15, cost:3600 },
    ];
    const FOREST_EVENTS = [
      {
        id:'lost_traveler',
        title:'The Lost Traveler',
        description:['A weary traveler stumbles through the brush, map in tatters.'],
        options:[
          {
            key:'a',
            label:'Guide them toward the road',
            effect(p){
              const xp = randInt(4, Math.min(EVENT_XP_MAX, 8));
              const charmGain = p.charm >= CHARM_MAX ? 0 : 1;
              return {
                deltas:{ xp, charm:charmGain },
                lines(applied){
                  const change = formatApplied(applied);
                  return [`You guide them safely to the road.${change ? ` ${change}` : ''}`];
                }
              };
            }
          },
          {
            key:'b',
            label:'Wave them off and keep moving',
            effect(){
              const foundPouch = Math.random() < 0.5;
              const gold = foundPouch ? randInt(5, Math.min(EVENT_GOLD_MAX, 12)) : 0;
              return {
                deltas:{ gold },
                lines(applied){
                  if (applied.gold > 0) return [`You pocket ${applied.gold} gold from a dropped pouch.`];
                  return ['You leave them to their fate and gain nothing.'];
                }
              };
            }
          }
        ]
      },
      {
        id:'old_hag_riddle',
        title:"The Old Hag's Riddle",
        description:['An old hag blocks the path, croaking out a riddle with a wicked grin.'],
        options:[
          {
            key:'a',
            label:'Answer boldly',
            effect(){
              const success = Math.random() < 0.55;
              if (success){
                const xp = randInt(6, EVENT_XP_MAX);
                const gold = randInt(6, Math.min(EVENT_GOLD_MAX, 16));
                const gems = (FEATURE_GEMS && Math.random() < 0.1) ? 1 : 0;
                return {
                  deltas:{ xp, gold, gems },
                  lines(applied){
                    const change = formatApplied(applied);
                    const gemLine = applied.gems > 0 ? ' Among the hag\'s trinkets you spy a flawless gem!' : '';
                    return [`Your wit delights the hag.${change ? ` ${change}` : ''}${gemLine}`];
                  }
                };
              }
              const hpLoss = randInt(2, Math.min(EVENT_HP_MAX, 5));
              const xpLoss = randInt(2, 4);
              return {
                deltas:{ hp:-hpLoss, xp:-xpLoss },
                lines(applied){
                  const change = formatApplied(applied);
                  return [`Her curse stings you for guessing poorly.${change ? ` ${change}` : ''}`];
                }
              };
            }
          },
          {
            key:'b',
            label:'Play it safe and flatter her',
            effect(){
              const xp = randInt(2, Math.min(EVENT_XP_MAX, 4));
              const gold = randInt(3, Math.min(EVENT_GOLD_MAX, 7));
              return {
                deltas:{ xp, gold },
                lines(applied){
                  const change = formatApplied(applied);
                  return [`You compliment her stories until she waves you by.${change ? ` ${change}` : ''}`];
                }
              };
            }
          }
        ]
      },
      {
        id:'collapsed_tunnel',
        title:'The Collapsed Tunnel',
        description:['A hidden tunnel promises riches beyond, but rubble blocks the way.'],
        options:[
          {
            key:'a',
            label:'Dig through the rubble',
            effect(){
              const hpLoss = randInt(3, Math.min(EVENT_HP_MAX, 6));
              const gold = randInt(9, Math.min(EVENT_GOLD_MAX, 18));
              const xp = randInt(3, Math.min(EVENT_XP_MAX, 7));
              return {
                deltas:{ hp:-hpLoss, gold, xp },
                lines(applied){
                  const change = formatApplied(applied);
                  return [`Sweat and bruises reveal a hidden stash.${change ? ` ${change}` : ''}`];
                }
              };
            }
          },
          {
            key:'b',
            label:'Take a safer detour',
            effect(){
              return {
                deltas:{},
                lines:['You take the long path around; nothing ventured, nothing gained.']
              };
            }
          }
        ]
      },
      {
        id:'shrines_thorn_bloom',
        title:'Shrines of Thorn and Bloom',
        description:['Twin shrines—one of twisting thorns, one of gentle blooms—glow beside the trail.'],
        options:[
          {
            key:'a',
            label:'Bow before the Shrine of Bloom',
            effect(p){
              const blessing = Math.random() < 0.7;
              if (blessing){
                const xp = randInt(2, Math.min(EVENT_XP_MAX, 5));
                const charmGain = p.charm >= CHARM_MAX ? 0 : 1;
                const gems = (FEATURE_GEMS && Math.random() < 0.1) ? 1 : 0;
                return {
                  deltas:{ xp, charm:charmGain, gems },
                  lines(applied){
                    const change = formatApplied(applied);
                    const extra = applied.charm === 0 && applied.xp === 0 ? ' The warmth fades before it settles.' : '';
                    const gemLine = applied.gems > 0 ? ' A radiant gem blossoms in your hand.' : '';
                    return [`Fragrant petals whirl around you.${change ? ` ${change}` : ''}${extra}${gemLine}`];
                  }
                };
              }
              const hpLoss = randInt(1, Math.min(EVENT_HP_MAX, 3));
              const xp = randInt(2, Math.min(EVENT_XP_MAX, 4));
              return {
                deltas:{ hp:-hpLoss, xp },
                lines(applied){
                  const change = formatApplied(applied);
                  return [`Hidden thorns prick your hand.${change ? ` ${change}` : ''}`];
                }
              };
            }
          },
          {
            key:'b',
            label:'Kneel at the Shrine of Thorn',
            effect(){
              const xp = randInt(4, Math.min(EVENT_XP_MAX, 7));
              const hpLoss = randInt(1, Math.min(EVENT_HP_MAX, 3));
              return {
                deltas:{ xp, hp:-hpLoss },
                lines(applied){
                  const change = formatApplied(applied);
                  return [`Pain sharpens your focus.${change ? ` ${change}` : ''}`];
                }
              };
            }
          },
          {
            key:'c',
            label:'Leave the shrines undisturbed',
            effect(){
              const xp = randInt(1, Math.min(EVENT_XP_MAX, 3));
              return {
                deltas:{ xp },
                lines(applied){
                  const change = formatApplied(applied);
                  return [`You nod respectfully and walk on.${change ? ` ${change}` : ''}`];
                }
              };
            }
          }
        ]
      }
    ];
    const FOREST_EVENT_INDEX = FOREST_EVENTS.reduce((acc, evt) => {
      acc[evt.id] = evt;
      return acc;
    }, {});
    function getForestEvent(id){ return id ? FOREST_EVENT_INDEX[id] || null : null; }
    function formatApplied(applied){
      if (!applied) return '';
      const labels={ hp:'HP', gold:'gold', xp:'XP', charm:'Charm', gems:'Gems' };
      const parts=[];
      for (const key of Object.keys(labels)){
        const val = applied[key];
        if (!val) continue;
        const sign = val>0?'+':'';
        parts.push(`${sign}${val} ${labels[key]}`);
      }
      return parts.length ? `(${parts.join(', ')})` : '';
    }
    function applyForestEventDeltas(p, deltas){
      const start={ hp:p.hp, gold:p.gold, xp:p.xp, charm:p.charm, level:p.level, maxHp:p.maxHp, gems:p.gems || 0 };
      let xpApplied = 0;
      if (deltas){
        if (typeof deltas.hp === 'number') p.hp = clamp(start.hp + deltas.hp, 0, p.maxHp);
        if (typeof deltas.gold === 'number') p.gold = Math.max(0, start.gold + deltas.gold);
        if (typeof deltas.xp === 'number'){
          const targetXp = Math.max(0, start.xp + deltas.xp);
          xpApplied = targetXp - start.xp;
          p.xp = targetXp;
        }
        if (typeof deltas.charm === 'number') p.charm = clamp((start.charm || 0) + deltas.charm, 0, CHARM_MAX);
        if (FEATURE_GEMS && typeof deltas.gems === 'number'){
          const current = typeof p.gems === 'number' ? p.gems : 0;
          const target = Math.max(0, current + deltas.gems);
          p.gems = target;
        }
      }
      let levelInfo=null;
      if (deltas && typeof deltas.xp === 'number' && deltas.xp > 0){
        const levelBefore=p.level;
        const maxHpBefore=p.maxHp;
        const leveled=applyLevelUpsSilent(p);
        if (leveled){
          levelInfo={ level:p.level, hpGain:p.maxHp - maxHpBefore, levels:p.level - levelBefore };
        }
      }
      const actual={
        hp:p.hp - start.hp,
        gold:p.gold - start.gold,
        xp:xpApplied,
        charm:(p.charm||0) - (start.charm||0),
        gems:(p.gems||0) - (start.gems||0)
      };
      return { actual, levelUp:levelInfo };
    }
    function resolveForestEventOutcome(p, outcome){
      const deltas = outcome && outcome.deltas ? outcome.deltas : {};
      const { actual, levelUp } = applyForestEventDeltas(p, deltas);
      let lines=[];
      if (outcome){
        if (typeof outcome.lines === 'function'){
          const res = outcome.lines(actual);
          if (Array.isArray(res)) lines = res.map(String);
          else if (res) lines = [String(res)];
        } else if (Array.isArray(outcome.lines)){
          lines = outcome.lines.map(String);
        } else if (typeof outcome.text === 'string'){
          lines = [outcome.text];
        }
      }
      if (!lines.length){
        const change = formatApplied(actual);
        lines.push(change ? `The moment passes ${change}.` : 'The moment passes quietly.');
      }
      if (levelUp && levelUp.levels>0){
        lines.push(`You reach Level ${p.level}! Max HP +${levelUp.hpGain}.`);
      }
      return { lines, actual };
    }
    function startForestEvent(p, origin){
      if (p?.temp?.event) return false;
      if (FOREST_EVENTS.length<=0) return false;
      if (Math.random() >= FOREST_EVENT_CHANCE) return false;
      const event = FOREST_EVENTS[randInt(0, FOREST_EVENTS.length-1)];
      if (!event) return false;
      if (!p.temp || typeof p.temp !== 'object') p.temp = {};
      p.temp.event = { id:event.id, stage:'choice', origin:origin || null };
      p.screen='forest:event';
      return true;
    }
    function clearForestEvent(p){
      if (p?.temp && p.temp.event){
        delete p.temp.event;
        if (!Object.keys(p.temp).length) p.temp=null;
      }
    }
    const xpToNext = (level) => 20 + level * 15;
    function applyLevelUps(p){
      let leveled = false;
      while (p.xp >= xpToNext(p.level)){
        const needed = xpToNext(p.level);
        p.xp -= needed;
        p.level += 1;
        const hpGain = 5 + randInt(0,5);
        p.maxHp += hpGain;
        p.hp = p.maxHp;
        api.print(`You reach Level ${p.level}! Max HP +${hpGain}.`,'magenta');
        leveled = true;
      }
      return leveled;
    }
    function applyLevelUpsSilent(p){
      let leveled = false;
      while (p.xp >= xpToNext(p.level)){
        const needed = xpToNext(p.level);
        p.xp -= needed;
        p.level += 1;
        const hpGain = 5 + randInt(0,5);
        p.maxHp += hpGain;
        p.hp = p.maxHp;
        leveled = true;
      }
      return leveled;
    }

    // Player identity from BBS
    const userId = state.userId;
    const fallbackName = state.displayName || state.username || 'Adventurer';

    // ─────────────────────────────────────────────────────────────
    // Persistence wrappers (DB or MEM)
    function parseDaily(json){ try { return json ? JSON.parse(json) : null; } catch { return null; } }
    const addNews = (typeof state?.addNews === 'function') ? state.addNews
      : (typeof meta?.addNews === 'function') ? meta.addNews
      : (typeof api?.addNews === 'function') ? api.addNews : null;
    function todayKey(){
      const d = new Date();
      const y = d.getFullYear();
      const m = String(d.getMonth()+1).padStart(2,'0');
      const day = String(d.getDate()).padStart(2,'0');
      return `${y}${m}${day}`;
    }
    function defaultDaily(baseDate){
      const key = baseDate || todayKey();
      return {
        forestTurns:10,
        tavernDrinks:2,
        heals:DAILY_HEALS,
        slept:false,
        duelUsed:false,
        bard:false,
        lastDate:key,
        interestDate:null,
        jewelerPurchases:0,
        proposalsMade:0,
        mailSent:0,
        announced:false
      };
    }
    function normalizeDaily(d){
      const today = todayKey();
      if (!d) return defaultDaily(today);
      if (typeof d.forestTurns === 'undefined') d.forestTurns = 10;
      if (typeof d.tavernDrinks === 'undefined') d.tavernDrinks = 2;
      if (typeof d.heals === 'undefined') d.heals = DAILY_HEALS;
      if (typeof d.slept === 'undefined') d.slept = false;
      if (typeof d.duelUsed === 'undefined') d.duelUsed = false;
      if (typeof d.bard === 'undefined') d.bard = false;
      if (!d.lastDate || typeof d.lastDate !== 'string') d.lastDate = today;
      if (typeof d.interestDate === 'undefined') d.interestDate = null;
      if (typeof d.jewelerPurchases !== 'number') d.jewelerPurchases = 0;
      if (typeof d.proposalsMade !== 'number') d.proposalsMade = 0;
      if (typeof d.mailSent !== 'number') d.mailSent = 0;
      if (typeof d.announced !== 'boolean') d.announced = false;
      return d;
    }
    function applyBankInterest(p, dateKey){
      const key = dateKey || todayKey();
      if (p.daily.interestDate === key) return null;
      const interest = Math.floor(p.bank * 0.01);
      p.bank += interest;
      p.daily.interestDate = key;
      if (interest > 0 && typeof addNews === 'function') addNews(`${p.name} earned ${interest} gold interest in the bank.`);
      return interest;
    }

    function toRow(p){
      const id = p.userId ?? userId;
      return {
        user_id: id, char_name: p.name, gender: p.gender || null,
        created_at: p.createdAt, updated_at: p.updatedAt,
        level: p.level, xp: p.xp, hp: p.hp, max_hp: p.maxHp, gold: p.gold, bank: p.bank,
        weapon_idx: p.weaponIdx, armor_idx: p.armorIdx,
        charm: p.charm, kills: p.kills, deaths: p.deaths,
        day_count: p.dayCount, daily_json: JSON.stringify(normalizeDaily(p.daily)),
        expert: p.expert ? 1 : 0, screen: p.screen, gems: p.gems || 0,
        spouse_id: p.spouseId || null,
        spouse_name: p.spouseName || null,
        married_on: p.marriedOn || 0,
        class_id: p.classId || null,
        last_seen: typeof p.lastSeen === 'number' ? p.lastSeen : 0
      };
    }
    function fromRow(r){
      return {
        userId: r.user_id, name: r.char_name, gender: r.gender,
        createdAt: r.created_at, updatedAt: r.updated_at,
        level: r.level, xp: r.xp, hp: r.hp, maxHp: r.max_hp, gold: r.gold, bank: r.bank,
        weaponIdx: r.weapon_idx, armorIdx: r.armor_idx,
        charm: r.charm, kills: r.kills, deaths: r.deaths,
        dayCount: r.day_count, daily: normalizeDaily(parseDaily(r.daily_json)),
        expert: !!r.expert, screen: r.screen || 'town', combat: null, temp: null,
        gems: typeof r.gems === 'number' ? r.gems : 0,
        spouseId: r.spouse_id ? String(r.spouse_id) : null,
        spouseName: r.spouse_name || null,
        marriedOn: typeof r.married_on === 'number' ? r.married_on : 0,
        classId: r.class_id ? String(r.class_id) : null,
        lastSeen: typeof r.last_seen === 'number' ? r.last_seen : 0
      };
    }

    function memGet(){ return MEM.players.get(userId) || null; }
    function memPut(p){ MEM.players.set(p.userId ?? userId, p); }
    function memClone(p){ return p ? JSON.parse(JSON.stringify(p)) : null; }
    function memTop(){
      return [...MEM.players.values()]
        .map(p => ({ name:p.name, level:p.level, kills:p.kills, deaths:p.deaths, wealth:(p.gold+p.bank) }))
        .sort((a,b) => (b.level-a.level) || (b.kills-a.kills) || (b.wealth-a.wealth))
        .slice(0,20);
    }

    function dbGetPlayer(){
      if (!useDB){
        const existing = memGet();
        if (existing){
          existing.daily = normalizeDaily(existing.daily);
          if (typeof existing.lastSeen !== 'number') existing.lastSeen = 0;
        }
        return existing;
      }
      const r = selectPlayer.get(userId); return r ? fromRow(r) : null;
    }
    function dbInsertPlayer(p){
      if (!useDB) return memPut(p);
      const r = toRow(p);
      insertPlayer.run(
        r.user_id, r.char_name, r.gender, r.created_at, r.updated_at, r.last_seen,
        r.level, r.xp, r.hp, r.max_hp, r.gold, r.bank, r.weapon_idx, r.armor_idx,
        r.charm, r.kills, r.deaths, r.day_count, r.daily_json, r.expert, r.screen, r.gems,
        r.spouse_id, r.spouse_name, r.married_on, r.class_id
      );
    }
    function dbUpdatePlayer(p){
      if (!useDB) return memPut(p);
      const r = toRow(p);
      updatePlayer.run(
        r.char_name, r.gender, r.updated_at, r.last_seen,
        r.level, r.xp, r.hp, r.max_hp, r.gold, r.bank, r.weapon_idx, r.armor_idx,
        r.charm, r.kills, r.deaths, r.day_count, r.daily_json, r.expert, r.screen, r.gems,
        r.spouse_id, r.spouse_name, r.married_on, r.class_id,
        r.user_id
      );
    }
    function savePlayer(p){
      if (!p) return;
      p.updatedAt = nowEpoch();
      if (typeof p.lastSeen !== 'number') p.lastSeen = nowEpoch();
      const exists = !!dbGetPlayer();
      exists ? dbUpdatePlayer(p) : dbInsertPlayer(p);
    }
    function getOpponentsFor(player){
      if (useDB){
        return opponentsStmt ? opponentsStmt.all(player.userId) : [];
      }
      return [...MEM.players.values()]
        .filter(other => other.userId !== player.userId)
        .sort((a,b)=>(b.level-a.level)||(b.xp-a.xp)||(b.kills-a.kills))
        .slice(0,20)
        .map(o=>({ user_id:o.userId, name:o.name, level:o.level, kills:o.kills, deaths:o.deaths, gold:o.gold }));
    }
    function getPlayerByIdRaw(id){
      if (useDB){
        const row = selectPlayer.get(id);
        return row ? fromRow(row) : null;
      }
      const mem = memClone(MEM.players.get(id));
      if (mem){
        mem.daily = normalizeDaily(mem.daily);
        if (typeof mem.lastSeen !== 'number') mem.lastSeen = 0;
      }
      return mem;
    }
    function putPlayerRaw(player){
      if (!player) return;
      player.updatedAt = nowEpoch();
      if (typeof player.lastSeen !== 'number') player.lastSeen = nowEpoch();
      if (useDB){
        const row = selectPlayer.get(player.userId);
        if (row) dbUpdatePlayer(player); else dbInsertPlayer(player);
      } else {
        MEM.players.set(player.userId, memClone(player));
      }
    }
    function topHeroes(){ return useDB ? topHeroesStmt.all() : memTop(); }

    function isMarried(p){
      if (!p) return false;
      const id = typeof p.spouseId === 'undefined' ? p.spouse_id : p.spouseId;
      if (!id) return false;
      return String(id).trim() !== '';
    }
    function getPendingProposalsFor(id){
      const key = String(id);
      if (useDB){
        if (!selectProposalsForStmt) return [];
        return selectProposalsForStmt.all(key).map(row => ({
          id: row.id,
          fromId: row.from_id ? String(row.from_id) : '',
          fromName: safeName(row.from_name),
          toId: row.to_id ? String(row.to_id) : '',
          toName: safeName(row.to_name),
          ts: row.ts
        }));
      }
      return MEM.proposals
        .filter(p => p.toId === key)
        .map(p => ({ ...p }));
    }
    function hasPendingProposals(id){ return getPendingProposalsFor(id).length > 0; }
    function hasProposalBetween(fromId, toId){
      const fromKey = String(fromId);
      const toKey = String(toId);
      if (useDB){
        if (!checkProposalStmt) return false;
        const row = checkProposalStmt.get(fromKey, toKey);
        return !!row;
      }
      return MEM.proposals.some(p => p.fromId === fromKey && p.toId === toKey);
    }
    function addProposalRecord(fromPlayer, toPlayer){
      const ts = nowEpoch();
      const entry = {
        fromId: String(fromPlayer.userId),
        fromName: safeName(fromPlayer.name),
        toId: String(toPlayer.userId),
        toName: safeName(toPlayer.name),
        ts
      };
      if (useDB){
        if (!insertProposalStmt) return;
        insertProposalStmt.run(entry.fromId, entry.fromName, entry.toId, entry.toName, ts);
        return;
      }
      const id = MEM.nextProposalId++;
      MEM.proposals.push({ id, ...entry });
      if (MEM.proposals.length > 200){
        MEM.proposals.splice(0, MEM.proposals.length - 200);
      }
    }
    function removeProposal(id){
      if (useDB){
        if (deleteProposalStmt) deleteProposalStmt.run(id);
        return;
      }
      MEM.proposals = MEM.proposals.filter(p => p.id !== id);
    }
    function clearProposalsFor(id){
      const key = String(id);
      if (useDB){
        if (deleteProposalsByPlayerStmt) deleteProposalsByPlayerStmt.run(key, key);
        return;
      }
      MEM.proposals = MEM.proposals.filter(p => p.fromId !== key && p.toId !== key);
    }
    function addMailRecord(fromPlayer, toPlayer, subject, body){
      const ts = nowEpoch();
      const entry = {
        toId: String(toPlayer.userId),
        toName: safeName(toPlayer.name),
        fromId: String(fromPlayer.userId),
        fromName: safeName(fromPlayer.name),
        subject,
        body,
        ts
      };
      if (useDB){
        if (!insertMailStmt) return;
        insertMailStmt.run(entry.toId, entry.toName, entry.fromId, entry.fromName, ts, entry.subject, entry.body);
        return;
      }
      const id = MEM.nextMailId++;
      MEM.mail.push({ id, ...entry, unread:1, deletedTo:0, deletedFrom:0 });
      if (MEM.mail.length > 500){
        MEM.mail.splice(0, MEM.mail.length - 500);
      }
    }
    function getInboxMessages(player){
      if (!player) return [];
      const key = String(player.userId);
      if (useDB){
        if (!selectInboxMailStmt) return [];
        return selectInboxMailStmt.all(key).map(row => ({
          id: row.id,
          toId: row.to_id ? String(row.to_id) : key,
          toName: safeName(row.to_name),
          fromId: row.from_id ? String(row.from_id) : '',
          fromName: safeName(row.from_name),
          ts: row.ts,
          subject: sanitizeMailSubject(row.subject),
          body: sanitizeMailBody(row.body),
          unread: row.unread ? 1 : 0
        }));
      }
      return MEM.mail
        .filter(m => m.toId === key && !m.deletedTo)
        .sort((a,b) => b.ts - a.ts)
        .slice(0, 20)
        .map(m => ({
          id: m.id,
          toId: m.toId,
          toName: safeName(m.toName),
          fromId: m.fromId,
          fromName: safeName(m.fromName),
          ts: m.ts,
          subject: sanitizeMailSubject(m.subject),
          body: sanitizeMailBody(m.body),
          unread: m.unread ? 1 : 0
        }));
    }
    function getMailByIdForPlayer(player, mailId){
      if (!player) return null;
      const key = String(player.userId);
      const idNum = Number(mailId);
      if (!Number.isInteger(idNum) || idNum <= 0) return null;
      if (useDB){
        if (!selectMailByIdStmt) return null;
        const row = selectMailByIdStmt.get(idNum, key);
        if (!row) return null;
        return {
          id: row.id,
          toId: row.to_id ? String(row.to_id) : key,
          toName: safeName(row.to_name),
          fromId: row.from_id ? String(row.from_id) : '',
          fromName: safeName(row.from_name),
          ts: row.ts,
          subject: sanitizeMailSubject(row.subject),
          body: sanitizeMailBody(row.body),
          unread: row.unread ? 1 : 0
        };
      }
      const found = MEM.mail.find(m => m.id === idNum && m.toId === key && !m.deletedTo);
      if (!found) return null;
      return {
        id: found.id,
        toId: found.toId,
        toName: safeName(found.toName),
        fromId: found.fromId,
        fromName: safeName(found.fromName),
        ts: found.ts,
        subject: sanitizeMailSubject(found.subject),
        body: sanitizeMailBody(found.body),
        unread: found.unread ? 1 : 0
      };
    }
    function markMailRead(mailId){
      const idNum = Number(mailId);
      if (!Number.isInteger(idNum) || idNum <= 0) return;
      if (useDB){
        if (markMailReadStmt) markMailReadStmt.run(idNum);
        return;
      }
      const entry = MEM.mail.find(m => m.id === idNum);
      if (entry) entry.unread = 0;
    }
    function listMailRecipients(player, searchTerm){
      if (!player) return [];
      const opponents = getOpponentsFor(player) || [];
      const key = String(player.userId);
      const normalized = opponents.map(row => ({
        userId: String(row.user_id ?? row.userId ?? ''),
        name: safeName(row.name || row.char_name || ''),
        level: typeof row.level === 'number' ? row.level : 1
      })).filter(rec => rec.userId && rec.userId !== key);
      const term = searchTerm ? searchTerm.toLowerCase() : '';
      const filtered = term ? normalized.filter(rec => rec.name.toLowerCase().includes(term)) : normalized;
      return filtered.slice(0, 20);
    }
    function listOnlinePlayers(currentPlayer){
      const selfId = currentPlayer ? String(currentPlayer.userId ?? '') : '';
      const provider = G.LORD_PRESENCE_PROVIDER;
      if (provider && typeof provider.list === 'function'){
        try {
          const entries = provider.list();
          if (Array.isArray(entries)){
            const seen = new Set();
            const normalized = [];
            entries.forEach(entry => {
              if (!entry) return;
              const id = typeof entry.userId !== 'undefined' && entry.userId !== null ? String(entry.userId) : '';
              if (!id || id === selfId) return;
              if (seen.has(id)) return;
              seen.add(id);
              normalized.push({
                userId: id,
                name: safeName(entry.name),
                level: typeof entry.level === 'number' ? entry.level : null
              });
            });
            normalized.sort((a,b) => a.name.localeCompare(b.name));
            return normalized.slice(0, 30);
          }
        } catch (err){
          console.error('[lord] presence provider list failed:', err && err.message ? err.message : err);
        }
      }
      const cutoff = nowEpoch() - ONLINE_WINDOW_SEC;
      const seen = new Set();
      if (useDB){
        if (!selectOnlinePlayersStmt) return [];
        const rows = selectOnlinePlayersStmt.all(cutoff);
        const normalized = [];
        rows.forEach(row => {
          if (!row) return;
          const id = typeof row.user_id !== 'undefined' && row.user_id !== null ? String(row.user_id) : '';
          if (!id || id === selfId) return;
          if (seen.has(id)) return;
          const lastSeen = typeof row.last_seen === 'number' ? row.last_seen : 0;
          if (lastSeen < cutoff) return;
          seen.add(id);
          normalized.push({
            userId: id,
            name: safeName(row.char_name),
            level: typeof row.level === 'number' ? row.level : 1,
            lastSeen
          });
        });
        normalized.sort((a,b) => (b.lastSeen - a.lastSeen) || a.name.localeCompare(b.name));
        return normalized.slice(0, 30);
      }
      const normalized = [];
      MEM.players.forEach(player => {
        if (!player) return;
        const id = typeof player.userId !== 'undefined' && player.userId !== null ? String(player.userId) : '';
        if (!id || id === selfId) return;
        if (seen.has(id)) return;
        const lastSeen = typeof player.lastSeen === 'number' ? player.lastSeen : 0;
        if (lastSeen < cutoff) return;
        seen.add(id);
        normalized.push({
          userId: id,
          name: safeName(player.name),
          level: typeof player.level === 'number' ? player.level : 1,
          lastSeen
        });
      });
      normalized.sort((a,b) => (b.lastSeen - a.lastSeen) || a.name.localeCompare(b.name));
      return normalized.slice(0, 30);
    }
    function listMarriageCandidates(p){
      if (!p) return [];
      if (useDB){
        if (!selectMarriageCandidatesStmt) return [];
        return selectMarriageCandidatesStmt.all(p.userId).map(row => ({
          userId: String(row.user_id),
          name: safeName(row.char_name),
          level: row.level,
          charm: row.charm || 0
        }));
      }
      return [...MEM.players.values()]
        .filter(other => other.userId !== p.userId && !isMarried(other))
        .sort((a,b)=>(b.level-a.level)||((b.xp||0)-(a.xp||0))||((b.charm||0)-(a.charm||0)))
        .slice(0,20)
        .map(o => ({ userId:String(o.userId), name:safeName(o.name), level:o.level, charm:o.charm||0 }));
    }
    function getMarriedPairs(){
      const seen = new Set();
      const pairs = [];
      const addPair = (id, name, spouseId, spouseName, marriedOn) => {
        if (!spouseId) return;
        const key = [String(id), String(spouseId)].sort().join(':');
        if (seen.has(key)) return;
        seen.add(key);
        pairs.push({
          aName: safeName(name),
          bName: safeName(spouseName || ''),
          marriedOn: typeof marriedOn === 'number' ? marriedOn : 0
        });
      };
      if (useDB){
        if (!selectMarriedPairsStmt) return [];
        selectMarriedPairsStmt.all().forEach(row => {
          const spouseId = row.spouse_id ? String(row.spouse_id) : null;
          addPair(row.user_id, row.char_name, spouseId, row.spouse_name, row.married_on);
        });
      } else {
        MEM.players.forEach(player => {
          if (!isMarried(player)) return;
          addPair(player.userId, player.name, player.spouseId, player.spouseName, player.marriedOn);
        });
      }
      if (!useDB){
        pairs.sort((a,b) => (a.marriedOn||0) - (b.marriedOn||0) || a.aName.localeCompare(b.aName));
      }
      return pairs;
    }

    // ─────────────────────────────────────────────────────────────
    // Character creation
    function defaultPlayer(charName, gender){
      const now = nowEpoch();
      return {
        userId, name: charName || fallbackName, gender: gender || null,
        createdAt: now, updatedAt: now,
        level:1, xp:0, hp:30, maxHp:30, gold:50, bank:0, weaponIdx:0, armorIdx:0,
        charm:0, kills:0, deaths:0, dayCount:1, daily: defaultDaily(),
        gems:0,
        spouseId:null, spouseName:null, marriedOn:0,
        classId:null,
        lastSeen: now,
        expert:false, screen:'town', combat:null, temp:null
      };
    }

    // ─────────────────────────────────────────────────────────────
    // UI helpers
    function setPromptLord(){ api.setPrompt && api.setPrompt(PROMPT); api.setInputType && api.setInputType('text','type a letter/word (/? for help, /leave)'); }
    function setPromptDIS(){ api.setPrompt && api.setPrompt('DIS>'); api.setInputType && api.setInputType('text','type /help for commands'); }
    function printHeader(title){ api.batch(b=>{ b.clear(); b.print(`== ${title} ==`,'magenta'); b.hr(); }); }
    function showStatus(p){
      const w=WEAPONS[p.weaponIdx], a=ARMOR[p.armorIdx];
      api.print(`Name: ${p.name}   Level: ${p.level} (${p.xp}/${xpToNext(p.level)} xp)`, 'cyan');
      api.print(`HP: ${p.hp}/${p.maxHp}   ATK: ${w.atk} (${w.name})   DEF: ${a.def} (${a.name})`);
      const gems = FEATURE_GEMS ? (p.gems || 0) : 0;
      const gemText = FEATURE_GEMS ? `  Gems: ${gems}` : '';
      api.print(`Gold: ${p.gold}  Bank: ${p.bank}${gemText}  Kills: ${p.kills}  Deaths: ${p.deaths}`);
      if (CLASS_ENABLED){
        const className = getClassName(p.classId);
        if (className) api.print(`Class: ${className}`);
      }
      api.print(`Turns: Forest ${p.daily.forestTurns}  Heals ${p.daily.heals}  Drinks ${p.daily.tavernDrinks}`, 'dim'); api.hr();
    }
    function townHeader(){ api.batch(b=>{ b.clear(); b.print('Legend Of The Redux Dragon - Town Square','green'); b.print('=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=','green'); }); }

    // Creation screens
    function renderCreateName(){
      setPromptLord();
      api.batch(b=>{ b.clear(); b.print('Legend of the Redux Dragon - Character Creation','magenta'); b.hr();
        b.print(`Welcome, traveler. What shall we call you?`, 'cyan');
        b.print(`(Press Enter for default: ${fallbackName})`, 'dim'); b.hr(); });
    }
    function renderCreateGender(name){
      setPromptLord();
      api.batch(b=>{ b.clear(); b.print('Legend of the Redux Dragon - Character Creation','magenta'); b.hr();
        b.print(`Very well, ${name}. Choose your bearing:`, 'cyan');
        b.print('(M) Male'); b.print('(F) Female'); b.print('(N) Non-binary / Other'); b.hr(); b.print('Type M, F, or N.','dim'); });
    }
    function renderCreateConfirm(name, gender){
      setPromptLord();
      api.batch(b=>{ b.clear(); b.print('Legend of the Redux Dragon - Character Creation','magenta'); b.hr();
        b.print(`Name  : ${name}`); b.print(`Gender: ${gender || '—'}`); b.hr(); b.print('Is this correct? (Y/N)','cyan'); });
    }

    // Town Square
    function townSquareMenu(p){
      setPromptLord(); townHeader();
      api.print('The streets are crowded, it is difficult to','dim');
      api.print('push your way through the mob....','dim'); api.hr();
      const W=36, pad=(s,w)=> (s+' '.repeat(Math.max(0,w-s.length)));
      const row=(lk,lt,rk,rt)=> api.print(pad(`(${lk})${lt}`,W)+`(${rk})${rt}`);
      if (!p.expert){
        row('F','orest','S','laughter other players');
        row('K','ing Arthurs Weapons','A','bduls Armour');
        row('H','ealers Hut','V','iew your stats');
        row('I','nn','T','urgons Warrior Training');
        row('Y','e Old Bank','L','ist Warriors');
        row('W','rite Mail','D','aily News');
        row('C','onjugality List','O','ther Places');
        row('X','pert Mode','M','ake Announcement');
        if (FEATURE_GEMS){
          row('P','eople Online','J','eweler');
          row('Q','uit to Fields',' ',' ');
        } else {
          row('P','eople Online','Q','uit to Fields');
        }
        api.hr();
        api.print('The Town Square    (? for menu)','magenta');
        const menuKeys = FEATURE_GEMS ? '(F,S,K,A,H,V,I,T,Y,L,W,D,C,O,X,M,P,Q,J)' : '(F,S,K,A,H,V,I,T,Y,L,W,D,C,O,X,M,P,Q)';
        api.print(menuKeys,'dim');
      } else {
        const expertOpts = FEATURE_GEMS ? '[Expert Mode] F S K A H V I T Y L W D C O X M P Q J' : '[Expert Mode] F S K A H V I T Y L W D C O X M P Q';
        api.print(expertOpts,'magenta');
        api.print('Type a single letter (e.g., F, K, A, V) — /help for help','dim');
      }
      api.hr(); api.print(`Your command, ${p.name}? [${timeLeftMMSS()}] :`,'cyan');
    }

    // Other screens
    function forestMenu(p){ printHeader('The Forest'); showStatus(p);
      const prompts=[];
      if (p.daily.heals>0){ api.print('H) Camp Heal'); prompts.push('h'); }
      if (p.daily.forestTurns<=0){
        api.print('You are out of turns for today. Sleep at the Inn.','yellow');
      } else {
        api.print('M) Hunt for monsters'); prompts.push('m');
        api.print('S) Search for gold'); prompts.push('s');
        if (p.level >= DRAGON_LEVEL_REQ){ api.print('D) Search for the Dragon'); prompts.push('d'); }
      }
      api.print('V) Return to Town Square'); prompts.push('v'); api.hr();
      if (!prompts.length) return;
      const promptList = prompts.length === 1
        ? prompts[0]
        : prompts.length === 2
          ? `${prompts[0]} or ${prompts[1]}`
          : `${prompts.slice(0, -1).join(', ')}, or ${prompts[prompts.length - 1]}`;
      api.print(`Type: ${promptList}.`,'dim'); }
    function renderForestEvent(p){
      const state = p.temp?.event;
      const event = getForestEvent(state?.id);
      if (!state || !event){
        clearForestEvent(p);
        p.screen='forest';
        return render(p);
      }
      printHeader('Forest Event!');
      showStatus(p);
      api.print(`[Event] ${event.title}`,'yellow');
      event.description.forEach(line => api.print(line,'cyan'));
      api.hr();
      if (state.stage === 'result'){
        const lines = Array.isArray(state.resultLines) ? state.resultLines : [];
        lines.forEach(line => api.print(line));
        api.hr();
        api.print('Press Enter to return to the Forest.','dim');
        return;
      }
      event.options.forEach(opt => api.print(`(${opt.key.toUpperCase()}) ${opt.label}`));
      api.hr();
      const keys = event.options.map(opt => opt.key);
      const promptList = keys.length === 1
        ? keys[0]
        : keys.length === 2
          ? `${keys[0]} or ${keys[1]}`
          : `${keys.slice(0, -1).join(', ')}, or ${keys[keys.length - 1]}`;
      api.print(`Choose: ${promptList}.`,'dim');
    }
    function innMenu(p){ printHeader('The Dark Cloak Inn'); showStatus(p);
      api.print('R) Rent a room and sleep (end your day, restore HP, refresh turns)'); api.print('V) Return to Town Square'); api.hr(); api.print('Type: r or v','dim'); }
    function smithMenu(p){ printHeader('The Blacksmith'); showStatus(p);
      WEAPONS.forEach((w,i)=>{ const owned=(i===p.weaponIdx)?' (owned)':''; api.print(`${i+1}) ${w.name}  ATK ${w.atk}  Cost ${w.cost}${owned}`); });
      api.print('V) Return to Town Square'); api.hr(); api.print('Buy by number. Example: 3','dim'); }
    function armorerMenu(p){ printHeader('The Armorer'); showStatus(p);
      ARMOR.forEach((a,i)=>{ const owned=(i===p.armorIdx)?' (owned)':''; api.print(`${i+1}) ${a.name}  DEF ${a.def}  Cost ${a.cost}${owned}`); });
      api.print('V) Return to Town Square'); api.hr(); api.print('Buy by number. Example: 2','dim'); }
    function healerMenu(p){ printHeader('The Healer'); showStatus(p);
      const missing=p.maxHp-p.hp;
      if (missing<=0){ api.print('You are already in perfect health.'); api.print('V) Return to Town Square','dim'); return; }
      const rate=2,cost=missing*rate;
      api.print(`You are missing ${missing} HP. Healing costs ${rate} gold per HP (Total: ${cost}).`);
      api.print('H) Heal to full'); api.print('V) Return to Town Square'); api.hr(); api.print('Type: h or v','dim'); }
    function bankMenu(p){ printHeader('The Bank of Redux'); showStatus(p);
      api.print('D) Deposit gold'); api.print('W) Withdraw gold'); api.print('V) Return to Town Square'); api.hr(); api.print('Type: d, w, or v','dim'); }
    function jewelerMenu(p){ printHeader('The Jeweler'); showStatus(p);
      if (!FEATURE_GEMS){ api.print('The jeweler\'s stall is closed today.'); api.print('V) Return to Town Square'); api.hr(); api.print('Type: v','dim'); return; }
      const gems = p.gems || 0;
      const purchases = p.daily.jewelerPurchases || 0;
      if (JEWELER_DAILY_LIMIT > 0){
        const remaining = Math.max(0, JEWELER_DAILY_LIMIT - purchases);
        api.print(`Daily purchases remaining: ${remaining}/${JEWELER_DAILY_LIMIT}`,'dim');
      }
      api.print(`You cradle ${gems} precious gem${gems===1?'':'s'}.`);
      api.print(`R) Ring of Swagger — Cost: 1 gem — +${RING_CHARM_INC} Charm (cap ${CHARM_MAX})`);
      api.print(`H) Heartstone — Cost: 1 gem — +${HEARTSTONE_HP} Max HP (restores to full)`);
      api.print('V) Return to Town Square'); api.hr(); api.print('Type: r, h, or v','dim');
    }
    function bankDepositPrompt(p){ printHeader('Bank — Deposit'); showStatus(p);
      api.print(`You carry ${p.gold} gold. How much to deposit?`,'cyan'); api.hr(); api.print('Type a number, or v to cancel.','dim'); p.temp={mode:'deposit'}; }
    function bankWithdrawPrompt(p){ printHeader('Bank — Withdraw'); showStatus(p);
      api.print(`You have ${p.bank} gold in the bank. How much to withdraw?`,'cyan'); api.hr(); api.print('Type a number, or v to cancel.','dim'); p.temp={mode:'withdraw'}; }
    function rankingsMenu(){ printHeader('Heroes of the Realm');
      const rows = topHeroes(); if (!rows.length) api.print('No heroes recorded yet.','dim');
      rows.forEach((r,i)=> api.print(`${i+1}. ${r.name}  Lv${r.level}  K:${r.kills} D:${r.deaths}  Riches:${r.wealth}`));
      api.hr(); api.print('V) Return to Town Square','dim'); }
    function tavernMenu(p){ printHeader('The Tavern'); showStatus(p);
      const bardReady = BARD_ENABLED && !p.daily.bard;
      const married = isMarried(p);
      const hasInbox = hasPendingProposals(p.userId);
      api.print('G) Gossip — overhear a rumor');
      api.print('D) Drink — regain a few HP (limited per day)');
      if (bardReady){ api.print('B) Bard\'s Song — accept today\'s boon'); }
      api.print('F) Flirt — flash a roguish grin');
      if (!married){ api.print('R) Propose Marriage'); }
      if (hasInbox){ api.print('L) View Proposals'); }
      api.print('V) Return to Town Square'); api.hr();
      const opts = ['g'];
      if (bardReady) opts.push('b');
      opts.push('d','f');
      if (!married) opts.push('r');
      if (hasInbox) opts.push('l');
      opts.push('v');
      const hint = opts.length === 2 ? `${opts[0]} or ${opts[1]}`
        : `${opts.slice(0, -1).join(', ')}, or ${opts[opts.length - 1]}`;
      api.print(`Type: ${hint}`,'dim'); }
    function marriageProposeMenu(p){ printHeader('The Tavern — Marriage'); showStatus(p);
      if (isMarried(p)){ api.print('You are already wed.','yellow'); api.print('V) Return to the Tavern'); api.hr(); api.print('Type: v','dim'); p.temp={ mode:'propose', candidates:[] }; return; }
      const limit = Math.max(0, PROPOSAL_DAILY_LIMIT || 0);
      const used = Math.max(0, p.daily.proposalsMade || 0);
      if (limit > 0){ api.print(`Daily proposals used: ${Math.min(used, limit)}/${limit}`,'dim'); }
      if (limit > 0 && used >= limit){ api.print('You have already offered your hand today.','yellow'); api.print('V) Return to the Tavern'); api.hr(); api.print('Type: v','dim'); p.temp={ mode:'propose', candidates:[] }; return; }
      const candidates = listMarriageCandidates(p);
      if (!candidates.length){ api.print('No eligible partners linger here just now.','dim'); api.print('V) Return to the Tavern'); api.hr(); api.print('Type: v','dim'); p.temp={ mode:'propose', candidates:[] }; return; }
      p.temp = { mode:'propose', candidates };
      candidates.forEach((c,i)=>{ api.print(`${i+1}) ${c.name}  Lv${c.level}  Charm:${c.charm}`); });
      api.print('V) Return to the Tavern');
      api.hr(); api.print('Pick a number to propose, or V to return.','dim'); }
    function proposalInboxMenu(p){ printHeader('The Tavern — Proposals'); showStatus(p);
      const proposals = getPendingProposalsFor(p.userId);
      if (!proposals.length){ api.print('No one has proposed to you.','dim'); api.print('V) Return to the Tavern'); api.hr(); api.print('Type: v','dim'); p.temp={ mode:'inbox', proposals:[] }; return; }
      p.temp = { mode:'inbox', proposals };
      proposals.forEach((pr,i)=>{
        const when = formatDate(pr.ts);
        api.print(`${i+1}) ${pr.fromName} (since ${when})`);
      });
      api.print('V) Return to the Tavern');
      api.hr(); api.print('Type A# to accept or D# to decline (e.g., A1). V to return.','dim'); }
    function statusMenu(p){ printHeader('Your Status'); showStatus(p);
      api.print('V) Return to Town Square'); api.hr(); api.print('Type: v','dim'); }
    function stubMenu(title, p){ printHeader(title); showStatus(p);
      api.print('Coming soon.','yellow'); api.print('V) Return to Town Square'); api.hr(); api.print('Type: v','dim'); }
    function duelsMenu(p){
      printHeader('The Dueling Grounds');
      showStatus(p);
      if (p.daily.duelUsed){
        api.print('You already fought today. Rest up and return tomorrow.','yellow');
        api.print('V) Return to Town Square','dim');
        return;
      }
      const opponents = getOpponentsFor(p);
      if (!opponents.length){
        api.print('No worthy challengers are here right now.','dim');
        api.print('V) Return to Town Square','dim');
        p.temp = { opponents: [] };
        return;
      }
      p.temp = { opponents };
      opponents.forEach((o,i)=>{
        api.print(`${i+1}) ${o.name}  Lv${o.level}  K:${o.kills} D:${o.deaths}  Gold:${o.gold}`);
      });
      api.hr();
      api.print('Pick a foe by number, or V to return.','dim');
    }
    function duelResultMenu(p){
      printHeader('Duel Result');
      const result = p.temp?.duelResult;
      if (!result){
        api.print('The duel outcome is unclear.','yellow');
        api.print('V) Return to Town Square','dim');
        return;
      }
      if (result.attackerWon){
        api.print(`You defeat ${result.opponent}!`,'green');
        if (result.goldWon) api.print(`You claim ${result.goldWon} gold.`, 'cyan');
        api.print(`You earn ${result.xpGain} xp.`, 'cyan');
      } else {
        api.print(`${result.winnerName} bests you in the duel.`, 'yellow');
        if (result.goldLost) api.print(`You lose ${result.goldLost} gold.`, 'yellow');
        if (result.xpEnemy) api.print(`${result.winnerName} gains ${result.xpEnemy} xp.`, 'dim');
      }
      const methodText = result.method==='ko' ? 'Victory by steel.'
        : result.method==='level' ? 'Tiebreaker: higher level prevails.'
        : result.method==='charm' ? 'Tiebreaker: greater charm impresses the crowd.'
        : result.method==='luck' ? 'Tiebreaker: fate flips a coin.'
        : 'The crowd decides the victor.';
      api.print(methodText, 'dim');
      api.print(`Rounds fought: ${result.rounds}`, 'dim');
      api.hr();
      api.print('V) Return to Town Square','dim');
    }
    function trainingMenu(p){
      printHeader(`Turgon's Warrior Training`);
      showStatus(p);
      api.print('S) Sparring — hone your edge (+10 xp) — Cost: 80 gold');
      api.print('E) Endurance drills — toughen up (+3 Max HP) — Cost: 120 gold');
      api.print('W) Swagger lessons — polish your charm (+1 Charm, cap 10) — Cost: 60 gold');
      if (CLASS_ENABLED){
        const classInfo = getClassInfo(p.classId);
        if (classInfo){
          api.print(`Class: ${classInfo.name} — ${classInfo.description}`);
          if (ALLOW_CLASS_RESPEC){
            const cost = Math.max(0, RESPEC_COST_GOLD || 0);
            const note = cost > 0 ? ` (Respec cost: ${cost} gold)` : '';
            api.print(`C) Review or respec your class${note}`);
          } else {
            api.print('C) Review your class (selection is permanent)');
          }
        } else {
          api.print('C) Choose Class — embrace a unique perk for your adventures');
        }
      }
      if (p.charm >= CHARM_MAX) api.print('Your charm already dazzles the realm; further swagger is impossible.','dim');
      api.print('V) Return to Town Square');
      api.hr();
      const trainHint = CLASS_ENABLED ? 'Type: s, e, w, c, or v.' : 'Type: s, e, w, or v.';
      api.print(trainHint,'dim');
    }
    function classMenu(p){
      printHeader('Choose Your Class');
      showStatus(p);
      if (!CLASS_ENABLED){
        api.print('Classes are not available right now.','yellow');
        api.print('V) Return to Training');
        api.hr();
        api.print('Type: v','dim');
        return;
      }
      const current = getClassInfo(p.classId);
      if (current){
        api.print(`Current Class: ${current.name}`,'cyan');
        api.print(`Perk: ${current.description}`);
        if (ALLOW_CLASS_RESPEC){
          const cost = Math.max(0, RESPEC_COST_GOLD || 0);
          const costNote = cost > 0 ? ` (Cost: ${cost} gold)` : '';
          api.print(`R) Respec — reset your class choice${costNote}`);
        } else {
          api.print('Class selection cannot be changed.','yellow');
        }
        api.print('V) Return to Training');
        api.hr();
        const hint = ALLOW_CLASS_RESPEC ? 'Type: r to respec, or v to return.' : 'Type: v to return.';
        api.print(hint,'dim');
        return;
      }
      CLASS_OPTIONS.forEach(opt => {
        api.print(`${opt.key.toUpperCase()}) ${opt.name} — ${opt.description}`);
      });
      api.print('Choose wisely; this decision is final.','yellow');
      api.print('V) Return to Training');
      api.hr();
      api.print('Type the letter of your chosen class, or v to return.','dim');
    }
    function getMailTemp(p){
      if (!p) return null;
      if (!p.temp || typeof p.temp !== 'object') p.temp = {};
      if (!p.temp.mailState || typeof p.temp.mailState !== 'object') p.temp.mailState = {};
      return p.temp.mailState;
    }
    function clearMailTemp(p){
      if (!p || !p.temp) return;
      if (p.temp.mailState) delete p.temp.mailState;
      if (Object.keys(p.temp).length === 0) p.temp = null;
    }
    function ensureMailDraft(p){
      const mailTemp = getMailTemp(p);
      if (!mailTemp.draft){
        mailTemp.draft = {
          step:'recipient',
          searchTerm:'',
          recipients:[],
          toId:null,
          toName:null,
          subject:'',
          body:''
        };
      }
      return mailTemp.draft;
    }
    function newsMenu(p){ stubMenu('Daily News', p); }
    function mailMenu(p){
      getMailTemp(p);
      printHeader('Town Mail Service');
      showStatus(p);
      const limit = Math.max(0, MAIL_SEND_DAILY_LIMIT || 0);
      const used = Math.max(0, p.daily?.mailSent || 0);
      if (limit > 0){
        api.print(`Daily mail sent: ${Math.min(used, limit)}/${limit}`,'dim');
      }
      api.print('I) Inbox — read messages awaiting you');
      api.print('C) Compose — send a message to another adventurer');
      api.print('V) Return to Town Square');
      api.hr();
      api.print('Type: i, c, or v.','dim');
    }
    function inboxMenu(p){
      const mailTemp = getMailTemp(p);
      mailTemp.current = null;
      printHeader('Town Mail — Inbox');
      showStatus(p);
      const inbox = getInboxMessages(p);
      mailTemp.inbox = inbox;
      if (!inbox.length){
        api.print('Your inbox is empty.','dim');
        api.print('V) Return to Mail Menu');
        api.hr();
        api.print('Type: v','dim');
        return;
      }
      inbox.forEach((mail, idx) => {
        const status = mail.unread ? '[Unread]' : '[Read] ';
        const when = formatDateTime(mail.ts);
        const subject = mail.subject || '(no subject)';
        api.print(`${idx+1}) ${status} ${mail.fromName} — ${subject} (${when})`);
      });
      api.print('V) Return to Mail Menu');
      api.hr();
      api.print('Type a number to read a message, or v to return.','dim');
    }
    function readMailView(p){
      const mailTemp = getMailTemp(p);
      const mail = mailTemp.current;
      printHeader('Town Mail — Message');
      showStatus(p);
      if (!mail){
        api.print('That message is no longer available.','yellow');
        api.print('V) Return to Inbox');
        api.hr();
        api.print('Type: v','dim');
        return;
      }
      api.print(`From: ${mail.fromName}`);
      api.print(`Subject: ${mail.subject || '(no subject)'}`);
      api.print(`Date: ${formatDateTime(mail.ts)}`);
      api.hr();
      if (mail.body){
        mail.body.split(/\r?\n/).forEach(line => api.print(line));
      } else {
        api.print('(No message body)','dim');
      }
      api.hr();
      const hints = [];
      if (mail.fromId && String(mail.fromId) !== String(p.userId)){
        api.print('R) Reply');
        hints.push('r (reply)');
      }
      api.print('V) Return to Inbox');
      hints.push('v (return)');
      api.hr();
      const hint = hints.length === 1 ? hints[0] : `${hints.slice(0,-1).join(', ')}, or ${hints[hints.length-1]}`;
      api.print(`Type: ${hint}.`,'dim');
    }
    function composeMailFlow(p){
      const limit = Math.max(0, MAIL_SEND_DAILY_LIMIT || 0);
      const used = Math.max(0, p.daily?.mailSent || 0);
      const mailTemp = getMailTemp(p);
      const draft = ensureMailDraft(p);
      printHeader('Town Mail — Compose');
      showStatus(p);
      if (limit > 0){
        api.print(`Daily mail sent: ${Math.min(used, limit)}/${limit}`,'dim');
      }
      if (limit > 0 && used >= limit){
        api.print('You have already sent the maximum amount of mail today.','yellow');
        api.print('V) Return to Mail Menu');
        api.hr();
        api.print('Type: v','dim');
        return;
      }
      if (draft.toName){
        api.print(`To: ${draft.toName}`);
      }
      if (draft.step === 'recipient'){
        const list = listMailRecipients(p, draft.searchTerm || '');
        mailTemp.recipients = list;
        if (draft.searchTerm){
          api.print(`Filter: "${draft.searchTerm}"`,'dim');
        }
        if (!list.length){
          api.print('No adventurers match that search.','yellow');
        } else {
          list.forEach((rec, idx) => {
            api.print(`${idx+1}) ${rec.name} — Level ${rec.level}`);
          });
        }
        api.print('V) Return to Mail Menu');
        api.hr();
        const parts = [];
        if ((list || []).length) parts.push('a number to choose');
        parts.push('n <name> to search');
        parts.push('v to return');
        const hint = parts.length === 1 ? parts[0] : `${parts.slice(0,-1).join(', ')}, or ${parts[parts.length-1]}`;
        api.print(`Type: ${hint}.`,'dim');
        return;
      }
      if (draft.step === 'subject'){
        if (draft.subject){
          api.print(`Current subject: ${draft.subject}`,'dim');
          api.print('Press Enter to keep it, or type a new subject (max 40 characters).');
        } else {
          api.print('Enter a subject (max 40 characters).');
        }
        api.print('V) Return to Mail Menu','dim');
        api.hr();
        api.print('Type your subject.','dim');
        return;
      }
      if (draft.step === 'body'){
        api.print(`Subject: ${draft.subject}`,'dim');
        const remaining = Math.max(0, MAIL_BODY_MAX - (draft.body ? draft.body.length : 0));
        api.print(`Enter your message (max ${MAIL_BODY_MAX} characters). Remaining: ${remaining}.`);
        api.print('V) Return to Mail Menu','dim');
        api.hr();
        api.print('Type your message.','dim');
        return;
      }
      if (draft.step === 'confirm'){
        api.print(`To: ${draft.toName}`);
        api.print(`Subject: ${draft.subject}`);
        api.print('Body:');
        if (draft.body){
          draft.body.split(/\r?\n/).forEach(line => api.print(line));
        } else {
          api.print('(No message body)','dim');
        }
        api.hr();
        api.print('S) Send mail');
        api.print('U) Edit subject');
        api.print('B) Edit body');
        api.print('V) Cancel');
        api.hr();
        api.print('Type: s to send, u to edit subject, b to edit body, or v to cancel.','dim');
        return;
      }
      draft.step = 'recipient';
      composeMailFlow(p);
    }
    function conjugalityMenu(p){ printHeader('Conjugality List'); showStatus(p);
      const pairs = getMarriedPairs();
      if (!pairs.length){ api.print('No unions are recorded in the town ledger.','dim'); }
      else { pairs.forEach(pair => { const since = formatDate(pair.marriedOn); api.print(`${pair.aName} ❤ ${pair.bName} (since ${since})`); }); }
      api.hr();
      if (isMarried(p)){ api.print(`D) Divorce — penalty ${DIVORCE_CHARM_COST} charm, ${DIVORCE_GOLD_COST} gold`); }
      api.print('V) Return to Town Square'); api.hr();
      api.print(isMarried(p) ? 'Type: d or v' : 'Type: v','dim'); }
    function announcePrompt(p){
      printHeader('Town Announcement');
      showStatus(p);
      if (p.daily?.announced){
        api.print('You already made an announcement today.','yellow');
        api.print('V) Return to Town Square');
        api.hr();
        api.print('Type: v','dim');
        return;
      }
      api.print('Share a short announcement with the town (max 60 characters).');
      api.print('Type your announcement, or V to cancel.','dim');
      api.hr();
    }
    function peopleMenu(p){
      printHeader('People Online');
      showStatus(p);
      const online = listOnlinePlayers(p);
      if (!online.length){
        api.print('No one else is online.','dim');
      } else {
        online.forEach((person, idx) => {
          const lvl = typeof person.level === 'number' && !Number.isNaN(person.level) ? person.level : '?';
          api.print(`${idx+1}) ${person.name}  Lv${lvl}`);
        });
      }
      api.print('V) Return to Town Square');
      api.hr();
      api.print('Type: v','dim');
    }

    // Combat
    function genEnemy(p){ const idx=clamp(p.level-1+randInt(-1,1),0,ENEMIES.length-1); const name=ENEMIES[idx];
      const base=Math.max(1, p.level+randInt(0,2));
      return { name, hp:10+base*5+randInt(-3,3), maxHp:10+base*5, atk:Math.max(2, base*2+randInt(0,2)), def:Math.max(1, base+randInt(0,1)), fleeAttempts:0 }; }
    function ensureCombatState(p){
      if (!p.temp) p.temp = {};
      if (!p.temp.combat) p.temp.combat = {};
      p.temp.combat.firstStrikeUsed = false;
    }
    function markFirstStrikeUsed(p){
      if (!p.temp) p.temp = {};
      if (!p.temp.combat) p.temp.combat = {};
      p.temp.combat.firstStrikeUsed = true;
    }
    function hasUsedFirstStrike(p){ return !!(p.temp && p.temp.combat && p.temp.combat.firstStrikeUsed); }
    function clearCombatState(p){
      if (p.temp && p.temp.combat){
        delete p.temp.combat;
        if (Object.keys(p.temp).length === 0) p.temp = null;
      }
    }
    function maybeApplyMysticHeal(p){
      if (!CLASS_ENABLED || p.classId !== 'mystic') return;
      const heal = Math.max(0, Math.floor(MYSTIC_VICTORY_HEAL || 0));
      if (heal <= 0) return;
      const before = p.hp;
      p.hp = clamp(p.hp + heal, 0, p.maxHp);
      const gained = p.hp - before;
      if (gained > 0) api.print(`Mystic calm restores ${gained} HP.`, 'green');
    }
    function maybeDragon(p){
      if (p.level < DRAGON_LEVEL_REQ) return null;
      if (Math.random() > DRAGON_FIND_CHANCE) return null;
      const levelBonus = Math.max(0, p.level - DRAGON_LEVEL_REQ);
      const maxHp = clamp(170 + levelBonus * 10, 160, 240);
      const atk = 22 + levelBonus * 2;
      const def = 14 + Math.floor(levelBonus * 1.5);
      return { name:'Ancient Dragon', hp:maxHp, maxHp, atk, def, fleeAttempts:0, boss:true };
    }
    function renderCombat(p){ const e=p.combat; if (!e){ p.screen='forest'; return render(p); }
      printHeader('Battle!'); api.print(`${p.name} vs ${e.name}`); api.print(`Your HP: ${p.hp}/${p.maxHp}   Enemy HP: ${e.hp}/${e.maxHp}`,'cyan');
      api.hr(); api.print('A) Attack   F) Flee   I) Inspect','dim'); }
    function doAttackRound(p){ const e=p.combat; if (!e) return;
      if (!p.temp || !p.temp.combat) ensureCombatState(p);
      const weapon = WEAPONS[p.weaponIdx];
      let dmgToEnemy=Math.max(1, weapon.atk + randInt(0,3) - e.def);
      let bonusApplied = 0;
      if (CLASS_ENABLED && p.classId === 'deathknight' && !hasUsedFirstStrike(p)){
        const bonus = Math.max(0, Math.floor(DEATHKNIGHT_FIRST_STRIKE_BONUS || 0));
        if (bonus > 0){
          bonusApplied = bonus;
          dmgToEnemy += bonus;
        }
        markFirstStrikeUsed(p);
      }
      e.hp=Math.max(0, e.hp-dmgToEnemy); api.print(`You strike the ${e.name} for ${dmgToEnemy}.`,'green');
      if (bonusApplied > 0) api.print(`Your relentless first blow deals +${bonusApplied} damage!`,'magenta');
      if (e.hp<=0){
        p.kills++;
        if (e.boss){
          const gold=randInt(DRAGON_GOLD_MIN, DRAGON_GOLD_MAX);
          const xp=randInt(80,120)+p.level*randInt(6,10);
          p.gold+=gold; p.xp+=xp;
          const newCharm=clamp(p.charm+1,0,10); const charmGain=newCharm-p.charm; p.charm=newCharm;
          api.print('You have slain the Ancient Dragon!','magenta');
          api.print(`You claim ${gold} gold and earn ${xp} xp.`, 'cyan');
          if (charmGain>0) api.print('Your legend grows. Charm +1.','green');
          if (typeof addNews === 'function') addNews(`${p.name} slew the Ancient Dragon!`);
        } else {
          const gold=randInt(10,20)+p.level*randInt(5,10); const xp=randInt(8,12)+p.level*randInt(2,4);
          p.daily.forestTurns=Math.max(0, p.daily.forestTurns-1); p.gold+=gold; p.xp+=xp; api.print(`Victory! You gain ${gold} gold and ${xp} xp.`,'cyan');
        }
        maybeApplyMysticHeal(p);
        applyLevelUps(p);
        clearCombatState(p);
        p.combat=null; savePlayer(p); api.hr(); p.screen='forest'; return render(p); }
      const dmgToYou=Math.max(1, e.atk + randInt(0,3) - ARMOR[p.armorIdx].def);
      p.hp=Math.max(0, p.hp-dmgToYou); api.print(`The ${e.name} hits you for ${dmgToYou}.`,'yellow');
      if (p.hp<=0){ api.print('You fall in battle…','red'); p.deaths++; const loss=Math.floor(p.gold*0.25); p.gold-=loss; api.print(`You lose ${loss} gold. You are carried back to the Inn.`,'yellow');
        p.hp=Math.ceil(p.maxHp/2); p.daily.forestTurns=0; clearCombatState(p); p.combat=null; savePlayer(p); api.hr(); p.screen='inn'; return render(p); }
      renderCombat(p); }
    function doFlee(p){ const e=p.combat; if (!e) return;
      const chance=50 - e.fleeAttempts*10 + (p.level*3); const roll=randInt(1,100);
      if (roll<=chance){ api.print('You escape into the trees!','green'); if (!e.boss) p.daily.forestTurns=Math.max(0, p.daily.forestTurns-1); clearCombatState(p); p.combat=null; savePlayer(p); p.screen='forest'; return render(p); }
      e.fleeAttempts++; api.print('You fail to flee!','yellow'); const dmg=Math.max(1, e.atk + randInt(0,2) - ARMOR[p.armorIdx].def);
      p.hp=Math.max(0, p.hp-dmg); api.print(`The ${e.name} punishes your back for ${dmg}.`,'yellow');
      if (p.hp<=0){ api.print('You fall while fleeing…','red'); p.deaths++; const loss=Math.floor(p.gold*0.25); p.gold-=loss; api.print(`You lose ${loss} gold.`,'yellow');
        p.hp=Math.ceil(p.maxHp/2); p.daily.forestTurns=0; clearCombatState(p); p.combat=null; savePlayer(p); p.screen='inn'; return render(p); }
      renderCombat(p); }

    // Input routers
    function onTown(p,t){
      const k=t.trim().toLowerCase();
      if (k==='f'){ p.screen='forest'; return render(p); }
      if (k==='s'){ p.screen='duel'; return render(p); }
      if (k==='k'){ p.screen='blacksmith'; return render(p); }
      if (k==='a'){ p.screen='armorer'; return render(p); }
      if (k==='h'){ p.screen='healer'; return render(p); }
      if (k==='v'){ p.screen='status'; return render(p); }
      if (k==='i'){ p.screen='inn'; return render(p); }
      if (k==='t'){ p.screen='training'; return render(p); }
      if (k==='y'){ p.screen='bank'; return render(p); }
      if (k==='l'){ p.screen='rankings'; return render(p); }
      if (k==='w'){ p.screen='mail'; return render(p); }
      if (k==='d'){ p.screen='news'; return render(p); }
      if (FEATURE_GEMS && k==='j'){ p.screen='jeweler'; return render(p); }
      if (k==='c'){ p.screen='conjugality'; return render(p); }
      if (k==='o'){ p.screen='tavern'; return render(p); }
      if (k==='x'){ p.expert=!p.expert; savePlayer(p); return render(p); }
      if (k==='m'){ p.screen='announce'; return render(p); }
      if (k==='p'){ p.screen='people'; return render(p); }
      if (k==='q'){ p.screen='town'; savePlayer(p); leave(); return; }
      if (k.startsWith('forest')){ p.screen='forest'; return render(p); }
      if (k.startsWith('black')){ p.screen='blacksmith'; return render(p); }
      if (k.startsWith('armor')){ p.screen='armorer'; return render(p); }
      if (k.startsWith('heal')){ p.screen='healer'; return render(p); }
      if (k.startsWith('inn')){ p.screen='inn'; return render(p); }
      if (k.startsWith('bank')||k==='ye'||k.startsWith('ye old')){ p.screen='bank'; return render(p); }
      if (k.startsWith('rank')){ p.screen='rankings'; return render(p); }
      if (FEATURE_GEMS && (k.startsWith('jewel')||k==='jeweler')){ p.screen='jeweler'; return render(p); }
      if (k.startsWith('status')||k.startsWith('view')){ p.screen='status'; return render(p); }
      if (k.startsWith('tav')||k.startsWith('other')){ p.screen='tavern'; return render(p); }
      if (k.startsWith('train')){ p.screen='training'; return render(p); }
      if (k.startsWith('duel')){ p.screen='duel'; return render(p); }
      if (k.startsWith('mail')||k.startsWith('write')){ p.screen='mail'; return render(p); }
      if (k.startsWith('news')){ p.screen='news'; return render(p); }
      if (k.startsWith('conj')){ p.screen='conjugality'; return render(p); }
      if (k.startsWith('announ')){ p.screen='announce'; return render(p); }
      if (k.startsWith('people')||k.startsWith('online')){ p.screen='people'; return render(p); }
      api.print('Try a letter like F,K,A,V or a place name (forest, inn, bank…).','dim');
    }
    function onForest(p,t){
      const raw=t.trim().toLowerCase();
      if (raw==='v'){ p.screen='town'; return render(p); }
      let k=raw;
      const wantsHeal = raw==='h' || raw==='heal' || raw==='camp' || raw==='camp heal';
      if (wantsHeal && p.daily.heals>0){
        const before=p.hp;
        const healAmt=Math.ceil(p.maxHp * CAMP_HEAL_PCT);
        p.hp=clamp(p.hp+healAmt,0,p.maxHp);
        const gained=p.hp-before;
        p.daily.heals=Math.max(0, p.daily.heals-1);
        api.print(`You rest at camp and recover ${gained} HP. Camp heals left: ${p.daily.heals}.`, gained>0 ? 'green' : 'dim');
        savePlayer(p);
        return render(p);
      }
      if (wantsHeal){
        if (raw==='h' && p.daily.forestTurns>0){
          k='hunt';
        } else {
          return api.print('You have no camp heals remaining today.','yellow');
        }
      }
      if (p.daily.forestTurns<=0) return api.print('No turns left today. Sleep at the Inn.','yellow');
      if (k==='m'||k.startsWith('m')||k.startsWith('hunt')||k.startsWith('fight')){
        if (startForestEvent(p, 'hunt')) return render(p);
        ensureCombatState(p);
        p.combat=genEnemy(p); p.screen='combat'; return render(p);
      }
      if (k.startsWith('s')||k==='s'){
        if (startForestEvent(p, 'search')) return render(p);
        let gold=randInt(2,15)+randInt(0,p.level);
        if (CLASS_ENABLED && p.classId === 'thief'){
          const rate = Math.max(0, THIEF_SEARCH_BONUS_RATE || 0);
          const adjusted = Math.floor(gold * (1 + rate));
          gold = Math.max(0, adjusted);
        } else {
          gold = Math.max(0, gold);
        }
        p.daily.forestTurns--;
        p.gold+=gold;
        api.print(`You find ${gold} gold.`,'green');
        if (FEATURE_GEMS && GEM_DROP_RATE_SEARCH > 0 && Math.random() < GEM_DROP_RATE_SEARCH){
          p.gems = Math.max(0, (p.gems || 0) + 1);
          api.print('A glint catches your eye — you pocket a rare gem!','magenta');
        }
        savePlayer(p);
        return render(p);
      }
      if (k.startsWith('d')||k==='d'){
        if (p.level < DRAGON_LEVEL_REQ) return api.print('The legends warn that the Dragon is beyond your skill for now.','yellow');
        p.daily.forestTurns=Math.max(0, p.daily.forestTurns-1);
        const dragon=maybeDragon(p);
        if (!dragon){ api.print('You scour the groves but find no sign of the Dragon.','yellow'); savePlayer(p); return render(p); }
        api.print('A thunderous roar shakes the canopy — the Ancient Dragon descends!','red');
        ensureCombatState(p);
        p.combat=dragon; p.screen='combat'; savePlayer(p); return render(p);
      }
      const options=[];
      if (p.daily.heals>0) options.push('h');
      if (p.daily.forestTurns>0){
        options.push('m','s');
        if (p.level >= DRAGON_LEVEL_REQ) options.push('d');
      }
      options.push('v');
      const optsText = options.length === 1
        ? options[0]
        : options.length === 2
          ? `${options[0]} or ${options[1]}`
          : `${options.slice(0, -1).join(', ')}, or ${options[options.length - 1]}`;
      api.print(`Type: ${optsText}.`,'dim');
    }
    function onForestEvent(p,t){
      const state = p.temp?.event;
      const event = getForestEvent(state?.id);
      if (!state || !event){
        clearForestEvent(p);
        p.screen='forest';
        return render(p);
      }
      const raw=t.trim().toLowerCase();
      if (state.stage === 'result'){
        if (raw===''||raw==='v'||raw==='continue'||raw==='c'){
          p.screen='forest';
          clearForestEvent(p);
          savePlayer(p);
          return render(p);
        }
        return api.print('Press Enter to return to the Forest.','yellow');
      }
      const choice = event.options.find(opt => raw === opt.key || raw === opt.key.toLowerCase());
      if (!choice){
        return api.print('Choose one of the options shown.','yellow');
      }
      p.daily.forestTurns = Math.max(0, p.daily.forestTurns-1);
      const outcome = choice.effect ? choice.effect(p) : null;
      const resolution = resolveForestEventOutcome(p, outcome);
      if (!p.temp) p.temp={};
      p.temp.event = { id:event.id, stage:'result', resultLines:resolution.lines, origin:state.origin || null };
      return render(p);
    }
    function onCombat(p,t){ const k=t.toLowerCase(); if (k==='a'||k.startsWith('att')) return doAttackRound(p); if (k==='f'||k.startsWith('fl')) return doFlee(p); if (k==='i'){ renderCombat(p); return; } api.print('Options: A)ttack, F)lee, I)nspect','dim'); }
    function onInn(p,t){
      const k=t.toLowerCase();
      if (k==='v'){ p.screen='town'; return render(p); }
      if (k==='r'){
        const today = todayKey();
        const targetDate = p.daily.lastDate || today;
        let interest = applyBankInterest(p, targetDate);
        if (interest === null) interest = 0;
        api.print(`Your bank earns ${interest} gold interest.`, interest>0 ? 'green' : 'dim');
        p.dayCount++;
        p.hp=p.maxHp;
        const nextDaily = defaultDaily(today);
        nextDaily.interestDate = today;
        p.daily = nextDaily;
        api.print('You sleep soundly. A new day dawns.','green');
        savePlayer(p);
        p.screen='town';
        return render(p);
      }
      api.print('Type r to sleep, or v to return.','dim');
    }
    function onSmith(p,t){ const k=t.toLowerCase(); if (k==='v'){ p.screen='town'; return render(p); } const idx=parseInt(k,10);
      if (!Number.isNaN(idx)&&idx>=1&&idx<=WEAPONS.length){ const i=idx-1, w=WEAPONS[i];
        if (i===p.weaponIdx) return api.print('You already own that weapon.','dim');
        if (p.gold<w.cost)   return api.print('You lack the gold.','yellow');
        if (w.atk<=WEAPONS[p.weaponIdx].atk) return api.print('That would not improve your attack.','yellow');
        p.gold-=w.cost; p.weaponIdx=i; api.print(`You purchase the ${w.name}.`,'green'); savePlayer(p); return render(p); }
      api.print('Choose a number or V to return.','dim'); }
    function onArmorer(p,t){ const k=t.toLowerCase(); if (k==='v'){ p.screen='town'; return render(p); } const idx=parseInt(k,10);
      if (!Number.isNaN(idx)&&idx>=1&&idx<=ARMOR.length){ const i=idx-1, a=ARMOR[i];
        if (i===p.armorIdx) return api.print('You already own that armor.','dim');
        if (p.gold<a.cost)   return api.print('You lack the gold.','yellow');
        if (a.def<=ARMOR[p.armorIdx].def) return api.print('That would not improve your defense.','yellow');
        p.gold-=a.cost; p.armorIdx=i; api.print(`You purchase the ${a.name}.`,'green'); savePlayer(p); return render(p); }
      api.print('Choose a number or V to return.','dim'); }
    function onHealer(p,t){ const k=t.toLowerCase(); if (k==='v'){ p.screen='town'; return render(p); } if (k==='h'){ const missing=p.maxHp-p.hp; if (missing<=0) return api.print('You are already healthy.'); const cost=missing*2; if (p.gold<cost) return api.print('You lack the gold.','yellow'); p.gold-=cost; p.hp=p.maxHp; api.print('You are fully healed.','green'); savePlayer(p); return render(p); } api.print('Type h to heal (cost), or v to return.','dim'); }
    function onBank(p,t){ const k=t.toLowerCase(); if (k==='v'){ p.screen='town'; return render(p); } if (k==='d'){ p.screen='bank:dep'; return render(p); } if (k==='w'){ p.screen='bank:wit'; return render(p); } api.print('Type d, w, or v.','dim'); }
    function onBankAmount(p,t){ const k=t.toLowerCase(); if (k==='v'){ p.temp=null; p.screen='town'; return render(p); } const amt=Math.max(0,Math.floor(parseInt(k,10)));
      if (!amt && amt!==0) return api.print('Enter a number, or v to cancel.','dim'); if (!p.temp){ p.screen='town'; return render(p); }
      if (p.temp.mode==='deposit'){ if (amt>p.gold) return api.print('You do not have that much.','yellow'); p.gold-=amt; p.bank+=amt; api.print(`Deposited ${amt} gold.`,'green'); }
      else if (p.temp.mode==='withdraw'){ if (amt>p.bank) return api.print('You do not have that much in the bank.','yellow'); p.bank-=amt; p.gold+=amt; api.print(`Withdrew ${amt} gold.`,'green'); }
      p.temp=null; savePlayer(p); p.screen='town'; return render(p); }
    function onJeweler(p,t){
      const raw=t.trim().toLowerCase();
      if (raw==='v'){ p.screen='town'; return render(p); }
      if (!FEATURE_GEMS){ api.print('The jeweler has shuttered their stall for now.','yellow'); return; }
      const gems = typeof p.gems === 'number' ? p.gems : 0;
      const purchases = p.daily.jewelerPurchases || 0;
      const limit = Math.max(0, Math.floor(JEWELER_DAILY_LIMIT || 0));
      const limitReached = limit > 0 && purchases >= limit;
      if (raw==='r' || raw.startsWith('ring') || raw.startsWith('swagger')){
        if (limitReached){ return api.print('"Only so many treasures per day," the jeweler reminds you.','yellow'); }
        if (gems < 1) return api.print('You lack the gem to pay for that finery.','yellow');
        if (p.charm >= CHARM_MAX) return api.print('The jeweler smiles: "Your charm needs no further polish."','yellow');
        const newCharm = clamp(p.charm + RING_CHARM_INC, 0, CHARM_MAX);
        const gain = newCharm - p.charm;
        if (gain <= 0) return api.print('The ring would do nothing for you — best save your gem.','yellow');
        p.gems = Math.max(0, gems - 1);
        p.charm = newCharm;
        const nextPurchases = purchases + 1;
        p.daily.jewelerPurchases = limit > 0 ? Math.min(limit, nextPurchases) : nextPurchases;
        api.print(`You slip on the Ring of Swagger. Charm +${gain}.`,'green');
        if (typeof addNews === 'function') addNews(`${p.name} purchased a Ring of Swagger from the Jeweler.`);
        savePlayer(p);
        return render(p);
      }
      if (raw==='h' || raw.startsWith('heart')){
        if (limitReached){ return api.print('"Only so many treasures per day," the jeweler reminds you.','yellow'); }
        if (gems < 1) return api.print('You lack the gem to pay for that relic.','yellow');
        const hpGain = Math.max(0, HEARTSTONE_HP);
        if (hpGain <= 0) return api.print('The Heartstone hums faintly but offers no benefit today.','yellow');
        p.gems = Math.max(0, gems - 1);
        p.maxHp += hpGain;
        p.hp = p.maxHp;
        const nextPurchases = purchases + 1;
        p.daily.jewelerPurchases = limit > 0 ? Math.min(limit, nextPurchases) : nextPurchases;
        api.print(`The Heartstone pulses warmly. Max HP +${hpGain}. You feel completely restored.`,'green');
        if (typeof addNews === 'function') addNews(`${p.name} purchased a Heartstone from the Jeweler.`);
        savePlayer(p);
        return render(p);
      }
      api.print('Type r for a Ring of Swagger, h for a Heartstone, or v to return.','dim');
    }
    function onRankings(p,t){ if (t.toLowerCase()==='v'){ p.screen='town'; return render(p); } api.print('Type v to return.','dim'); }
    function onFlirt(p){
      const currentCharm = clamp(p.charm || 0, 0, CHARM_MAX);
      const roll = randInt(0, 100) + currentCharm * 5;
      let charmDelta = 0, goldDelta = 0, xpDelta = 0;
      let line = 'You mingle without much notice.';
      if (roll >= 120 && currentCharm < CHARM_MAX){
        charmDelta = 1;
        line = 'A patron swoons at your grin. Charm +1!';
      } else if (roll >= 95){
        goldDelta = randInt(1, Math.max(1, FLIRT_GOLD_MAX));
        line = `You charm a tipster. +${goldDelta} gold.`;
      } else if (roll >= 70){
        xpDelta = randInt(1, Math.max(1, FLIRT_XP_MAX));
        line = `Witty banter sharpens you. +${xpDelta} xp.`;
      } else {
        if (currentCharm >= Math.max(1, CHARM_MAX - 1)){ charmDelta = -1; line = 'You overplay your swagger. Charm -1.'; }
        else line = 'The crowd barely glances your way.';
      }
      if (charmDelta){ p.charm = clamp((p.charm || 0) + charmDelta, 0, CHARM_MAX); }
      if (goldDelta){ p.gold = Math.max(0, (p.gold || 0) + goldDelta); }
      if (xpDelta){ p.xp = Math.max(0, (p.xp || 0) + xpDelta); applyLevelUps(p); }
      savePlayer(p);
      const color = charmDelta < 0 ? 'yellow' : (charmDelta>0 || goldDelta>0 || xpDelta>0) ? 'green' : 'dim';
      api.print(line, color);
      return render(p);
    }
    function onTavern(p,t){ const k=t.toLowerCase(); if (k==='v'){ p.screen='town'; return render(p); }
      if (k==='g'){ const rumors=['They say a dragon’s hoard lies deep in the forest…','The Blacksmith sharpens for free if you’re charming — or so they say.','A hidden grove yields gold to those who listen to the wind.','Beware the Black Knight past the old bridge.']; api.print(rumors[randInt(0,rumors.length-1)],'cyan'); return; }
      if (k==='b'){
        if (!BARD_ENABLED) return api.print('The bard is away today.','dim');
        if (p.daily.bard) return api.print('The bard has already sung for you today.','yellow');
        const choices=['forest','xp','drinks','bank'];
        const choice=choices[randInt(0, choices.length-1)];
        let line='The bard sings a haunting melody.';
        if (choice==='forest'){
          const before=p.daily.forestTurns||0;
          const maxTurns=12;
          p.daily.forestTurns=clamp(before+1,0,maxTurns);
          const gained=Math.max(0, p.daily.forestTurns-before);
          line = gained>0 ? 'You feel ready for the wilds. Forest turn +1!' : 'You are already brimming with forest vigor.';
        } else if (choice==='xp'){
          p.xp=(p.xp||0)+BARD_XP;
          line = `Wisdom fills you. +${BARD_XP} XP.`;
          applyLevelUps(p);
        } else if (choice==='drinks'){
          const before = typeof p.daily.tavernDrinks === 'number' ? p.daily.tavernDrinks : 0;
          if (typeof p.daily.tavernDrinkMax === 'number'){
            const max = Math.max(0, Math.floor(p.daily.tavernDrinkMax));
            p.daily.tavernDrinks = max;
          } else {
            const cap = Math.max(3, before);
            p.daily.tavernDrinks = clamp(before + 1, 0, cap);
          }
          const gained = Math.max(0, p.daily.tavernDrinks - before);
          line = gained>0 ? `Your mug is refilled. Drinks +${gained}.` : 'Your mug was already full.';
        } else if (choice==='bank'){
          const base = Math.max(0, p.bank||0);
          const bonus = Math.floor(base * BARD_BANK_RATE);
          p.bank = base + bonus;
          line = bonus>0 ? `A patron tips ${bonus} gold into your bank.` : 'A cheerful tune promises riches to come, though none arrive today.';
        }
        p.daily.bard = true;
        if (typeof addNews === 'function') addNews(`${p.name} was blessed by the Bard.`);
        savePlayer(p);
        api.print(line, 'green');
        return render(p);
      }
      if (k==='d'){ if (p.daily.tavernDrinks<=0) return api.print('No more drinks today.','yellow'); p.daily.tavernDrinks--; const heal=randInt(2,6); p.hp=clamp(p.hp+heal,0,p.maxHp); api.print(`You feel warm. Recovered ${heal} HP.`,'green'); savePlayer(p); return render(p); }
      if (k==='f'){ return onFlirt(p); }
      if (k==='r'){ if (isMarried(p)) return api.print('You are already wed.','yellow'); p.screen='tavern:propose'; return render(p); }
      if (k==='l'){ const proposals = getPendingProposalsFor(p.userId); if (!proposals.length) return api.print('No proposals await you.','dim'); p.screen='tavern:inbox'; return render(p); }
      const bits = ['g (gossip)'];
      if (BARD_ENABLED && !p.daily.bard) bits.push('b (bard)');
      bits.push('d (drink)','f (flirt)');
      if (!isMarried(p)) bits.push('r (propose)');
      if (hasPendingProposals(p.userId)) bits.push('l (proposals)');
      bits.push('v (leave)');
      const hint = bits.length === 2 ? `${bits[0]} or ${bits[1]}` : `${bits.slice(0,-1).join(', ')}, or ${bits[bits.length-1]}`;
      api.print(`Type ${hint}`,'dim'); }
    function onMarriagePropose(p,t){ const raw=t.trim().toLowerCase();
      if (raw==='v'){ p.temp=null; p.screen='tavern'; return render(p); }
      if (!p.temp || p.temp.mode!=='propose'){ p.screen='tavern'; return render(p); }
      const list = Array.isArray(p.temp.candidates) ? p.temp.candidates : [];
      if (!list.length) return api.print('No one here to propose to. Type v to return.','dim');
      const idx=parseInt(raw,10);
      if (Number.isNaN(idx) || idx<1 || idx>list.length) return api.print('Choose a number from the list, or V to return.','dim');
      if (isMarried(p)) return api.print('You are already wed.','yellow');
      const limit = Math.max(0, PROPOSAL_DAILY_LIMIT || 0);
      const used = Math.max(0, p.daily.proposalsMade || 0);
      if (limit > 0 && used >= limit) return api.print('You have already proposed today.','yellow');
      const choice = list[idx-1];
      if (!choice) return api.print('That suitor is no longer here.','yellow');
      if (String(choice.userId) === String(p.userId)) return api.print('You cannot propose to yourself.','yellow');
      const target = getPlayerByIdRaw(choice.userId);
      if (!target){ api.print('That suitor slips away into the crowd.','yellow'); p.temp.candidates = listMarriageCandidates(p); return render(p); }
      if (isMarried(target)){ api.print(`${safeName(target.name)} is already wed.`, 'yellow'); p.temp.candidates = listMarriageCandidates(p); return render(p); }
      if (hasProposalBetween(p.userId, target.userId)) return api.print('You already proposed to them. Patience!','dim');
      addProposalRecord(p, target);
      const nextUsed = used + 1;
      p.daily.proposalsMade = limit > 0 ? Math.min(limit, nextUsed) : nextUsed;
      savePlayer(p);
      api.print(`You propose to ${safeName(target.name)}.`, 'green');
      p.temp=null; p.screen='tavern';
      return render(p);
    }
    function onProposalInbox(p,t){ const raw=t.trim().toLowerCase();
      if (raw==='v'){ p.temp=null; p.screen='tavern'; return render(p); }
      if (!p.temp || p.temp.mode!=='inbox'){ p.screen='tavern'; return render(p); }
      const proposals = Array.isArray(p.temp.proposals) ? p.temp.proposals : [];
      if (!proposals.length) return api.print('No proposals to review. Type v to return.','dim');
      const action = raw[0];
      const num = parseInt(raw.replace(/[^0-9]/g,''),10);
      if (!num || num<1 || num>proposals.length) return api.print('Use A# to accept or D# to decline.','dim');
      const proposal = proposals[num-1];
      if (!proposal){ return api.print('That proposal is no longer available.','yellow'); }
      if (action==='a'){ if (isMarried(p)) return api.print('You are already wed.','yellow');
        const suitor = getPlayerByIdRaw(proposal.fromId);
        if (!suitor){ api.print('That suitor has vanished.','yellow'); removeProposal(proposal.id); p.temp.proposals = getPendingProposalsFor(p.userId); return render(p); }
        if (isMarried(suitor)){ api.print(`${safeName(suitor.name)} has already wed another.`, 'yellow'); removeProposal(proposal.id); p.temp.proposals = getPendingProposalsFor(p.userId); return render(p); }
        const now = nowEpoch();
        const spouseName = safeName(suitor.name);
        const selfName = safeName(p.name);
        p.spouseId = String(suitor.userId);
        p.spouseName = spouseName;
        p.marriedOn = now;
        suitor.spouseId = String(p.userId);
        suitor.spouseName = selfName;
        suitor.marriedOn = now;
        removeProposal(proposal.id);
        clearProposalsFor(p.userId);
        clearProposalsFor(suitor.userId);
        savePlayer(p);
        putPlayerRaw(suitor);
        api.print(`You and ${spouseName} are wed beneath the tavern lanterns!`,'green');
        if (typeof addNews === 'function') addNews(`${safeName(p.name)} and ${spouseName} were wed.`);
        p.temp=null; p.screen='tavern';
        return render(p);
      }
      if (action==='d'){ removeProposal(proposal.id); api.print(`You decline ${proposal.fromName}'s proposal.`, 'dim'); p.temp.proposals = getPendingProposalsFor(p.userId); if (!p.temp.proposals.length){ p.temp=null; p.screen='tavern'; } return render(p); }
      api.print('Use A# to accept or D# to decline.','dim');
    }
    function onStatus(p,t){ if (t.toLowerCase()==='v'){ p.screen='town'; return render(p); } api.print('Type v to return.','dim'); }
    function onDuel(p,t){
      const raw=t.trim().toLowerCase();
      if (raw==='v'){ p.temp=null; p.screen='town'; return render(p); }
      if (p.daily.duelUsed) return api.print('You already fought today.','yellow');
      const opponents = Array.isArray(p.temp?.opponents) ? p.temp.opponents : getOpponentsFor(p);
      if (!opponents.length){ p.temp={ opponents: [] }; return api.print('No challengers stand before you.','dim'); }
      const choice=parseInt(raw,10);
      if (Number.isNaN(choice) || choice<1 || choice>opponents.length){ return api.print('Choose a fighter by number, or V to return.','dim'); }
      const target=opponents[choice-1];
      const defender=getPlayerByIdRaw(target.user_id);
      if (!defender){
        api.print('That challenger has left the grounds.','yellow');
        p.temp={ opponents: getOpponentsFor(p) };
        return render(p);
      }
      if (defender.userId === p.userId){ return api.print('You cannot duel yourself.','yellow'); }

      const attackerStats={ atk:WEAPONS[p.weaponIdx]?.atk||0, def:ARMOR[p.armorIdx]?.def||0, hp:p.maxHp, level:p.level, charm:p.charm||0 };
      const defenderStats={ atk:WEAPONS[defender.weaponIdx]?.atk||0, def:ARMOR[defender.armorIdx]?.def||0, hp:defender.maxHp, level:defender.level, charm:defender.charm||0 };
      let attackerHp=attackerStats.hp;
      let defenderHp=defenderStats.hp;
      let rounds=0;
      while (rounds<20 && attackerHp>0 && defenderHp>0){
        rounds++;
        const dmgToDef=Math.max(1, attackerStats.atk + randInt(0,3) - defenderStats.def);
        defenderHp=Math.max(0, defenderHp - dmgToDef);
        if (defenderHp<=0) break;
        const dmgToAtt=Math.max(1, defenderStats.atk + randInt(0,3) - attackerStats.def);
        attackerHp=Math.max(0, attackerHp - dmgToAtt);
      }

      let winner=null, loser=null, method='ko';
      if (attackerHp>0 && defenderHp<=0){
        winner=p; loser=defender; method='ko';
      } else if (defenderHp>0 && attackerHp<=0){
        winner=defender; loser=p; method='ko';
      } else {
        if (p.level !== defender.level){
          winner = p.level > defender.level ? p : defender;
          loser = winner === p ? defender : p;
          method='level';
        } else if ((p.charm||0) !== (defender.charm||0)){
          winner = (p.charm||0) > (defender.charm||0) ? p : defender;
          loser = winner === p ? defender : p;
          method='charm';
        } else {
          winner = randInt(0,1) === 0 ? p : defender;
          loser = winner === p ? defender : p;
          method='luck';
        }
      }

      const xpGain=randInt(8,12);
      const goldTransfer=Math.max(0, Math.floor(Math.max(0, loser.gold || 0) * 0.05));
      if (goldTransfer>0){
        loser.gold=Math.max(0, (loser.gold||0) - goldTransfer);
        winner.gold=(winner.gold||0) + goldTransfer;
      }
      winner.kills=(winner.kills||0)+1;
      loser.deaths=(loser.deaths||0)+1;
      winner.xp=(winner.xp||0)+xpGain;
      if (winner===p) applyLevelUps(p); else applyLevelUpsSilent(winner);

      p.daily.duelUsed = true;

      const result={
        opponent:defender.name,
        rounds,
        attackerWon:winner===p,
        method,
        xpGain:winner===p?xpGain:0,
        xpEnemy:winner===defender?xpGain:0,
        goldWon:winner===p?goldTransfer:0,
        goldLost:winner===defender?goldTransfer:0,
        winnerName:winner.name
      };

      p.screen='duel:result';
      p.temp={ duelResult: result };

      if (winner===p){ savePlayer(p); putPlayerRaw(defender); }
      else { putPlayerRaw(defender); savePlayer(p); }
      return render(p);
    }
    function onDuelResult(p,t){
      if (t.trim().toLowerCase()==='v'){ p.temp=null; p.screen='town'; return render(p); }
      api.print('Type v to return.','dim');
    }
    function onTraining(p,t){
      const k=t.trim().toLowerCase();
      if (k==='v'){ p.screen='town'; return render(p); }
      if (CLASS_ENABLED && (k==='c'||k.startsWith('class'))){ p.screen='training:class'; return render(p); }
      if (k==='s'||k.startsWith('spar')){
        if (p.gold < 80) return api.print('Turgon grunts: "Come back with more gold."','yellow');
        p.gold -= 80; p.xp += 10; api.print('You spar with Turgon and feel sharper. (+10 xp)','green');
        applyLevelUps(p); savePlayer(p); return render(p);
      }
      if (k==='e'||k.startsWith('end')){
        if (p.gold < 120) return api.print('The drills are not free — earn more coin first.','yellow');
        p.gold -= 120; p.maxHp += 3; p.hp = Math.min(p.maxHp, p.hp + 3);
        api.print('Endurance training leaves you hardier. Max HP +3.','green');
        savePlayer(p); return render(p);
      }
      if (k==='w'||k.startsWith('swag')||k.startsWith('charm')){
        if (p.charm >= CHARM_MAX) return api.print('Turgon laughs: "Your swagger is already legendary."','yellow');
        if (p.gold < 60) return api.print('Swagger lessons require coin you do not possess.','yellow');
        p.gold -= 60; p.charm = clamp(p.charm + 1, 0, CHARM_MAX);
        api.print('You perfect a roguish grin. Charm +1.','green');
        savePlayer(p); return render(p);
      }
      const fallback = CLASS_ENABLED
        ? 'Type s (sparring), e (endurance), w (swagger), c (class), or v to return.'
        : 'Type s (sparring), e (endurance), w (swagger), or v to return.';
      api.print(fallback,'dim');
    }
    function onClass(p,t){
      const raw=t.trim().toLowerCase();
      if (raw==='v'){ p.screen='training'; return render(p); }
      if (!CLASS_ENABLED){
        api.print('Classes are not available right now.','yellow');
        return;
      }
      const current = getClassInfo(p.classId);
      if (current){
        if (ALLOW_CLASS_RESPEC && raw==='r'){
          const cost = Math.max(0, RESPEC_COST_GOLD || 0);
          if (cost > 0 && p.gold < cost) return api.print(`You need ${cost} gold to respec.`, 'yellow');
          if (cost > 0) p.gold -= cost;
          p.classId = null;
          if (p.temp && p.temp.combat) delete p.temp.combat;
          api.print('You set aside your former path. Choose a new calling.','green');
          savePlayer(p);
          return render(p);
        }
        const reminder = ALLOW_CLASS_RESPEC ? 'Type r to respec, or v to return.' : 'Type v to return.';
        api.print(reminder,'dim');
        return;
      }
      const option = CLASS_KEY_LOOKUP[raw];
      if (!option){
        api.print('Choose one of the classes shown, or type v to return.','yellow');
        return;
      }
      p.classId = option.id;
      p.screen = 'training';
      savePlayer(p);
      api.print(`You embrace the path of the ${option.name}.`,'green');
      return render(p);
    }
    function onNews(p,t){ if (t.toLowerCase()==='v'){ p.screen='town'; return render(p); } api.print('Type v to return.','dim'); }
    function onMail(p,t){
      const raw = String(t || '').trim();
      const k = raw.toLowerCase();
      if (!raw){ return mailMenu(p); }
      if (k === 'v' || k === 'town'){ clearMailTemp(p); p.screen='town'; return render(p); }
      if (k === 'i' || k.startsWith('inbox')){ p.screen='mail:inbox'; return render(p); }
      if (k === 'c' || k.startsWith('comp') || k.startsWith('write')){
        const limit = Math.max(0, MAIL_SEND_DAILY_LIMIT || 0);
        const used = Math.max(0, p.daily?.mailSent || 0);
        if (limit > 0 && used >= limit){
          api.print('You have already sent the maximum amount of mail today.','yellow');
          return;
        }
        const mailTemp = getMailTemp(p);
        mailTemp.draft = {
          step:'recipient',
          searchTerm:'',
          recipients:[],
          toId:null,
          toName:null,
          subject:'',
          body:''
        };
        p.screen='mail:compose';
        return render(p);
      }
      api.print('Options: I) Inbox, C) Compose, or V) Return.','dim');
    }
    function onInbox(p,t){
      const mailTemp = getMailTemp(p);
      const raw = String(t || '').trim();
      const k = raw.toLowerCase();
      if (!raw){ return inboxMenu(p); }
      if (k === 'v'){ p.screen='mail'; return render(p); }
      const list = Array.isArray(mailTemp.inbox) ? mailTemp.inbox : getInboxMessages(p);
      const idx = parseInt(raw, 10);
      if (Number.isNaN(idx) || idx < 1 || idx > list.length){
        api.print('Choose a number from the list, or v to return.','dim');
        return;
      }
      const chosen = list[idx-1];
      if (!chosen){
        api.print('That message is no longer available.','yellow');
        mailTemp.inbox = getInboxMessages(p);
        return render(p);
      }
      const mail = getMailByIdForPlayer(p, chosen.id);
      if (!mail){
        api.print('That message is no longer available.','yellow');
        mailTemp.inbox = getInboxMessages(p);
        return render(p);
      }
      if (mail.unread){
        markMailRead(mail.id);
        mail.unread = 0;
        chosen.unread = 0;
      }
      mailTemp.current = mail;
      p.screen='mail:read';
      return render(p);
    }
    function onReadMail(p,t){
      const mailTemp = getMailTemp(p);
      const mail = mailTemp.current;
      const raw = String(t || '').trim();
      const k = raw.toLowerCase();
      if (!raw || k === 'v' || k === 'i'){ mailTemp.current = null; p.screen='mail:inbox'; return render(p); }
      if (k === 'r' || k.startsWith('reply')){
        if (!mail || !mail.fromId || String(mail.fromId) === String(p.userId)){
          return api.print('No reply target available.','yellow');
        }
        const target = getPlayerByIdRaw(mail.fromId);
        if (!target){
          return api.print('That adventurer is no longer here to receive your reply.','yellow');
        }
        const baseSubject = mail.subject || '';
        const hasPrefix = baseSubject.toLowerCase().startsWith('re:');
        const proposed = hasPrefix ? baseSubject : `Re: ${baseSubject}`;
        const replySubject = sanitizeMailSubject(proposed) || 'Re: (no subject)';
        const mailTempState = getMailTemp(p);
        mailTempState.draft = {
          step:'subject',
          searchTerm:'',
          recipients:[],
          toId:String(target.userId),
          toName:safeName(target.name),
          subject:replySubject,
          body:''
        };
        p.screen='mail:compose';
        return render(p);
      }
      api.print('Type r to reply, or v to return to the inbox.','dim');
    }
    function onComposeMail(p,t){
      const mailTemp = getMailTemp(p);
      const draft = ensureMailDraft(p);
      const raw = String(t || '');
      const trimmed = raw.trim();
      const k = trimmed.toLowerCase();
      const limit = Math.max(0, MAIL_SEND_DAILY_LIMIT || 0);
      const used = Math.max(0, p.daily?.mailSent || 0);
      if (k === 'v'){ delete mailTemp.draft; mailTemp.recipients = []; p.screen='mail'; return render(p); }
      if (limit > 0 && used >= limit){
        api.print('You have already sent the maximum amount of mail today.','yellow');
        delete mailTemp.draft;
        mailTemp.recipients = [];
        p.screen='mail';
        return render(p);
      }
      if (draft.step === 'recipient'){
        if (!trimmed){ return composeMailFlow(p); }
        const match = trimmed.match(/^(n|name)\s*(.*)$/i);
        if (match){
          draft.searchTerm = match[2] ? match[2].trim() : '';
          return render(p);
        }
        const list = Array.isArray(mailTemp.recipients) ? mailTemp.recipients : listMailRecipients(p, draft.searchTerm || '');
        const idx = parseInt(trimmed, 10);
        if (Number.isNaN(idx) || idx < 1 || idx > list.length){
          api.print('Choose a number from the list, N <name> to search, or V to cancel.','dim');
          return;
        }
        const choice = list[idx-1];
        if (!choice){
          api.print('That adventurer is no longer available.','yellow');
          mailTemp.recipients = listMailRecipients(p, draft.searchTerm || '');
          return render(p);
        }
        if (String(choice.userId) === String(p.userId)){
          api.print('You cannot send mail to yourself.','yellow');
          return;
        }
        const target = getPlayerByIdRaw(choice.userId);
        if (!target){
          api.print('That adventurer slips away.','yellow');
          mailTemp.recipients = listMailRecipients(p, draft.searchTerm || '');
          return render(p);
        }
        draft.toId = String(target.userId);
        draft.toName = safeName(target.name);
        draft.step = 'subject';
        draft.subject = draft.subject || '';
        draft.body = '';
        mailTemp.recipients = [];
        return render(p);
      }
      if (draft.step === 'subject'){
        if (!trimmed && draft.subject){ draft.step='body'; return render(p); }
        const subject = sanitizeMailSubject(trimmed);
        if (!subject){
          api.print('Subject cannot be blank.','yellow');
          return;
        }
        const original = stripControls(trimmed, false).trim();
        if (subject.length < original.length){ api.print('Subject truncated to 40 characters.','dim'); }
        draft.subject = subject;
        draft.step = 'body';
        return render(p);
      }
      if (draft.step === 'body'){
        if (!trimmed && draft.body){ draft.step='confirm'; return render(p); }
        const cleaned = stripControls(raw, true).trim();
        const body = sanitizeMailBody(raw);
        if (!body){
          api.print('Message cannot be blank.','yellow');
          return;
        }
        if (body.length < cleaned.length){ api.print('Message truncated to 500 characters.','dim'); }
        draft.body = body;
        draft.step = 'confirm';
        return render(p);
      }
      if (draft.step === 'confirm'){
        if (k === 's' || k === 'send' || k === 'y'){
          if (!draft.toId || !draft.toName){ draft.step='recipient'; return render(p); }
          const subject = sanitizeMailSubject(draft.subject);
          const body = sanitizeMailBody(draft.body);
          if (!subject){ draft.step='subject'; api.print('Subject cannot be blank.','yellow'); return; }
          if (!body){ draft.step='body'; api.print('Message cannot be blank.','yellow'); return; }
          if (String(draft.toId) === String(p.userId)){ api.print('You cannot send mail to yourself.','yellow'); draft.step='recipient'; draft.toId=null; draft.toName=null; return; }
          const target = getPlayerByIdRaw(draft.toId);
          if (!target){ api.print('That adventurer is no longer around.','yellow'); draft.step='recipient'; draft.toId=null; draft.toName=null; return render(p); }
          addMailRecord(p, target, subject, body);
          const nextUsed = used + 1;
          p.daily.mailSent = limit > 0 ? Math.min(limit, nextUsed) : nextUsed;
          savePlayer(p);
          api.print(`You send your message to ${draft.toName}.`,'green');
          delete mailTemp.draft;
          mailTemp.recipients = [];
          p.screen='mail';
          return render(p);
        }
        if (k === 'u' || k.startsWith('subject')){ draft.step='subject'; return render(p); }
        if (k === 'b' || k.startsWith('body')){ draft.step='body'; return render(p); }
        api.print('Type s to send, u to edit subject, b to edit body, or v to cancel.','dim');
        return;
      }
      draft.step = 'recipient';
      return render(p);
    }
    function handleDivorce(p){
      if (!isMarried(p)) return api.print('You are not married.','yellow');
      const spouseKey = p.spouseId ? String(p.spouseId) : null;
      const spouse = spouseKey ? getPlayerByIdRaw(spouseKey) : null;
      const spouseName = safeName(p.spouseName || (spouse?.name) || 'Unknown');
      const goldCost = Math.max(0, DIVORCE_GOLD_COST || 0);
      const charmCost = Math.max(0, DIVORCE_CHARM_COST || 0);
      p.spouseId = null;
      p.spouseName = null;
      p.marriedOn = 0;
      if (goldCost > 0) p.gold = Math.max(0, (p.gold || 0) - goldCost);
      if (charmCost > 0) p.charm = clamp((p.charm || 0) - charmCost, 0, CHARM_MAX);
      savePlayer(p);
      if (spouse){ spouse.spouseId = null; spouse.spouseName = null; spouse.marriedOn = 0; putPlayerRaw(spouse); }
      clearProposalsFor(p.userId);
      if (spouseKey) clearProposalsFor(spouseKey);
      api.print(`You part ways with ${spouseName}.`, 'yellow');
      if (goldCost > 0 || charmCost > 0){ const parts=[]; if (goldCost>0) parts.push(`-${goldCost} gold`); if (charmCost>0) parts.push(`-${charmCost} charm`); api.print(`Penalty: ${parts.join(', ')}.`, 'dim'); }
      if (typeof addNews === 'function') addNews(`${safeName(p.name)} and ${spouseName} parted ways.`);
      return render(p);
    }
    function onConjugality(p,t){ const raw=t.trim().toLowerCase();
      if (raw==='v'){ p.screen='town'; return render(p); }
      if (raw==='d'){ if (!isMarried(p)) return api.print('You are not married.','yellow'); return handleDivorce(p); }
      api.print(isMarried(p) ? 'Type d to divorce, or v to return.' : 'Type v to return.','dim'); }
    function onAnnounce(p,t){
      const raw = String(t || '');
      const trimmed = raw.trim();
      const k = trimmed.toLowerCase();
      if (k === 'v'){ p.screen='town'; return render(p); }
      if (p.daily?.announced){
        api.print('You already made an announcement today.','yellow');
        return;
      }
      if (!trimmed){
        api.print('Enter your announcement, or type v to cancel.','dim');
        return;
      }
      const subject = sanitizeAnnouncement(raw);
      if (!subject){
        api.print('Announcement cannot be blank.','yellow');
        return;
      }
      const cleaned = stripControls(raw, false).trim();
      if (subject.length < cleaned.length){ api.print('Announcement truncated to 60 characters.','dim'); }
      if (typeof addNews === 'function'){
        try { addNews(`${p.name} announces: ${subject}`); } catch (err) { console.error('[lord] addNews failed:', err); }
      }
      p.daily.announced = true;
      savePlayer(p);
      api.print('Your words echo through the town square.','green');
      p.screen='town';
      return render(p);
    }
    function onPeople(p,t){ if (t.toLowerCase()==='v'){ p.screen='town'; return render(p); } api.print('Type v to return.','dim'); }

    // Render multiplexer
    function render(p){
      setPromptLord();
      switch (p.screen){
        case 'create:name':     return renderCreateName();
        case 'create:gender':   return renderCreateGender(p.temp?.name || fallbackName);
        case 'create:confirm':  return renderCreateConfirm(p.temp?.name || fallbackName, p.temp?.gender || null);
        case 'town':       return townSquareMenu(p);
        case 'forest':     return forestMenu(p);
        case 'forest:event': return renderForestEvent(p);
        case 'inn':        return innMenu(p);
        case 'blacksmith': return smithMenu(p);
        case 'armorer':    return armorerMenu(p);
        case 'healer':     return healerMenu(p);
        case 'bank':       return bankMenu(p);
        case 'bank:dep':   return bankDepositPrompt(p);
        case 'bank:wit':   return bankWithdrawPrompt(p);
        case 'jeweler':    return jewelerMenu(p);
        case 'rankings':   return rankingsMenu();
        case 'tavern':     return tavernMenu(p);
        case 'tavern:propose': return marriageProposeMenu(p);
        case 'tavern:inbox':   return proposalInboxMenu(p);
        case 'status':     return statusMenu(p);
        case 'duel':       return duelsMenu(p);
        case 'duel:result':return duelResultMenu(p);
        case 'training':   return trainingMenu(p);
        case 'training:class': return classMenu(p);
        case 'news':       return newsMenu(p);
        case 'mail':       return mailMenu(p);
        case 'mail:inbox': return inboxMenu(p);
        case 'mail:read':  return readMailView(p);
        case 'mail:compose': return composeMailFlow(p);
        case 'conjugality':return conjugalityMenu(p);
        case 'announce':   return announcePrompt(p);
        case 'people':     return peopleMenu(p);
        case 'combat':     return renderCombat(p);
        default:           p.screen='town'; return townSquareMenu(p);
      }
    }

    // Door lifecycle
    function enter(){
      // initialize DB only when entering the door
      lazyInitDB();

      let existing = dbGetPlayer();
      if (!existing){
        const p = defaultPlayer(fallbackName, null);
        p.screen = 'create:name';
        p.temp = { name:fallbackName, step:'name' };
        savePlayer(p);
        api.batch(b=>{ b.clear(); b.print('== Legend of the Redux Dragon ==','magenta'); b.hr(); b.print('A new adventurer approaches…','cyan'); });
        return render(p);
      } else {
        api.batch(b=>{ b.clear(); b.print('== Legend of the Redux Dragon ==','magenta'); b.hr(); b.print(`Welcome back, ${existing.name}.`); });
        if (existing.screen && existing.screen.startsWith('create:')) return render(existing);
        if (!existing.screen || existing.screen === 'village') existing.screen = 'town';
        savePlayer(existing);
        return render(existing);
      }
    }

    function leave(){ const p=dbGetPlayer(); if (p) savePlayer(p); api.print('You leave the realm and return to the BBS…','dim'); setPromptDIS(); }

    function handleCommand(cmd,args){
      if (cmd==='help' || cmd==='?'){ api.hr(); api.print('Inside LORD, only these slash commands work:', 'cyan'); api.print('/help — show this help'); api.print('/leave — return to DIS'); api.hr(); api.print('Otherwise, type menu letters/words (e.g., F, K, A, V, forest, bank).','dim'); return true; }
      api.print('You are inside a game. Use /leave to return to the BBS.','yellow'); return true;
    }

    function handleRaw(text){
      const raw=String(text||'').trim(); if (!raw) return true;
      let p = dbGetPlayer();
      if (!p){ p=defaultPlayer(fallbackName,null); p.screen='create:name'; p.temp={ name:fallbackName, step:'name' }; savePlayer(p); }

      const nowTs = nowEpoch();
      p.lastSeen = nowTs;
      savePlayer(p);

      p.daily = normalizeDaily(p.daily);
      const today = todayKey();
      if (p.daily.lastDate !== today){
        const lastDate = p.daily.lastDate;
        if (p.daily.interestDate !== lastDate){
          api.print('A new day has begun. Your turns are refreshed.','green');
          let interest = applyBankInterest(p, lastDate || today);
          if (interest === null) interest = 0;
          api.print(`Your bank earns ${interest} gold interest.`, interest>0 ? 'green' : 'dim');
          const refreshed = defaultDaily(today);
          p.daily = refreshed;
        } else {
          p.daily.lastDate = today;
        }
        if (p.daily) p.daily.jewelerPurchases = 0;
        savePlayer(p);
      }

      // Creation flow
      if (p.screen==='create:name'){ const name = raw || fallbackName; p.temp={ name, step:'gender' }; p.screen='create:gender'; savePlayer(p); render(p); return true; }
      if (p.screen==='create:gender'){
        const k=raw.toLowerCase(); let gender=null;
        if (k==='m'||k==='male') gender='Male';
        else if (k==='f'||k==='female') gender='Female';
        else if (k==='n'||k==='nb'||k==='non-binary'||k==='other') gender='Other';
        else { api.print('Please type M, F, or N.','yellow'); return true; }
        p.temp.gender=gender; p.temp.step='confirm'; p.screen='create:confirm'; savePlayer(p); render(p); return true;
      }
      if (p.screen==='create:confirm'){
        const k=raw.toLowerCase();
        if (k==='y'||k==='yes'){ const finalized=defaultPlayer(p.temp.name, p.temp.gender); savePlayer(finalized); api.print(`Welcome to the realm, ${finalized.name}! Your journey begins…`,'green'); return render(finalized); }
        if (k==='n'||k==='no'){ p.screen='create:name'; p.temp={ name:fallbackName, step:'name' }; savePlayer(p); render(p); return true; }
        api.print('Type Y to confirm, or N to change your name/gender.','yellow'); return true;
      }

      // Gameplay routing
      switch (p.screen){
        case 'town':       onTown(p, raw);       break;
        case 'forest':     onForest(p, raw);     break;
        case 'forest:event': onForestEvent(p, raw); break;
        case 'combat':     onCombat(p, raw);     break;
        case 'inn':        onInn(p, raw);        break;
        case 'blacksmith': onSmith(p, raw);      break;
        case 'armorer':    onArmorer(p, raw);    break;
        case 'healer':     onHealer(p, raw);     break;
        case 'bank':       onBank(p, raw);       break;
        case 'bank:dep':
        case 'bank:wit':   onBankAmount(p, raw); break;
        case 'jeweler':    onJeweler(p, raw);    break;
        case 'rankings':   onRankings(p, raw);   break;
        case 'tavern':     onTavern(p, raw);     break;
        case 'tavern:propose': onMarriagePropose(p, raw); break;
        case 'tavern:inbox':   onProposalInbox(p, raw); break;
        case 'status':     onStatus(p, raw);     break;
        case 'duel':       onDuel(p, raw);       break;
        case 'duel:result':onDuelResult(p, raw); break;
        case 'training':   onTraining(p, raw);   break;
        case 'training:class': onClass(p, raw);  break;
        case 'news':       onNews(p, raw);       break;
        case 'mail':       onMail(p, raw);       break;
        case 'mail:inbox': onInbox(p, raw);      break;
        case 'mail:read':  onReadMail(p, raw);   break;
        case 'mail:compose': onComposeMail(p, raw); break;
        case 'conjugality':onConjugality(p, raw);break;
        case 'announce':   onAnnounce(p, raw);   break;
        case 'people':     onPeople(p, raw);     break;
        default:           p.screen='town'; render(p);
      }
      return true;
    }

    return { enter, leave, handleCommand, handleRaw };
  }
};
