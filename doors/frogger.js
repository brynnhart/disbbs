module.exports = {
  id: 'frogger',
  name: 'River Runner',
  create(api, state, meta = {}) {
    const slug = meta.id || 'frogger';
    let open = false;

    function enter() {
      open = true;
      api.batch(b => {
        b.print('== River Runner ==', 'magenta');
        b.print('Hop your frog across traffic and the river to reach the safe homes.', 'cyan');
        b.print('Controls: Arrow keys or WASD to move. Enter submits score after game over. Esc or /leave exits.', 'dim');
        b.hr();
      });
      api.setPrompt && api.setPrompt('DIS>');
      api.setInputType && api.setInputType('text', 'Game running — use /leave to exit');
      api.openDoor && api.openDoor(slug, {
        title: meta.name || 'River Runner',
        width: 720,
        height: 640,
        hint: 'Arrow or WASD to move • Enter submits score • Esc or Close exits',
        doorOpts: {
          width: 660,
          height: 640,
        },
      });
    }

    function leave() {
      if (!open) return;
      open = false;
      api.closeDoor && api.closeDoor(slug);
      api.batch(b => {
        b.print('River Runner session ended. Returning to DIS…', 'dim');
      });
      api.setInputType && api.setInputType('text', 'type /help for commands');
    }

    function handleCommand(cmd) {
      if (cmd === 'help') {
        api.print('River Runner plays inside the overlay. Use /leave or the Close button to exit.', 'dim');
        return true;
      }
      api.print('River Runner is active in the overlay. Use the keyboard there. /leave exits.', 'yellow');
      return true;
    }

    function handleRaw() {
      api.print('This door uses an overlay window. Focus it for controls and /leave when finished.', 'yellow');
      return true;
    }

    function handleEvent(payload) {
      if (!payload || typeof payload !== 'object') return false;
      if (payload.type === 'score') {
        const score = Number(payload.value);
        const safeScore = Number.isFinite(score) ? Math.max(0, Math.round(score)) : 0;
        api.print(`River Runner score submitted: ${safeScore}`, 'green');
        return true;
      }
      if (payload.type === 'leave') {
        leave();
        return true;
      }
      return false;
    }

    return { enter, leave, handleCommand, handleRaw, handleEvent };
  },
};
