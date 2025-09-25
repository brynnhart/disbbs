// doors/manager.js
// A tiny, tolerant, singleton Door Manager for DIS

(function(){
  const KEY = '__DIS_DOOR_MANAGER__';
  const G = (globalThis || global);

  if (G[KEY]) {
    // If already created (because server.js has multiple imports), export the same instance.
    module.exports = { DoorManager: G[KEY] };
    return;
  }

  // ────────────────────────────────────────────────────────────────────────────
  // Registry + sessions
  const registry = new Map();          // id -> { id, name, create(api,state,meta) }
  const sessions = new Map();          // ws -> { id, inst, api, state }

  function normId(x){ return String(x||'').trim().toLowerCase(); }

  function normalizeDoor(doorOrId, maybeFactory, maybeMeta){
    // 1) register('id', factoryFn, { name })
    if (typeof doorOrId === 'string' && typeof maybeFactory === 'function') {
      const id = normId(doorOrId);
      const name = (maybeMeta && (maybeMeta.name || maybeMeta.title)) || doorOrId;
      const meta = { id, name };
      const create = (api, state) => maybeFactory(api, state, meta);
      return { id, name, create };
    }

    // 2) register(objectDoor)
    //    Shapes:
    //      { id:'tinyquest', name:'TinyQuest', create(api,state,meta){...} }
    //      { meta:{ id:'tinyquest', name:'TinyQuest' }, create(...) {...} }
    //      or even a plain factory function (just in case)
    if (typeof doorOrId === 'function') {
      // Treat as factory but we need an id; last resort name from function
      const fn = doorOrId;
      const id = normId(maybeMeta?.id || fn.name || 'door');
      const name = maybeMeta?.name || id;
      const meta = { id, name };
      const create = (api, state) => fn(api, state, meta);
      return { id, name, create };
    }

    const d = doorOrId || {};
    const id = normId(d.id || d.meta?.id);
    const name = d.name || d.meta?.name || (id || 'door');
    const create = (typeof d.create === 'function')
      ? (api, state) => d.create(api, state, { id, name })
      : (() => { throw new Error('Door object missing create(api,state,meta)'); });

    if (!id) throw new Error('Door missing id');
    return { id, name, create };
  }

  function list(){
    // stable order
    return [...registry.values()].map(r => ({ id: r.id, name: r.name })).sort((a,b)=>a.id.localeCompare(b.id));
  }

  function register(doorOrId, maybeFactory, maybeMeta){
    const rec = normalizeDoor(doorOrId, maybeFactory, maybeMeta);
    registry.set(rec.id, rec);
    return rec.id;
  }

  function enter(id, api, state){
    const ws = api && api.ws;
    const key = normId(id);
    const rec = registry.get(key);
    if (!rec) throw new Error(`No such door: ${id}`);

    // create instance for this connection
    const inst = rec.create(api, state, { id: rec.id, name: rec.name });
    sessions.set(ws, { id: rec.id, inst, api, state });
    // allow the door to print its banner/prompt
    if (typeof inst.enter === 'function') inst.enter(api, state);
    return true;
  }

  function leave(api, state){
    const ws = api && api.ws;
    const sess = ws && sessions.get(ws);
    if (!sess) return false;
    try { sess.inst && typeof sess.inst.leave === 'function' && sess.inst.leave(api, state); }
    finally { sessions.delete(ws); }
    return true;
  }

  function broadcastEvent(id, payload, { except } = {}){
    const target = normId(id);
    if (!target) return 0;
    let delivered = 0;
    sessions.forEach((sess, ws) => {
      if (!sess || normId(sess.id) !== target) return;
      if (except && ws === except) return;
      const inst = sess.inst;
      if (inst && typeof inst.handleEvent === 'function') {
        try {
          inst.handleEvent(payload, sess.api, sess.state);
          delivered += 1;
        } catch (err) {
          try { console.error('Door broadcast failed:', err); } catch {}
        }
      }
    });
    return delivered;
  }

  function current(ws){
    const sess = sessions.get(ws);
    return sess ? sess.id : null;
  }

  // Two dispatch styles supported by your server:
  //  A) dispatch(id, 'raw'|'command', payload, api, state, args)
  //  B) handleRaw(text, api, state) / handleCommand(cmd, args, api, state)
  function dispatch(id, kind, payload, api, state, extra){
    const ws = api && api.ws;
    const sess = ws && sessions.get(ws);
    if (!sess || normId(id) !== normId(sess.id)) return false;

    if (kind === 'raw') {
      if (typeof sess.inst.handleRaw === 'function') return !!sess.inst.handleRaw(payload, api, state);
      return false;
    }
    if (kind === 'command') {
      const cmd = String(payload || '').toLowerCase();
      if (cmd === 'leave') { leave(api, state); return 'leave'; }
      if (typeof sess.inst.handleCommand === 'function') return !!sess.inst.handleCommand(cmd, extra, api, state);
      return false;
    }
    if (kind === 'event') {
      if (typeof sess.inst.handleEvent === 'function') return sess.inst.handleEvent(payload, api, state);
      return false;
    }
    return false;
  }

  function handleRaw(text, api, state){
    const ws = api && api.ws;
    const sess = ws && sessions.get(ws);
    if (!sess) return false;
    if (typeof sess.inst.handleRaw === 'function') return !!sess.inst.handleRaw(text, api, state);
    return false;
  }

  function handleCommand(cmd, args, api, state){
    const ws = api && api.ws;
    const sess = ws && sessions.get(ws);
    if (!sess) return false;
    if (String(cmd).toLowerCase() === 'leave') { leave(api, state); return 'leave'; }
    if (typeof sess.inst.handleCommand === 'function') return !!sess.inst.handleCommand(cmd, args, api, state);
    return false;
  }

  const manager = {
    // core
    register, list, enter, leave,
    // routing helpers used by your server
    dispatch, handleRaw, handleCommand, current,
    // broadcast helper
    broadcastEvent,
    // tiny debug
    _debug(){ return { registry: list() }; }
  };

  // Freeze + cache globally so all imports get the same instance.
  Object.freeze(manager);
  G[KEY] = manager;
  module.exports = { DoorManager: manager };
})();
