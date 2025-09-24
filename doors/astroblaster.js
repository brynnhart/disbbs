module.exports = {
  id: 'astroblaster',
  name: 'AstroBlaster',
  create(api, state, meta = {}) {
    const slug = meta.id || 'astroblaster';
    let open = false;

    function enter() {
      open = true;
      api.batch(b => {
        b.print('== AstroBlaster ==', 'magenta');
        b.print('Launching arcade action in an overlay. Use arrow keys to dodge incoming asteroids.', 'cyan');
        b.print('Press Enter inside the game to submit your score or use the Close button/ESC to leave.', 'dim');
        b.hr();
      });
      api.setPrompt && api.setPrompt('DIS>');
      api.setInputType && api.setInputType('text', 'Game running — use /leave to exit');
      api.openDoor && api.openDoor(slug, {
        title: meta.name || 'AstroBlaster',
        width: 760,
        height: 460,
        hint: 'Arrow keys to move • Enter submits score • Esc or Close exits',
        doorOpts: {
          width: 720,
          height: 420,
        },
      });
    }

    function leave() {
      if (!open) return;
      open = false;
      api.closeDoor && api.closeDoor(slug);
      api.batch(b => {
        b.print('AstroBlaster session ended. Returning to DIS…', 'dim');
      });
      api.setInputType && api.setInputType('text', 'type /help for commands');
    }

    function handleCommand(cmd) {
      if (cmd === 'help') {
        api.print('AstroBlaster uses keyboard controls directly. Use /leave or the Close button to exit.', 'dim');
        return true;
      }
      api.print('AstroBlaster is active. Keyboard controls happen in the overlay. Use /leave to exit.', 'yellow');
      return true;
    }

    function handleRaw() {
      api.print('This game is running in the overlay. Use the keyboard there and /leave when you are done.', 'yellow');
      return true;
    }

    function handleEvent(payload) {
      if (!payload || typeof payload !== 'object') return false;
      if (payload.type === 'score') {
        const score = Number(payload.value);
        const safeScore = Number.isFinite(score) ? Math.max(0, Math.round(score)) : 0;
        api.print(`AstroBlaster score submitted: ${safeScore}`, 'green');
        return true;
      }
      return false;
    }

    return { enter, leave, handleCommand, handleRaw, handleEvent };
  },
};
