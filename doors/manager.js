// doors/manager.js
const DOORS = new Map();

const DoorManager = {
  register(door) {
    if (!door || !door.id) throw new Error('Door must have an id');
    DOORS.set(door.id, door);
    if (door.routes && Array.isArray(door.routes)) {
      door.routes.forEach(alias => DOORS.set(alias, door));
    }
  },
  get(id) { return DOORS.get(id); },
  all() {
    // unique by canonical id
    const seen = new Set();
    const list = [];
    for (const [k, v] of DOORS.entries()) {
      if (!seen.has(v.id)) { list.push(v); seen.add(v.id); }
    }
    return list;
  },
  enter(api, state, id) {
    const door = DOORS.get(id);
    if (!door) { api.print('No such door.', 'red'); return; }
    state.currentScreen = `door:${door.id}`;
    if (api && api.ws) api.ws.__ctx = { state };
    if (door.onEnter) door.onEnter(api, state);
    door.render(api, state);
  },
  leave(api, state) {
    const id = (state.currentScreen || '').split(':')[1];
    const door = DOORS.get(id);
    if (door && door.onLeave) door.onLeave(api, state);
    state.currentScreen = 'menu';
    if (api && api.ws) api.ws.__ctx = { state };
  }
};

module.exports = { DoorManager };
