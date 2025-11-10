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
      setInputLimit(limit){
        let value = null;
        if (limit !== null && typeof limit !== 'undefined'){
          const num = Number(limit);
          if (Number.isFinite(num) && num >= 0) value = Math.floor(num);
        }
        _send([{ op:'setInputLimit', limit:value }]);
      },
      setPrompt(prefix){ _send([{ op:'setPrompt', prefix:String(prefix||'DIS>') }]); },
      openDoor(slug, options){
        const id = String(slug || '').trim();
        if (!id) return;
        const opts = options || {};
        const op = { op:'doorOpen', slug:id };
        if (opts.title) op.title = String(opts.title);
        if (opts.hint) op.hint = String(opts.hint);
        if (opts.mountId) op.mountId = String(opts.mountId);
        if (opts.width) {
          const w = parseInt(opts.width, 10);
          if (!Number.isNaN(w)) op.width = Math.max(240, Math.min(1920, w));
        }
        if (opts.height) {
          const h = parseInt(opts.height, 10);
          if (!Number.isNaN(h)) op.height = Math.max(180, Math.min(1080, h));
        }
        const doorOpts = { ...(opts.doorOpts || {}) };
        if (op.width && !('width' in doorOpts)) doorOpts.width = op.width;
        if (op.height && !('height' in doorOpts)) doorOpts.height = op.height;
        if (Object.keys(doorOpts).length) op.doorOpts = doorOpts;
        _send([op]);
      },
      closeDoor(slug){
        const id = String(slug || '').trim();
        if (!id) return;
        _send([{ op:'doorClose', slug:id }]);
      },
      sendDoorEvent(slug, payload){
        const id = String(slug || '').trim();
        if (!id) return;
        _send([{ op:'doorEvent', slug:id, payload }]);
      },
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
          setInputLimit(limit){
            let value = null;
            if (limit !== null && typeof limit !== 'undefined'){
              const num = Number(limit);
              if (Number.isFinite(num) && num >= 0) value = Math.floor(num);
            }
            ops.push({ op:'setInputLimit', limit:value });
          },
          setPrompt(prefix){ ops.push({ op:'setPrompt', prefix:String(prefix||'DIS>') }); },
          openDoor(slug, options){
            const id = String(slug || '').trim();
            if (!id) return;
            const opts = options || {};
            const op = { op:'doorOpen', slug:id };
            if (opts.title) op.title = String(opts.title);
            if (opts.hint) op.hint = String(opts.hint);
            if (opts.mountId) op.mountId = String(opts.mountId);
            if (opts.width) {
              const w = parseInt(opts.width, 10);
              if (!Number.isNaN(w)) op.width = Math.max(240, Math.min(1920, w));
            }
            if (opts.height) {
              const h = parseInt(opts.height, 10);
              if (!Number.isNaN(h)) op.height = Math.max(180, Math.min(1080, h));
            }
            const doorOpts = { ...(opts.doorOpts || {}) };
            if (op.width && !('width' in doorOpts)) doorOpts.width = op.width;
            if (op.height && !('height' in doorOpts)) doorOpts.height = op.height;
            if (Object.keys(doorOpts).length) op.doorOpts = doorOpts;
            ops.push(op);
          },
          closeDoor(slug){
            const id = String(slug || '').trim();
            if (!id) return;
            ops.push({ op:'doorClose', slug:id });
          },
          sendDoorEvent(slug, payload){
            const id = String(slug || '').trim();
            if (!id) return;
            ops.push({ op:'doorEvent', slug:id, payload });
          },
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
