// doors/guess/index.js
module.exports = {
  id: 'guess',
  name: 'Guess the Number',
  routes: ['guess'],

  render(api, state) {
    api.batch(b => {
      b.clear();
      b.print('== Guess the Number ==', 'magenta'); b.hr();
      b.print('I picked a number from 1 to 100.', 'cyan');
      b.print('Type a number guess. Use /leave to return to the hub.', 'dim'); b.hr();
    });
    api.setInputType('text', 'Enter a number');
  },

  onEnter(api, state) {
    state.doorState = state.doorState || {};
    if (typeof state.doorState.target !== 'number') {
      state.doorState.target = 1 + Math.floor(Math.random() * 100);
      state.doorState.tries = 0;
    }
  },

  handleRaw(text, api, state) {
    const n = parseInt(text, 10);
    if (Number.isNaN(n)) { api.print('Please enter a number 1–100.', 'yellow'); return true; }
    state.doorState.tries++;
    if (n < state.doorState.target) { api.print('Too low.', 'cyan'); return true; }
    if (n > state.doorState.target) { api.print('Too high.', 'cyan'); return true; }
    api.print(`Correct in ${state.doorState.tries} tries!`, 'green');
    api.print('New round started. /leave to exit.', 'dim');
    state.doorState.target = 1 + Math.floor(Math.random() * 100);
    state.doorState.tries = 0;
    return true;
  },

  handleCommand(cmd, api, state, args) {
    // No custom slash commands for this simple door
    return false;
  },

  onLeave(api, state) {
    // optional: clear scratch
    state.doorState = null;
  }
};
