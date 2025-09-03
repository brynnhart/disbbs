// doors/lord.js
// Legend of the Redux Dragon (LORD homage) — containerized door for DIS
// Emulates the original's feel: menus, turns, forest fights, shops, inn, healer, bank, tavern, rankings.
// Persistence: in-memory singleton (server lifetime). Swap STORE.* with DB calls if you add persistence.

module.exports = {
  id: 'lord',
  name: 'Legend of the Redux Dragon',
  create(api, state, meta) {
    // ─────────────────────────────────────────────────────────────
    // In-memory singleton store (server lifetime)
    const G = (globalThis || global);
    const KEY = '__REDUX_DRAGON_STORE__';
    if (!G[KEY]) {
      G[KEY] = {
        players: new Map(),        // username -> playerState
        rankings: new Map(),       // username -> { level, kills, deaths, gold, timestamp }
      };
    }
    const STORE = G[KEY];

    // ─────────────────────────────────────────────────────────────
    // Utilities
    const PROMPT = 'LORD>';
    const randInt = (a, b) => (a + Math.floor(Math.random() * (b - a + 1)));
    const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
    const nowEpoch = () => Math.floor(Date.now() / 1000);

    // Enemy table (scales with level)
    const ENEMIES = [
      'Rat', 'Mangy Wolf', 'Highway Thief', 'Goblin', 'Skeleton',
      'Bandit', 'Ogre', 'Wraith', 'Warlock', 'Black Knight'
    ];

    // Weapons & Armor tiers (rough homage-y balance)
    const WEAPONS = [
      { name: 'Dagger', atk: 3,  cost: 0   },
      { name: 'Shortsword', atk: 5,  cost: 75  },
      { name: 'Broadsword', atk: 7,  cost: 200 },
      { name: 'Battle Axe', atk: 10, cost: 600 },
      { name: 'Warhammer',  atk: 13, cost: 1500 },
      { name: 'Dragon Claw', atk: 17, cost: 3500 },
    ];
    const ARMOR = [
      { name: 'Cloth', def: 1,  cost: 0   },
      { name: 'Leather', def: 3,  cost: 80  },
      { name: 'Chain',   def: 5,  cost: 220 },
      { name: 'Plate',   def: 8,  cost: 700 },
      { name: 'Knight',  def: 11, cost: 1600 },
      { name: 'Dragon Scale', def: 15, cost: 3600 },
    ];

    // Experience curve (simple)
    const xpToNext = (level) => 20 + level * 15;

    // Load or create player
    const uname = (state.username || 'anon').toLowerCase().trim();
    const displayName = state.displayName || state.username || 'Adventurer';

    function defaultPlayer() {
      return {
        username: uname,
        name: displayName,
        createdAt: nowEpoch(),

        level: 1,
        xp: 0,
        hp: 30,
        maxHp: 30,

        gold: 50,
        bank: 0,

        weaponIdx: 0,   // WEAPONS[0] Dagger
        armorIdx: 0,    // ARMOR[0] Cloth

        charm: 0,
        kills: 0,
        deaths: 0,

        dayCount: 1,
        daily: {
          forestTurns: 10,
          tavernDrinks: 2,
          heals: 3,
          slept: false,
        },

        // ephemeral UI state
        screen: 'village',  // village, forest, combat, inn, blacksmith, armorer, healer, bank, tavern, rankings, status
        combat: null,       // { enemy, hp, maxHp, atk, def, fleeAttempts }
        temp: null          // scratch for subtasks (bank amounts etc.)
      };
    }

    function loadPlayer() {
      let p = STORE.players.get(uname);
      if (!p) {
        p = defaultPlayer();
        STORE.players.set(uname, p);
      }
      return p;
    }

    function savePlayer(p) {
      STORE.players.set(uname, p);
      STORE.rankings.set(uname, {
        level: p.level,
        kills: p.kills,
        deaths: p.deaths,
        gold: p.gold + p.bank,
        timestamp: nowEpoch(),
        name: p.name
      });
    }

    // ─────────────────────────────────────────────────────────────
    // Rendering helpers
    function setPromptLord() {
      api.setPrompt && api.setPrompt(PROMPT);
      api.setInputType && api.setInputType('text', 'type a menu letter/number (or /help, /leave)');
    }
    function setPromptDIS() {
      api.setPrompt && api.setPrompt('DIS>');
      api.setInputType && api.setInputType('text', 'type /help for commands');
    }
    function printHeader(title) {
      api.batch(b => { b.clear(); b.print(`== ${title} ==`, 'magenta'); b.hr(); });
    }
    function showStatus(p) {
      const w = WEAPONS[p.weaponIdx], a = ARMOR[p.armorIdx];
      api.print(`Name: ${p.name}   Level: ${p.level} (${p.xp}/${xpToNext(p.level)} xp)`, 'cyan');
      api.print(`HP: ${p.hp}/${p.maxHp}   ATK: ${w.atk} (${w.name})   DEF: ${a.def} (${a.name})`);
      api.print(`Gold: ${p.gold}  Bank: ${p.bank}  Kills: ${p.kills}  Deaths: ${p.deaths}`);
      api.print(`Turns: Forest ${p.daily.forestTurns}  Heals ${p.daily.heals}  Drinks ${p.daily.tavernDrinks}`, 'dim');
      api.hr();
    }
    function villageMenu(p) {
      printHeader('Village Square');
      showStatus(p);
      api.print('1) The Forest — seek monsters and fortune');
      api.print('2) The Dark Cloak Inn — rest for the day');
      api.print('3) The Blacksmith — buy better weapons');
      api.print('4) The Armorer — buy better armor');
      api.print('5) The Healer — recover hit points');
      api.print('6) The Bank — deposit or withdraw gold');
      api.print('7) Rankings — heroes of the realm');
      api.print('8) Your Status — recap your journey');
      api.print('9) The Tavern — gossip & rumors');
      api.print('Q) Quit to BBS (/leave)');
      api.hr();
      api.print('Choose a destination. Example: 1 or forest', 'dim');
    }

    function forestMenu(p) {
      printHeader('The Forest');
      showStatus(p);
      if (p.daily.forestTurns <= 0) {
        api.print('You are out of turns for today. Sleep at the Inn to recover.', 'yellow');
      } else {
        api.print('Hunt) Hunt for monsters');
        api.print('S) Search for gold');
      }
      api.print('V) Return to Village');
      api.hr();
      api.print('Type: hunt, search, or v.', 'dim');
    }

    function innMenu(p) {
      printHeader('The Dark Cloak Inn');
      showStatus(p);
      api.print('R) Rent a room and sleep (end your day, restore HP, refresh turns)');
      api.print('V) Return to Village');
      api.hr(); api.print('Type: r or v', 'dim');
    }

    function smithMenu(p) {
      printHeader('The Blacksmith');
      showStatus(p);
      WEAPONS.forEach((w, i) => {
        const owned = (i === p.weaponIdx) ? ' (owned)' : '';
        api.print(`${i + 1}) ${w.name}  ATK ${w.atk}  Cost ${w.cost}${owned}`);
      });
      api.print('V) Return to Village'); api.hr();
      api.print('Buy by number. Example: 3', 'dim');
    }

    function armorerMenu(p) {
      printHeader('The Armorer');
      showStatus(p);
      ARMOR.forEach((a, i) => {
        const owned = (i === p.armorIdx) ? ' (owned)' : '';
        api.print(`${i + 1}) ${a.name}  DEF ${a.def}  Cost ${a.cost}${owned}`);
      });
      api.print('V) Return to Village'); api.hr();
      api.print('Buy by number. Example: 2', 'dim');
    }

    function healerMenu(p) {
      printHeader('The Healer');
      showStatus(p);
      const missing = p.maxHp - p.hp;
      if (missing <= 0) {
        api.print('You are already in perfect health.'); api.hr();
        api.print('V) Return to Village', 'dim'); return;
      }
      const rate = 2; // 2 gold per HP
      const cost = missing * rate;
      api.print(`You are missing ${missing} HP. Healing costs ${rate} gold per HP (Total: ${cost}).`);
      api.print('H) Heal to full');
      api.print('V) Return to Village'); api.hr();
      api.print('Type: h or v', 'dim');
    }

    function bankMenu(p) {
      printHeader('The Bank of Redux');
      showStatus(p);
      api.print('D) Deposit gold');
      api.print('W) Withdraw gold');
      api.print('V) Return to Village');
      api.hr(); api.print('Type: d, w, or v', 'dim');
    }

    function bankDepositPrompt(p) {
      printHeader('Bank — Deposit');
      showStatus(p);
      api.print(`You carry ${p.gold} gold. How much to deposit?`, 'cyan'); api.hr();
      api.print('Type a number, or v to cancel.', 'dim');
      p.temp = { mode: 'deposit' };
    }

    function bankWithdrawPrompt(p) {
      printHeader('Bank — Withdraw');
      showStatus(p);
      api.print(`You have ${p.bank} gold in the bank. How much to withdraw?`, 'cyan'); api.hr();
      api.print('Type a number, or v to cancel.', 'dim');
      p.temp = { mode: 'withdraw' };
    }

    function rankingsMenu() {
      printHeader('Heroes of the Realm');
      const rows = [...STORE.rankings.entries()]
        .map(([u, r]) => ({ u, ...r }))
        .sort((a, b) => (b.level - a.level) || (b.kills - a.kills) || ((b.gold || 0) - (a.gold || 0)))
        .slice(0, 20);

      if (!rows.length) api.print('No heroes recorded yet.', 'dim');
      rows.forEach((r, i) => {
        api.print(`${i + 1}. ${r.name || r.u}  Lv${r.level}  K:${r.kills} D:${r.deaths}  Riches:${r.gold}`);
      });
      api.hr(); api.print('V) Return to Village', 'dim');
    }

    function tavernMenu(p) {
      printHeader('The Tavern');
      showStatus(p);
      api.print('G) Gossip — overhear a rumor');
      api.print('D) Drink — regain a few HP (limited per day)');
      api.print('V) Return to Village'); api.hr();
      api.print('Type: g, d, or v', 'dim');
    }

    function statusMenu(p) {
      printHeader('Your Status');
      showStatus(p);
      api.print('V) Return to Village'); api.hr();
      api.print('Type: v', 'dim');
    }

    function render(p) {
      setPromptLord();
      switch (p.screen) {
        case 'village':    return villageMenu(p);
        case 'forest':     return forestMenu(p);
        case 'inn':        return innMenu(p);
        case 'blacksmith': return smithMenu(p);
        case 'armorer':    return armorerMenu(p);
        case 'healer':     return healerMenu(p);
        case 'bank':       return bankMenu(p);
        case 'bank:dep':   return bankDepositPrompt(p);
        case 'bank:wit':   return bankWithdrawPrompt(p);
        case 'rankings':   return rankingsMenu(p);
        case 'tavern':     return tavernMenu(p);
        case 'status':     return statusMenu(p);
        case 'combat':     return renderCombat(p);
        default:
          p.screen = 'village'; return villageMenu(p);
      }
    }

    // ─────────────────────────────────────────────────────────────
    // Combat
    function genEnemy(p) {
      const idx = clamp(p.level - 1 + randInt(-1, 1), 0, ENEMIES.length - 1);
      const name = ENEMIES[idx];
      const base = Math.max(1, p.level + randInt(0, 2));
      return {
        name,
        hp: 10 + base * 5 + randInt(-3, 3),
        maxHp: 10 + base * 5,
        atk: Math.max(2, base * 2 + randInt(0, 2)),
        def: Math.max(1, base + randInt(0, 1)),
        fleeAttempts: 0
      };
    }

    function renderCombat(p) {
      const e = p.combat;
      if (!e) { p.screen = 'forest'; return render(p); }
      printHeader('Battle!');
      api.print(`${p.name} vs ${e.name}`);
      api.print(`Your HP: ${p.hp}/${p.maxHp}   Enemy HP: ${e.hp}/${e.maxHp}`, 'cyan');
      api.hr();
      api.print('A) Attack   F) Flee   I) Inspect', 'dim');
    }

    function doAttackRound(p, action) {
      const e = p.combat; if (!e) return;
      const w = WEAPONS[p.weaponIdx], a = ARMOR[p.armorIdx];

      // You attack
      let dmgToEnemy = Math.max(1, w.atk + randInt(0, 3) - e.def);
      e.hp = Math.max(0, e.hp - dmgToEnemy);
      api.print(`You strike the ${e.name} for ${dmgToEnemy}.`, 'green');

      if (e.hp <= 0) {
        const gold = randInt(10, 20) + p.level * randInt(5, 10);
        const xp   = randInt(8, 12) + p.level * randInt(2, 4);
        p.kills++; p.daily.forestTurns = Math.max(0, p.daily.forestTurns - 1);
        p.gold += gold; p.xp += xp;
        api.print(`Victory! You gain ${gold} gold and ${xp} xp.`, 'cyan');

        // Level up?
        if (p.xp >= xpToNext(p.level)) {
          p.xp -= xpToNext(p.level);
          p.level += 1;
          const hpGain = 5 + randInt(0, 5);
          p.maxHp += hpGain; p.hp = p.maxHp;
          api.print(`You reach Level ${p.level}! Max HP +${hpGain}.`, 'magenta');
        }

        p.combat = null;
        savePlayer(p);
        api.hr();
        p.screen = 'forest'; render(p);
        return;
      }

      // Enemy attacks
      let dmgToYou = Math.max(1, e.atk + randInt(0, 3) - ARMOR[p.armorIdx].def);
      p.hp = Math.max(0, p.hp - dmgToYou);
      api.print(`The ${e.name} hits you for ${dmgToYou}.`, 'yellow');

      if (p.hp <= 0) {
        api.print('You fall in battle…', 'red');
        p.deaths++;
        // Penalty
        const loss = Math.floor(p.gold * 0.25);
        p.gold -= loss;
        api.print(`You lose ${loss} gold. You are carried back to the Inn.`, 'yellow');
        p.hp = Math.ceil(p.maxHp / 2);
        p.daily.forestTurns = 0;
        p.combat = null;
        savePlayer(p);
        api.hr();
        p.screen = 'inn'; render(p);
        return;
      }

      // Ongoing
      renderCombat(p);
    }

    function doFlee(p) {
      const e = p.combat; if (!e) return;
      const chance = 50 - e.fleeAttempts * 10 +  (p.level * 3);
      const roll = randInt(1, 100);
      if (roll <= chance) {
        api.print('You escape into the trees!', 'green');
        p.daily.forestTurns = Math.max(0, p.daily.forestTurns - 1);
        p.combat = null; savePlayer(p);
        p.screen = 'forest'; render(p); return;
      } else {
        e.fleeAttempts++;
        api.print('You fail to flee!', 'yellow');
        // Enemy free hit
        let dmg = Math.max(1, e.atk + randInt(0, 2) - ARMOR[p.armorIdx].def);
        p.hp = Math.max(0, p.hp - dmg);
        api.print(`The ${e.name} punishes your back for ${dmg}.`, 'yellow');
        if (p.hp <= 0) {
          api.print('You fall while fleeing…', 'red');
          p.deaths++;
          const loss = Math.floor(p.gold * 0.25);
          p.gold -= loss; api.print(`You lose ${loss} gold.`, 'yellow');
          p.hp = Math.ceil(p.maxHp / 2);
          p.daily.forestTurns = 0; p.combat = null; savePlayer(p);
          p.screen = 'inn'; render(p); return;
        }
        renderCombat(p);
      }
    }

    // ─────────────────────────────────────────────────────────────
    // Input routing
    function onVillage(p, t) {
      const k = t.toLowerCase();
      if (k === '1' || k.startsWith('forest')) { p.screen = 'forest'; return render(p); }
      if (k === '2' || k.includes('inn'))     { p.screen = 'inn'; return render(p); }
      if (k === '3' || k.startsWith('black')) { p.screen = 'blacksmith'; return render(p); }
      if (k === '4' || k.startsWith('armor')) { p.screen = 'armorer'; return render(p); }
      if (k === '5' || k.startsWith('heal'))  { p.screen = 'healer'; return render(p); }
      if (k === '6' || k.startsWith('bank'))  { p.screen = 'bank'; return render(p); }
      if (k === '7' || k.startsWith('rank'))  { p.screen = 'rankings'; return render(p); }
      if (k === '8' || k.startsWith('status')){ p.screen = 'status'; return render(p); }
      if (k === '9' || k.startsWith('tav'))   { p.screen = 'tavern'; return render(p); }
      if (k === 'q' || k === 'quit')          { api.print('Use /leave to return to DIS.', 'yellow'); return; }
      api.print('Try a number 1-9, or name a location (forest, inn, bank…).', 'dim');
    }

    function onForest(p, t) {
      const k = t.toLowerCase();
      if (k === 'v') { p.screen = 'village'; return render(p); }
      if (p.daily.forestTurns <= 0) { api.print('No turns left today. Sleep at the Inn.', 'yellow'); return; }

      if (k.startsWith('hunt') || k === 'h') {
        p.combat = genEnemy(p);
        p.screen = 'combat'; return render(p);
      }
      if (k.startsWith('search') || k === 's') {
        const gold = randInt(2, 15) + randInt(0, p.level);
        p.daily.forestTurns--; p.gold += gold;
        api.print(`You find a pouch with ${gold} gold.`, 'green');
        savePlayer(p);
        return render(p);
      }
      api.print('Type hunt, search, or v.', 'dim');
    }

    function onCombat(p, t) {
      const k = t.toLowerCase();
      if (k === 'a' || k.startsWith('att')) return doAttackRound(p, 'attack');
      if (k === 'f' || k.startsWith('fl') || k.startsWith('fle')) return doFlee(p);
      if (k === 'i') { renderCombat(p); return; }
      api.print('Options: A)ttack, F)lee, I)nspect', 'dim');
    }

    function onInn(p, t) {
      const k = t.toLowerCase();
      if (k === 'v') { p.screen = 'village'; return render(p); }
      if (k === 'r') {
        // End day
        p.dayCount++; p.hp = p.maxHp;
        p.daily = { forestTurns: 10, tavernDrinks: 2, heals: 3, slept: true };
        api.print('You sleep soundly. A new day dawns.', 'green');
        savePlayer(p);
        p.screen = 'village'; return render(p);
      }
      api.print('Type r to sleep, or v to return.', 'dim');
    }

    function onSmith(p, t) {
      const k = t.toLowerCase();
      if (k === 'v') { p.screen = 'village'; return render(p); }
      const idx = parseInt(k, 10);
      if (!Number.isNaN(idx) && idx >= 1 && idx <= WEAPONS.length) {
        const i = idx - 1;
        const w = WEAPONS[i];
        if (i === p.weaponIdx) { api.print('You already own that weapon.', 'dim'); return; }
        if (p.gold < w.cost) { api.print('You lack the gold.', 'yellow'); return; }
        const better = w.atk > WEAPONS[p.weaponIdx].atk;
        if (!better) { api.print('That would not improve your attack.', 'yellow'); return; }
        p.gold -= w.cost;
        p.weaponIdx = i;
        api.print(`You purchase the ${w.name}.`, 'green'); savePlayer(p); return render(p);
      }
      api.print('Choose a number or V to return.', 'dim');
    }

    function onArmorer(p, t) {
      const k = t.toLowerCase();
      if (k === 'v') { p.screen = 'village'; return render(p); }
      const idx = parseInt(k, 10);
      if (!Number.isNaN(idx) && idx >= 1 && idx <= ARMOR.length) {
        const i = idx - 1;
        const a = ARMOR[i];
        if (i === p.armorIdx) { api.print('You already own that armor.', 'dim'); return; }
        if (p.gold < a.cost) { api.print('You lack the gold.', 'yellow'); return; }
        const better = a.def > ARMOR[p.armorIdx].def;
        if (!better) { api.print('That would not improve your defense.', 'yellow'); return; }
        p.gold -= a.cost;
        p.armorIdx = i;
        api.print(`You purchase the ${a.name}.`, 'green'); savePlayer(p); return render(p);
      }
      api.print('Choose a number or V to return.', 'dim');
    }

    function onHealer(p, t) {
      const k = t.toLowerCase();
      if (k === 'v') { p.screen = 'village'; return render(p); }
      if (k === 'h') {
        const missing = p.maxHp - p.hp;
        if (missing <= 0) { api.print('You are already healthy.'); return; }
        const rate = 2, cost = missing * rate;
        if (p.gold < cost) { api.print('You lack the gold.', 'yellow'); return; }
        p.gold -= cost; p.hp = p.maxHp;
        api.print('You are fully healed.', 'green'); savePlayer(p); return render(p);
      }
      api.print('Type h to heal (cost), or v to return.', 'dim');
    }

    function onBank(p, t) {
      const k = t.toLowerCase();
      if (k === 'v') { p.screen = 'village'; return render(p); }
      if (k === 'd') { p.screen = 'bank:dep'; return render(p); }
      if (k === 'w') { p.screen = 'bank:wit'; return render(p); }
      api.print('Type d, w, or v.', 'dim');
    }

    function onBankAmount(p, t) {
      const k = t.toLowerCase();
      if (k === 'v') { p.temp = null; p.screen = 'bank'; return render(p); }
      const amt = Math.max(0, Math.floor(parseInt(k, 10)));
      if (!amt && amt !== 0) { api.print('Enter a number, or v to cancel.', 'dim'); return; }
      if (!p.temp) { p.screen = 'bank'; return render(p); }
      if (p.temp.mode === 'deposit') {
        if (amt > p.gold) { api.print('You do not have that much.', 'yellow'); return; }
        p.gold -= amt; p.bank += amt;
        api.print(`Deposited ${amt} gold.`, 'green'); p.temp = null; savePlayer(p); p.screen = 'bank'; return render(p);
      } else if (p.temp.mode === 'withdraw') {
        if (amt > p.bank) { api.print('You do not have that much in the bank.', 'yellow'); return; }
        p.bank -= amt; p.gold += amt;
        api.print(`Withdrew ${amt} gold.`, 'green'); p.temp = null; savePlayer(p); p.screen = 'bank'; return render(p);
      }
      p.temp = null; p.screen = 'bank'; return render(p);
    }

    function onRankings(p, t) {
      const k = t.toLowerCase();
      if (k === 'v') { p.screen = 'village'; return render(p); }
      api.print('Type v to return.', 'dim');
    }

    function onTavern(p, t) {
      const k = t.toLowerCase();
      if (k === 'v') { p.screen = 'village'; return render(p); }
      if (k === 'g') {
        const rumors = [
          'They say a dragon’s hoard lies deep in the forest…',
          'The Blacksmith sharpens for free if you’re charming — or so they say.',
          'A hidden grove yields gold to those who listen to the wind.',
          'Beware the Black Knight past the old bridge.',
        ];
        api.print(rumors[randInt(0, rumors.length - 1)], 'cyan'); return;
      }
      if (k === 'd') {
        if (p.daily.tavernDrinks <= 0) { api.print('No more drinks today.', 'yellow'); return; }
        p.daily.tavernDrinks--;
        const heal = randInt(2, 6);
        p.hp = clamp(p.hp + heal, 0, p.maxHp);
        api.print(`You feel warm. Recovered ${heal} HP.`, 'green'); savePlayer(p); return render(p);
      }
      api.print('Type g (gossip), d (drink), or v.', 'dim');
    }

    function onStatus(p, t) {
      if (t.toLowerCase() === 'v') { p.screen = 'village'; return render(p); }
      api.print('Type v to return.', 'dim');
    }

    // ─────────────────────────────────────────────────────────────
    // Lifecycle
    function enter() {
      const p = loadPlayer();
      setPromptLord();
      api.batch(b => {
        b.clear();
        b.print('== Legend of the Redux Dragon ==', 'magenta'); b.hr();
        b.print(`Welcome, ${p.name}. Today is Day ${p.dayCount}.`);
        b.print('Only /leave exits to the BBS. /help for in-game help.', 'dim');
      });
      savePlayer(p);
      render(p);
    }

    function leave() {
      const p = loadPlayer();
      savePlayer(p);
      api.print('You leave the realm and return to the BBS…', 'dim');
      setPromptDIS();
    }

    function handleCommand(cmd, args) {
      const p = loadPlayer();
      if (cmd === 'help') {
        api.hr();
        api.print('Inside LORD, only these slash commands work:', 'cyan');
        api.print('/help — show this help');
        api.print('/leave — return to DIS');
        api.hr();
        api.print('Otherwise, type menu letters/words (e.g., forest, bank, r, v, 1).', 'dim');
        return true;
      }
      // Any other global command is blocked in the door; your WS layer enforces this too.
      api.print('You are inside a game. Use /leave to return to the BBS.', 'yellow');
      return true;
    }

    function handleRaw(text) {
      const p = loadPlayer();
      const t = String(text || '').trim();
      if (!t) return true;

      switch (p.screen) {
        case 'village':    onVillage(p, t); break;
        case 'forest':     onForest(p, t); break;
        case 'combat':     onCombat(p, t); break;
        case 'inn':        onInn(p, t); break;
        case 'blacksmith': onSmith(p, t); break;
        case 'armorer':    onArmorer(p, t); break;
        case 'healer':     onHealer(p, t); break;
        case 'bank':       onBank(p, t); break;
        case 'bank:dep':
        case 'bank:wit':   onBankAmount(p, t); break;
        case 'rankings':   onRankings(p, t); break;
        case 'tavern':     onTavern(p, t); break;
        case 'status':     onStatus(p, t); break;
        default:
          p.screen = 'village'; render(p);
      }
      return true;
    }

    return { enter, leave, handleCommand, handleRaw };
  }
};
