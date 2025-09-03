// doors/casino.js
// DIS Casino — door game: wallet, daily grant, Slots & Blackjack, leaderboard.
// Self-contained: opens the same SQLite DB and ensures casino tables exist.
// Prompt: CAS>   Escape back to BBS with /leave

const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = process.env.DB_PATH || path.resolve(__dirname, '..', 'dis.sqlite3');
const db = new Database(DB_PATH);

// Tables (idempotent). Safe even if you keep the schema in server.js.
db.exec(`
CREATE TABLE IF NOT EXISTS casino_wallets (
  user_id INTEGER PRIMARY KEY,
  balance INTEGER NOT NULL DEFAULT 0,
  last_daily_ymd TEXT
);
CREATE TABLE IF NOT EXISTS casino_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  change INTEGER NOT NULL,
  reason TEXT NOT NULL,
  meta TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_casino_ledger_user_created ON casino_ledger(user_id, created_at DESC);
`);

const getWallet    = db.prepare(`SELECT user_id, balance, last_daily_ymd FROM casino_wallets WHERE user_id=?`);
const upsertWallet = db.prepare(`
  INSERT INTO casino_wallets (user_id, balance, last_daily_ymd)
  VALUES (?, ?, ?)
  ON CONFLICT(user_id) DO UPDATE SET balance=excluded.balance, last_daily_ymd=excluded.last_daily_ymd
`);
const setWalletDaily = db.prepare(`UPDATE casino_wallets SET last_daily_ymd=? WHERE user_id=?`);
const setWalletBal   = db.prepare(`UPDATE casino_wallets SET balance=? WHERE user_id=?`);
const insertLedger   = db.prepare(`
  INSERT INTO casino_ledger (user_id, change, reason, meta, created_at)
  VALUES (?, ?, ?, ?, ?)
`);
const topBalances    = db.prepare(`
  SELECT u.username, COALESCE(w.balance,0) AS bal
  FROM users u
  LEFT JOIN casino_wallets w ON w.user_id = u.id
  ORDER BY bal DESC, u.username ASC
  LIMIT 10
`);

