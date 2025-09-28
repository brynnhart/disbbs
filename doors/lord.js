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
    if (!G[MEMKEY]) G[MEMKEY] = { players: new Map() };
    const MEM = G[MEMKEY];

    let dbReady = false;
    let useDB = false;
    let db = null, selectPlayer = null, insertPlayer = null, updatePlayer = null, topHeroesStmt = null, opponentsStmt = null;

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
            screen       TEXT
          );
          CREATE INDEX IF NOT EXISTS idx_lord_players_updated ON lord_players(updated_at DESC);
        `);

        selectPlayer = db.prepare(`SELECT * FROM lord_players WHERE user_id = ?`);
        insertPlayer = db.prepare(`
          INSERT INTO lord_players (
            user_id, char_name, gender, created_at, updated_at,
            level, xp, hp, max_hp, gold, bank, weapon_idx, armor_idx,
            charm, kills, deaths, day_count, daily_json, expert, screen
          ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        `);
        updatePlayer = db.prepare(`
          UPDATE lord_players
             SET char_name=?, gender=?, updated_at=?,
                 level=?, xp=?, hp=?, max_hp=?, gold=?, bank=?, weapon_idx=?, armor_idx=?,
                 charm=?, kills=?, deaths=?, day_count=?, daily_json=?, expert=?, screen=?
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
    const DRAGON_LEVEL_REQ = 12;
    const DRAGON_FIND_CHANCE = 0.15;
    const DRAGON_GOLD_MIN = 500;
    const DRAGON_GOLD_MAX = 700;
    const CAMP_HEAL_PCT = 0.30;
    const DAILY_HEALS = 2;
    function timeLeftMMSS() {
      const now = new Date(); const end = new Date(now); end.setHours(23,59,59,999);
      const s = Math.max(0, Math.floor((end - now)/1000));
      const mm = String(Math.floor(s/60)).padStart(2,'0'); const ss = String(s%60).padStart(2,'0');
      return `${mm}:${ss}`;
    }

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
      return { forestTurns:10, tavernDrinks:2, heals:DAILY_HEALS, slept:false, duelUsed:false, lastDate:key, interestDate:null };
    }
    function normalizeDaily(d){
      const today = todayKey();
      if (!d) return defaultDaily(today);
      if (typeof d.forestTurns === 'undefined') d.forestTurns = 10;
      if (typeof d.tavernDrinks === 'undefined') d.tavernDrinks = 2;
      if (typeof d.heals === 'undefined') d.heals = DAILY_HEALS;
      if (typeof d.slept === 'undefined') d.slept = false;
      if (typeof d.duelUsed === 'undefined') d.duelUsed = false;
      if (!d.lastDate || typeof d.lastDate !== 'string') d.lastDate = today;
      if (typeof d.interestDate === 'undefined') d.interestDate = null;
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
        expert: p.expert ? 1 : 0, screen: p.screen
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
        expert: !!r.expert, screen: r.screen || 'town', combat: null, temp: null
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
        if (existing) existing.daily = normalizeDaily(existing.daily);
        return existing;
      }
      const r = selectPlayer.get(userId); return r ? fromRow(r) : null;
    }
    function dbInsertPlayer(p){
      if (!useDB) return memPut(p);
      const r = toRow(p);
      insertPlayer.run(
        r.user_id, r.char_name, r.gender, r.created_at, r.updated_at,
        r.level, r.xp, r.hp, r.max_hp, r.gold, r.bank, r.weapon_idx, r.armor_idx,
        r.charm, r.kills, r.deaths, r.day_count, r.daily_json, r.expert, r.screen
      );
    }
    function dbUpdatePlayer(p){
      if (!useDB) return memPut(p);
      const r = toRow(p);
      updatePlayer.run(
        r.char_name, r.gender, r.updated_at,
        r.level, r.xp, r.hp, r.max_hp, r.gold, r.bank, r.weapon_idx, r.armor_idx,
        r.charm, r.kills, r.deaths, r.day_count, r.daily_json, r.expert, r.screen,
        r.user_id
      );
    }
    function savePlayer(p){ p.updatedAt = nowEpoch(); const exists = !!dbGetPlayer(); exists ? dbUpdatePlayer(p) : dbInsertPlayer(p); }
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
      if (mem) mem.daily = normalizeDaily(mem.daily);
      return mem;
    }
    function putPlayerRaw(player){
      if (!player) return;
      player.updatedAt = nowEpoch();
      if (useDB){
        const row = selectPlayer.get(player.userId);
        if (row) dbUpdatePlayer(player); else dbInsertPlayer(player);
      } else {
        MEM.players.set(player.userId, memClone(player));
      }
    }
    function topHeroes(){ return useDB ? topHeroesStmt.all() : memTop(); }

    // ─────────────────────────────────────────────────────────────
    // Character creation
    function defaultPlayer(charName, gender){
      const now = nowEpoch();
      return {
        userId, name: charName || fallbackName, gender: gender || null,
        createdAt: now, updatedAt: now,
        level:1, xp:0, hp:30, maxHp:30, gold:50, bank:0, weaponIdx:0, armorIdx:0,
        charm:0, kills:0, deaths:0, dayCount:1, daily: defaultDaily(),
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
      api.print(`Gold: ${p.gold}  Bank: ${p.bank}  Kills: ${p.kills}  Deaths: ${p.deaths}`);
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
        row('P','eople Online','Q','uit to Fields');
        api.hr(); api.print('The Town Square    (? for menu)','magenta'); api.print('(F,S,K,A,H,V,I,T,Y,L,W,D,C,O,X,M,P,Q)','dim');
      } else {
        api.print('[Expert Mode] F S K A H V I T Y L W D C O X M P Q','magenta');
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
    function bankDepositPrompt(p){ printHeader('Bank — Deposit'); showStatus(p);
      api.print(`You carry ${p.gold} gold. How much to deposit?`,'cyan'); api.hr(); api.print('Type a number, or v to cancel.','dim'); p.temp={mode:'deposit'}; }
    function bankWithdrawPrompt(p){ printHeader('Bank — Withdraw'); showStatus(p);
      api.print(`You have ${p.bank} gold in the bank. How much to withdraw?`,'cyan'); api.hr(); api.print('Type a number, or v to cancel.','dim'); p.temp={mode:'withdraw'}; }
    function rankingsMenu(){ printHeader('Heroes of the Realm');
      const rows = topHeroes(); if (!rows.length) api.print('No heroes recorded yet.','dim');
      rows.forEach((r,i)=> api.print(`${i+1}. ${r.name}  Lv${r.level}  K:${r.kills} D:${r.deaths}  Riches:${r.wealth}`));
      api.hr(); api.print('V) Return to Town Square','dim'); }
    function tavernMenu(p){ printHeader('The Tavern'); showStatus(p);
      api.print('G) Gossip — overhear a rumor'); api.print('D) Drink — regain a few HP (limited per day)');
      api.print('V) Return to Town Square'); api.hr(); api.print('Type: g, d, or v','dim'); }
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
      if (p.charm >= 10) api.print('Your charm already dazzles the realm; further swagger is impossible.','dim');
      api.print('V) Return to Town Square');
      api.hr();
      api.print('Type: s, e, w, or v.','dim');
    }
    function newsMenu(p){ stubMenu('Daily News', p); }
    function mailMenu(p){ stubMenu('Write Mail', p); }
    function conjugalityMenu(p){ stubMenu('Conjugality List', p); }
    function announceMenu(p){ stubMenu('Town Announcements', p); }
    function peopleMenu(p){ stubMenu('People Online', p); }

    // Combat
    function genEnemy(p){ const idx=clamp(p.level-1+randInt(-1,1),0,ENEMIES.length-1); const name=ENEMIES[idx];
      const base=Math.max(1, p.level+randInt(0,2));
      return { name, hp:10+base*5+randInt(-3,3), maxHp:10+base*5, atk:Math.max(2, base*2+randInt(0,2)), def:Math.max(1, base+randInt(0,1)), fleeAttempts:0 }; }
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
      const dmgToEnemy=Math.max(1, WEAPONS[p.weaponIdx].atk + randInt(0,3) - e.def);
      e.hp=Math.max(0, e.hp-dmgToEnemy); api.print(`You strike the ${e.name} for ${dmgToEnemy}.`,'green');
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
        applyLevelUps(p);
        p.combat=null; savePlayer(p); api.hr(); p.screen='forest'; return render(p); }
      const dmgToYou=Math.max(1, e.atk + randInt(0,3) - ARMOR[p.armorIdx].def);
      p.hp=Math.max(0, p.hp-dmgToYou); api.print(`The ${e.name} hits you for ${dmgToYou}.`,'yellow');
      if (p.hp<=0){ api.print('You fall in battle…','red'); p.deaths++; const loss=Math.floor(p.gold*0.25); p.gold-=loss; api.print(`You lose ${loss} gold. You are carried back to the Inn.`,'yellow');
        p.hp=Math.ceil(p.maxHp/2); p.daily.forestTurns=0; p.combat=null; savePlayer(p); api.hr(); p.screen='inn'; return render(p); }
      renderCombat(p); }
    function doFlee(p){ const e=p.combat; if (!e) return;
      const chance=50 - e.fleeAttempts*10 + (p.level*3); const roll=randInt(1,100);
      if (roll<=chance){ api.print('You escape into the trees!','green'); if (!e.boss) p.daily.forestTurns=Math.max(0, p.daily.forestTurns-1); p.combat=null; savePlayer(p); p.screen='forest'; return render(p); }
      e.fleeAttempts++; api.print('You fail to flee!','yellow'); const dmg=Math.max(1, e.atk + randInt(0,2) - ARMOR[p.armorIdx].def);
      p.hp=Math.max(0, p.hp-dmg); api.print(`The ${e.name} punishes your back for ${dmg}.`,'yellow');
      if (p.hp<=0){ api.print('You fall while fleeing…','red'); p.deaths++; const loss=Math.floor(p.gold*0.25); p.gold-=loss; api.print(`You lose ${loss} gold.`,'yellow');
        p.hp=Math.ceil(p.maxHp/2); p.daily.forestTurns=0; p.combat=null; savePlayer(p); p.screen='inn'; return render(p); }
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
      if (k==='m'||k.startsWith('m')||k.startsWith('hunt')||k.startsWith('fight')){ p.combat=genEnemy(p); p.screen='combat'; return render(p); }
      if (k.startsWith('s')||k==='s'){ const gold=randInt(2,15)+randInt(0,p.level); p.daily.forestTurns--; p.gold+=gold; api.print(`You find ${gold} gold.`,'green'); savePlayer(p); return render(p); }
      if (k.startsWith('d')||k==='d'){
        if (p.level < DRAGON_LEVEL_REQ) return api.print('The legends warn that the Dragon is beyond your skill for now.','yellow');
        p.daily.forestTurns=Math.max(0, p.daily.forestTurns-1);
        const dragon=maybeDragon(p);
        if (!dragon){ api.print('You scour the groves but find no sign of the Dragon.','yellow'); savePlayer(p); return render(p); }
        api.print('A thunderous roar shakes the canopy — the Ancient Dragon descends!','red');
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
    function onRankings(p,t){ if (t.toLowerCase()==='v'){ p.screen='town'; return render(p); } api.print('Type v to return.','dim'); }
    function onTavern(p,t){ const k=t.toLowerCase(); if (k==='v'){ p.screen='town'; return render(p); }
      if (k==='g'){ const rumors=['They say a dragon’s hoard lies deep in the forest…','The Blacksmith sharpens for free if you’re charming — or so they say.','A hidden grove yields gold to those who listen to the wind.','Beware the Black Knight past the old bridge.']; api.print(rumors[randInt(0,rumors.length-1)],'cyan'); return; }
      if (k==='d'){ if (p.daily.tavernDrinks<=0) return api.print('No more drinks today.','yellow'); p.daily.tavernDrinks--; const heal=randInt(2,6); p.hp=clamp(p.hp+heal,0,p.maxHp); api.print(`You feel warm. Recovered ${heal} HP.`,'green'); savePlayer(p); return render(p); }
      api.print('Type g (gossip), d (drink), or v.','dim'); }
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
        if (p.charm >= 10) return api.print('Turgon laughs: "Your swagger is already legendary."','yellow');
        if (p.gold < 60) return api.print('Swagger lessons require coin you do not possess.','yellow');
        p.gold -= 60; p.charm = clamp(p.charm + 1, 0, 10);
        api.print('You perfect a roguish grin. Charm +1.','green');
        savePlayer(p); return render(p);
      }
      api.print('Type s (sparring), e (endurance), w (swagger), or v to return.','dim');
    }
    function onNews(p,t){ if (t.toLowerCase()==='v'){ p.screen='town'; return render(p); } api.print('Type v to return.','dim'); }
    function onMail(p,t){ if (t.toLowerCase()==='v'){ p.screen='town'; return render(p); } api.print('Type v to return.','dim'); }
    function onConjugality(p,t){ if (t.toLowerCase()==='v'){ p.screen='town'; return render(p); } api.print('Type v to return.','dim'); }
    function onAnnounce(p,t){ if (t.toLowerCase()==='v'){ p.screen='town'; return render(p); } api.print('Type v to return.','dim'); }
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
        case 'inn':        return innMenu(p);
        case 'blacksmith': return smithMenu(p);
        case 'armorer':    return armorerMenu(p);
        case 'healer':     return healerMenu(p);
        case 'bank':       return bankMenu(p);
        case 'bank:dep':   return bankDepositPrompt(p);
        case 'bank:wit':   return bankWithdrawPrompt(p);
        case 'rankings':   return rankingsMenu();
        case 'tavern':     return tavernMenu(p);
        case 'status':     return statusMenu(p);
        case 'duel':       return duelsMenu(p);
        case 'duel:result':return duelResultMenu(p);
        case 'training':   return trainingMenu(p);
        case 'news':       return newsMenu(p);
        case 'mail':       return mailMenu(p);
        case 'conjugality':return conjugalityMenu(p);
        case 'announce':   return announceMenu(p);
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
        case 'combat':     onCombat(p, raw);     break;
        case 'inn':        onInn(p, raw);        break;
        case 'blacksmith': onSmith(p, raw);      break;
        case 'armorer':    onArmorer(p, raw);    break;
        case 'healer':     onHealer(p, raw);     break;
        case 'bank':       onBank(p, raw);       break;
        case 'bank:dep':
        case 'bank:wit':   onBankAmount(p, raw); break;
        case 'rankings':   onRankings(p, raw);   break;
        case 'tavern':     onTavern(p, raw);     break;
        case 'status':     onStatus(p, raw);     break;
        case 'duel':       onDuel(p, raw);       break;
        case 'duel:result':onDuelResult(p, raw); break;
        case 'training':   onTraining(p, raw);   break;
        case 'news':       onNews(p, raw);       break;
        case 'mail':       onMail(p, raw);       break;
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
