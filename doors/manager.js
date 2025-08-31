// doors/manager.js
// Tiny door registry + per-connection session router

const sessions = new WeakMap(); // ws -> { id, data }
const doors = new Map();        // id -> door module
let db = null;
let helpers = {};

/** call this once from server.js after DB exists */
function init(_db, _helpers={}) {
  db = _db;
  helpers = _helpers;
}

/** door: { id, name, newSession?, render?, onRaw?, onCommand?, commands? } */
function register(door) {
  if (!door?.id) throw new Error('Door must have an id');
  // Attach db + helpers so doors don’t import server.js
  Object.assign(door, { db, helpers });
  doors.set(door.id, door);
}

function list() {
  return Array.from(doors.values()).map(d => ({ id: d.id, name: d.name || d.id }));
}

function get(id) { return doors.get(id); }

/** Enter a door; door.render should draw the initial screen */
function enter(id, api, state, args=[]) {
  const door = doors.get(id);
  if (!door) { api.print('No such door', 'red'); return; }
  state.currentScreen = `door:${id}`;
  const sess = { id, data: (door.newSession ? door.newSession(state) : {}) };
  sessions.set(api.ws, sess);
  if (door.render) door.render(api, state, sess.data, args);
}

/** Dispatch raw text or slash commands to a door */
function dispatch(id, kind, datum, api, state, args) {
  const door = doors.get(id);
  if (!door) return false;
  const sess = sessions.get(api.ws) || { id, data: {} };
  if (kind === 'raw' && door.onRaw) return !!door.onRaw(datum, api, state, sess.data);
  if (kind === 'command' && door.onCommand) return !!door.onCommand(datum, api, state, args, sess.data);
  return false;
}

/** Optional: expose door-defined commands to the global router */
function getGlobalCommands() {
  const map = new Map();
  doors.forEach(d => {
    if (d.commands) {
      Object.entries(d.commands).forEach(([cmd, handler]) => {
        map.set(cmd, (api, state, args) => handler(api, state, args, sessions.get(api.ws)?.data));
      });
    }
  });
  return map;
}

module.exports = { init, register, list, get, enter, dispatch, getGlobalCommands };