// ───────────────────────────────────────────────────────────────────
// Utils
const CHROME_DAILY = 100;
const CURRENCY = '¢';
const nowEpoch = () => Math.floor(Date.now()/1000);
const todayYMD = () => {
  const d = new Date(); const y = d.getFullYear();
  return `${y}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
};
function ensureWallet(userId){
  let w = getWallet.get(userId);
  if (!w){ upsertWallet.run(userId, 0, null); w = getWallet.get(userId); }
  return w;
}
function getBalance(userId){ return ensureWallet(userId).balance || 0; }
function changeBalance(userId, delta, reason, meta){
  const w = ensureWallet(userId);
  const newBal = (w.balance||0) + delta;
  setWalletBal.run(newBal, userId);
  insertLedger.run(userId, delta, String(reason||'misc'), meta ? JSON.stringify(meta) : null, nowEpoch());
  return newBal;
}
function grantDailyIfNeeded(userId){
  const ymd = todayYMD();
  const w = ensureWallet(userId);
  if (w.last_daily_ymd === ymd) return { granted:false, balance:w.balance };
  const newBal = (w.balance||0) + CHROME_DAILY;
  setWalletBal.run(newBal, userId);
  setWalletDaily.run(ymd, userId);
  insertLedger.run(userId, +CHROME_DAILY, 'daily', null, nowEpoch());
  return { granted:true, balance:newBal };
}
const fmtChrome = (n) => `${n}${CURRENCY}`;
const sleep = (ms) => new Promise(res=>setTimeout(res, ms));

// Formatting (reuse server UI semantics)
function escapeHTML(s){
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
function sanitize(text){ return escapeHTML(text||''); }

// ───────────────────────────────────────────────────────────────────
// Slots
const SLOT_REEL = [
  { sym:'☻', w:1,  type:'wild' },
  { sym:'★', w:2,  mult3:10 },
  { sym:'7', w:3,  mult3:6 },
  { sym:'♣', w:4,  mult3:4 },
  { sym:'♦', w:5,  mult3:3 },
  { sym:'♠', w:6,  mult3:2 },
  { sym:'♥', w:7,  mult3:2 },
  { sym:'♫', w:8,  mult3:2 },
  { sym:'🍒', w:9, type:'cherry' }
];
const SLOT_TOTAL_W = SLOT_REEL.reduce((a,r)=>a+r.w,0);
function pickSymbol(){
  let r = Math.random()*SLOT_TOTAL_W;
  for (const s of SLOT_REEL){ if ((r -= s.w) <= 0) return s; }
  return SLOT_REEL[SLOT_REEL.length-1];
}
function evalSlots(a,b,c, bet){
  const syms = [a,b,c];
  const wilds = syms.filter(s=>s.type==='wild').length;

  // 3 of a kind (wilds substitute)
  for (const cand of SLOT_REEL.filter(s=>s.mult3)){
    const count = syms.filter(s => s.sym===cand.sym || s.type==='wild').length;
    if (count === 3) return { kind:'3x', of:cand.sym, payout: bet * cand.mult3 };
  }
  // natural cherry pair
  const cherryCount = syms.filter(s=>s.type==='cherry').length;
  if (wilds===0 && cherryCount >= 2) return { kind:'2cherries', payout: bet * 2 };
  // triple wilds → top
  if (wilds === 3) return { kind:'3x', of:'★', payout: bet * 10 };
  return { kind:'lose', payout: 0 };
}

// ───────────────────────────────────────────────────────────────────
// Blackjack
const SUITS = ['♠','♥','♦','♣'];
const RANKS = ['A','2','3','4','5','6','7','8','9','10','J','Q','K'];
function newDeck(){
  const d=[]; for (const s of SUITS) for (const r of RANKS) d.push({r,s});
  // shuffle
  for (let i=d.length-1;i>0;i--){ const j=(Math.random()* (i+1))|0; [d[i],d[j]]=[d[j],d[i]]; }
  return d;
}
function valueCard(c){ if (c.r==='A') return 11; if (['K','Q','J'].includes(c.r)) return 10; return parseInt(c.r,10); }
function handValue(cards){
  let total = 0, aces = 0;
  for (const c of cards){ total += valueCard(c); if (c.r==='A') aces++; }
  while (total > 21 && aces>0){ total -= 10; aces--; }
  return total;
}
const isBlackjack = (cards) => cards.length===2 && handValue(cards)===21;
const showCard = (c) => `${c.r}${c.s}`;
function boxCards(cards){
  // simple inline box: [A♠][10♦]…
  return cards.map(c=>`[${showCard(c)}]`).join(' ');
}

// ───────────────────────────────────────────────────────────────────
// Door implementation
module.exports = {
  id: 'casino',
  name: 'DIS Casino',
  create(api, state, meta){
    const PROMPT = 'CAS>';
    let screen = 'menu'; // menu | slots:bet | blackjack:bet | blackjack:play
    let bj = null;       // blackjack session { bet, deck, phand, dhand, done, doubled }
    const userId = state.userId;

    function banner(){
      api.printHTML('<div class="banner"><div class="line"><span class="magenta">███</span><span class="cyan"> DIS CASINO </span><span class="magenta">███</span></div><div class="line dim">Welcome to the lounge — daily chrome, slots & blackjack.</div></div>');
    }
    function setPrompt(){ api.setPrompt && api.setPrompt(PROMPT); api.setInputType && api.setInputType('text', 'type: 1, 2, bet, etc. (/help)'); }

    function renderMenu(){
      api.batch(b=>{
        b.clear(); banner(); b.hr();
        const bal = getBalance(userId);
        b.print(`Your balance: ${fmtChrome(bal)}`, 'green'); b.hr();
        const leaders = topBalances.all();
        b.print('Leaderboard (top 10):', 'yellow');
        if (!leaders.length) b.print('No high rollers yet.', 'dim');
        leaders.forEach((r,i)=> b.print(`${String(i+1).padStart(2,' ')}. ${r.username} — ${fmtChrome(r.bal||0)}`));
        b.hr();
        b.print('Games:', 'yellow');
        b.print('  1) Slots          / type: slots or "1"', 'cyan');
        b.print('  2) Blackjack      / type: blackjack or "2"', 'cyan');
        b.hr();
        b.print('Commands: help, balance, leaderboard, rules.  /leave returns to BBS.', 'dim');
      });
      setPrompt();
      screen = 'menu';
    }

    function renderSlotsAsk(){
      api.batch(b=>{
        b.clear(); banner(); b.hr();
        b.print('== Slots ==', 'magenta');
        b.print('Enter your bet (positive integer). Example: 5', 'cyan');
        b.print('Payouts: ★×3=10×, 7×3=6×, ♣×3=4×, ♦×3=3×, ♠/♥/♫×3=2×, 🍒🍒 (natural pair)=2×. ☻ is wild for 3-of-a-kind.', 'dim');
      });
      api.setInputType && api.setInputType('text','Bet amount… or v to menu');
      screen = 'slots:bet';
    }

    async function doSlotsSpin(bet){
      if (!Number.isFinite(bet) || bet<=0){ api.print('Bet must be a positive integer.', 'red'); return; }
      const bal = getBalance(userId);
      if (bet > bal){ api.print(`Insufficient funds. You have ${fmtChrome(bal)}.`, 'red'); return; }
      changeBalance(userId, -bet, 'slots_bet', { bet });

      const s1 = pickSymbol(); const s2 = pickSymbol(); const s3 = pickSymbol();
      // little spin flash
      const squares = ' █  █  █';
      api.print(squares, 'dim'); await sleep(300);
      api.print(` ${s1.sym}  █  █`, 'cyan'); await sleep(320);
      api.print(` ${s1.sym}  ${s2.sym}  █`, 'cyan'); await sleep(350);
      api.print(` ${s1.sym}  ${s2.sym}  ${s3.sym}`, 'magenta');

      const out = evalSlots(s1,s2,s3, bet);
      if (out.payout>0){
        changeBalance(userId, out.payout, 'slots_win', { symbols:[s1.sym,s2.sym,s3.sym] });
        api.print(`WIN! Payout ${fmtChrome(out.payout)} → New balance: ${fmtChrome(getBalance(userId))}`, 'green');
      } else {
        api.print(`No win. Lost ${fmtChrome(bet)} → Balance: ${fmtChrome(getBalance(userId))}`, 'dim');
      }
      api.hr(); api.print('Again? Enter bet, or v to menu.', 'dim');
    }

    function renderBJAsk(){
      api.batch(b=>{
        b.clear(); banner(); b.hr();
        b.print('== Blackjack ==', 'magenta');
        b.print('Enter your bet. Example: 10', 'cyan');
        b.print('Rules: Dealer stands on 17. Blackjack pays 3:2. You may "double" (exactly one card) if you have funds.', 'dim');
      });
      api.setInputType && api.setInputType('text','Bet amount… or v to menu');
      screen = 'blackjack:bet';
    }

    function dealBJ(bet){
      const deck = newDeck();
      const phand = [ deck.pop(), deck.pop() ];
      const dhand = [ deck.pop(), deck.pop() ];
      bj = { bet, deck, phand, dhand, done:false, doubled:false };
      renderBJ();
    }

    function renderBJ(showAll=false){
      const pV = handValue(bj.phand);
      const dShown = showAll ? boxCards(bj.dhand) : `[${showCard(bj.dhand[0])}] [??]`;
      const dV = showAll ? handValue(bj.dhand) : '??';

      api.hr();
      api.print(`Dealer: ${dShown}  (${dV})`, showAll ? 'yellow' : 'cyan');
      api.print(`You   : ${boxCards(bj.phand)}  (${pV})`, 'cyan');
      api.hr();

      if (!bj.done){
        if (isBlackjack(bj.phand) && !isBlackjack(bj.dhand)){
          // Natural blackjack immediate
          const payout = Math.floor(bj.bet * 1.5);
          changeBalance(userId, bj.bet + payout, 'bj_blackjack', null);
          bj.done = true;
          api.print(`Blackjack! You win ${fmtChrome(payout)} (paid ${fmtChrome(bj.bet+payout)} back).`, 'green');
          api.print(`Balance: ${fmtChrome(getBalance(userId))}`, 'green'); api.hr();
          api.print('Play again? Enter a new bet, or v to menu.', 'dim');
          screen = 'blackjack:bet';
          return;
        }
        api.print('Actions: hit (h), stand (s), double (d)', 'dim');
        screen = 'blackjack:play';
        return;
      }

      // Hand resolved (showAll=true path)
      const pv = handValue(bj.phand);
      const dv = handValue(bj.dhand);
      if (pv > 21){ api.print('You bust. Dealer wins.', 'red'); }
      else if (dv > 21){ changeBalance(userId, bj.bet*2, 'bj_win_bust', null); api.print(`Dealer busts. You win ${fmtChrome(bj.bet)}.`, 'green'); }
      else if (pv > dv){ changeBalance(userId, bj.bet*2, 'bj_win', null); api.print(`You beat the dealer. Win ${fmtChrome(bj.bet)}.`, 'green'); }
      else if (pv < dv){ api.print('Dealer wins.', 'red'); }
      else { changeBalance(userId, bj.bet, 'bj_push', null); api.print('Push. Bet returned.', 'yellow'); }
      api.print(`Balance: ${fmtChrome(getBalance(userId))}`, 'green'); api.hr();
      api.print('Play again? Enter a new bet, or v to menu.', 'dim');
      screen = 'blackjack:bet';
    }

    function bjHit(){
      if (!bj || bj.done) return;
      bj.phand.push(bj.deck.pop());
      const v = handValue(bj.phand);
      if (v > 21){
        bj.done = true;
        api.print('You draw and bust!', 'red');
        renderBJ(true);
      } else {
        renderBJ(false);
      }
    }
    function bjStand(){
      if (!bj || bj.done) return;
      // Dealer draws to 17 (stand on all 17)
      while (handValue(bj.dhand) < 17){ bj.dhand.push(bj.deck.pop()); }
      bj.done = true;
      renderBJ(true);
    }
    function bjDouble(){
      if (!bj || bj.done) return;
      const bal = getBalance(userId);
      if (bal < bj.bet){ api.print('Not enough funds to double.', 'yellow'); return; }
      changeBalance(userId, -bj.bet, 'bj_double_bet', null);
      bj.bet *= 2; bj.doubled = true;
      bj.phand.push(bj.deck.pop()); // exactly one card
      const v = handValue(bj.phand);
      if (v > 21){ bj.done = true; api.print('You double and bust!', 'red'); renderBJ(true); }
      else { bjStand(); } // stand after double
    }

    // ───────────────────────────────────────────────────────────
    function enter(){
      api.batch(b=>{
        b.clear();
        b.printHTML('<div class="banner"><div class="line"><span class="cyan">▄▄▄</span><span class="magenta"> Welcome to the DIS Casino </span><span class="cyan">▄▄▄</span></div><div class="line dim">Pull up a chair. The house is (mostly) fair.</div></div>');
      });
      setPrompt();

      // Daily grant on entry
      const g = grantDailyIfNeeded(userId);
      if (g.granted) api.print(`Daily bonus credited: ${fmtChrome(CHROME_DAILY)}.`, 'green');
      api.print(`Balance: ${fmtChrome(getBalance(userId))}`, 'cyan');
      renderMenu();
    }

    function leave(){
      api.print('Leaving the casino… good luck out there.', 'dim');
      api.setPrompt && api.setPrompt('DIS>');
      api.setInputType && api.setInputType('text','type /help for commands');
    }

    function handleCommand(cmd, args){
      // Local slash help + /leave is handled by your hub already
      if (cmd === 'help'){
        api.hr();
        api.print('Casino door commands (while inside):', 'yellow');
        api.print('  help                 Show this help', 'cyan');
        api.print('  balance              Show your balance', 'cyan');
        api.print('  leaderboard         Top balances', 'cyan');
        api.print('  slots               Go to Slots', 'cyan');
        api.print('  blackjack           Go to Blackjack', 'cyan');
        api.print('  /leave              Return to the BBS', 'cyan');
        api.hr();
        return true;
      }
      // Everything else is raw-handled menus
      return false;
    }

    function handleRaw(text){
      const t = String(text||'').trim().toLowerCase();
      if (!t) return true;

      // quick nav from anywhere
      if (t === 'v' || t === 'menu'){ renderMenu(); return true; }

      if (screen === 'menu'){
        if (t === '1' || t.startsWith('slot')) { renderSlotsAsk(); return true; }
        if (t === '2' || t.startsWith('black')){ renderBJAsk(); return true; }
        if (t === 'balance' || t === 'bal'){ api.print(`Balance: ${fmtChrome(getBalance(userId))}`, 'cyan'); return true; }
        if (t === 'leaderboard' || t === 'leaders' || t === 'lb'){
          const leaders = topBalances.all();
          api.hr(); api.print('Leaderboard (top 10):', 'yellow');
          if (!leaders.length) api.print('No high rollers yet.', 'dim');
          leaders.forEach((r,i)=> api.print(`${String(i+1).padStart(2,' ')}. ${r.username} — ${fmtChrome(r.bal||0)}`));
          api.hr(); return true;
        }
        if (t === 'help' || t === '?'){
          api.hr(); api.print('Type "slots" or "blackjack", or 1/2. "balance" shows funds. "/leave" to exit.', 'dim'); return true;
        }
        api.print('Try: slots | blackjack | balance | leaderboard | /leave', 'dim');
        return true;
      }

      if (screen === 'slots:bet'){
        if (t === 'v'){ renderMenu(); return true; }
        const bet = parseInt(t, 10);
        if (!Number.isFinite(bet) || bet<=0){ api.print('Enter a positive integer bet, or v to menu.', 'yellow'); return true; }
        doSlotsSpin(bet).catch(()=> api.print('Slots hiccuped.', 'red'));
        return true;
      }

      if (screen === 'blackjack:bet'){
        if (t === 'v'){ renderMenu(); return true; }
        const bet = parseInt(t, 10);
        if (!Number.isFinite(bet) || bet<=0){ api.print('Enter a positive integer bet, or v to menu.', 'yellow'); return true; }
        if (getBalance(userId) < bet){ api.print('Insufficient funds.', 'red'); return true; }
        changeBalance(userId, -bet, 'bj_bet', null);
        dealBJ(bet);
        return true;
      }

      if (screen === 'blackjack:play'){
        if (t === 'h' || t.startsWith('hit')){ bjHit(); return true; }
        if (t === 's' || t.startsWith('stand')){ bjStand(); return true; }
        if (t === 'd' || t.startsWith('double')){ bjDouble(); return true; }
        if (t === 'v'){ renderMenu(); return true; }
        api.print('Actions: hit (h), stand (s), double (d). v to menu.', 'dim'); return true;
      }

      // fallback: send them home
      renderMenu();
      return true;
    }

    return { enter, leave, handleCommand, handleRaw };
  }
};
