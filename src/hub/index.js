'use strict';

function createHub({ timeUtils, formatting }){
  const { dayHeadingFromEpoch, ymdFromEpoch } = timeUtils;
  const { escapeHTML } = formatting;

  const hub = {
    clients: new Set(),
    online: new Set(),
    socketsByUser: new Map(),
  };

  function sendOps(ws, ops){
    if (ws && ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ type: 'ops', ops }));
    }
  }

  function makeApi(ws){
    function _send(ops){ sendOps(ws, ops); }
    return {
      ws,
      clear(){ _send([{ op:'clear' }]); },
      print(t, cls){ _send([{ op:'print', text:String(t||''), cls:cls||'' }]); },
      printHTML(h, cls){
        const op = { op:'printHTML', html:String(h||'') };
        if (cls) op.cls = cls;
        _send([op]);
      },
      hr(){ _send([{ op:'hr' }]); },
      setInputType(type, placeholder){ _send([{ op:'setInput', inputType:type, placeholder }]); },
      setPrompt(prefix){ _send([{ op:'setPrompt', prefix:String(prefix||'DIS>') }]); },
      batch(fn){
        const ops = [];
        const api = {
          clear(){ ops.push({ op:'clear' }); },
          print(t, cls){ ops.push({ op:'print', text:String(t||''), cls:cls||'' }); },
          printHTML(h, cls){
            const op = { op:'printHTML', html:String(h||'') };
            if (cls) op.cls = cls;
            ops.push(op);
          },
          hr(){ ops.push({ op:'hr' }); },
          setInputType(type, placeholder){ ops.push({ op:'setInput', inputType:type, placeholder }); },
          setPrompt(prefix){ ops.push({ op:'setPrompt', prefix:String(prefix||'DIS>') }); },
        };
        fn(api);
        _send(ops);
      }
    };
  }

  function broadcastSystem(line){
    hub.clients.forEach(ws => sendOps(ws, [{ op:'print', text:line, cls:'dim' }]));
  }

  function broadcastChatFrom(htmlLine, fromUsername, createdAtSec){
    const from = (fromUsername || '').toLowerCase();
    hub.clients.forEach((client) => {
      const st = client.__ctx?.state;
      if (!st || st.currentScreen !== 'chat') return;

      const user = (st.username || '').toLowerCase();
      const isMine = from && user === from;
      const ops = [];

      if (createdAtSec && client.__ctx) {
        const msgYmd = ymdFromEpoch(createdAtSec);
        if (client.__ctx.lastChatDay !== msgYmd) {
          const label = dayHeadingFromEpoch(createdAtSec);
          ops.push({ op:'printHTML', html:`<span class="dim">── ${escapeHTML(label)} ──</span>` });
          client.__ctx.lastChatDay = msgYmd;
        }
      }

      ops.push({ op:'printHTML', html: htmlLine, cls: isMine ? 'me' : undefined });
      sendOps(client, ops);
    });
  }

  function broadcastAdminChatFrom(htmlLine, fromUsername, createdAtSec){
    const from = (fromUsername || '').toLowerCase();
    hub.clients.forEach((client) => {
      const st = client.__ctx?.state;
      if (!st || !st.isAdmin || st.currentScreen !== 'adminchat') return;

      const user = (st.username || '').toLowerCase();
      const isMine = from && user === from;
      const ops = [];

      if (createdAtSec && client.__ctx) {
        const msgYmd = ymdFromEpoch(createdAtSec);
        if (client.__ctx.lastAdminChatDay !== msgYmd) {
          const label = dayHeadingFromEpoch(createdAtSec);
          ops.push({ op:'printHTML', html:`<span class="dim">── ${escapeHTML(label)} ──</span>` });
          client.__ctx.lastAdminChatDay = msgYmd;
        }
      }

      ops.push({ op:'printHTML', html: htmlLine, cls: isMine ? 'me' : undefined });
      sendOps(client, ops);
    });
  }

  function usersCurrentlyInChat(){
    const arr = [];
    hub.clients.forEach(ws => {
      const st = ws.__ctx?.state;
      if (st && st.currentScreen === 'chat' && st.username) arr.push(st.username);
    });
    return arr.sort((a,b)=>a.localeCompare(b));
  }

  function usersCurrentlyInAdminChat(){
    const arr = [];
    hub.clients.forEach(ws => {
      const st = ws.__ctx?.state;
      if (st && st.currentScreen === 'adminchat' && st.username && st.isAdmin) arr.push(st.username);
    });
    return arr.sort((a,b)=>a.localeCompare(b));
  }

  return {
    hub,
    sendOps,
    makeApi,
    broadcastSystem,
    broadcastChatFrom,
    broadcastAdminChatFrom,
    usersCurrentlyInChat,
    usersCurrentlyInAdminChat,
  };
}

module.exports = {
  createHub,
};
