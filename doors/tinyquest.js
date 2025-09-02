// doors/tinyquest.js
module.exports = {
  id: 'tinyquest',
  name: 'TinyQuest',
  create(api, state, meta) {
    const PROMPT = 'TQ>';
    let room = 'start';
    let inventory = new Set();

    function enter() {
      // set the prompt immediately so the user sees where they are
      api.setPrompt && api.setPrompt(PROMPT);

      api.batch(b => {
        b.clear();
        b.print('== TinyQuest ==', 'magenta'); b.hr();
        b.print('Type words to interact. Use /leave to return to the BBS.', 'cyan');
      });
      render();
      api.setInputType && api.setInputType('text', 'try: take coin | go east');
    }

    function leave(){
        api.setPrompt && api.setPrompt('DIS>');
        api.setInputType && api.setInputType('text', 'type /help for commands'); // ← reset the hint
        api.batch(b=>{ b.print('Leaving TinyQuest. Returning to DIS…', 'dim'); });
    }


    function render() {
      if (room === 'start') {
        api.print('You are in a dim lobby with a locked door east. A coin glints on the floor.');
        api.print('Actions: take coin | go east | look | inventory', 'cyan');
      } else if (room === 'hall') {
        api.print('A narrow hall. A guard blocks the way north, asking for tribute.');
        api.print('Actions: give coin | go south | look | inventory', 'cyan');
      } else if (room === 'win') {
        api.print('The guard lets you pass. You see daylight. You Win!', 'green');
        api.print('Type /leave to return to DIS.', 'cyan');
      }
      api.hr();
    }

    function handleCommand(cmd, args) {
      if (cmd === 'help') {
        api.print('Local commands: /help, /leave. All other global commands are ignored here.', 'dim');
        return true;
      }
      // block other global slash commands while in the game
      api.print('Inside a game. Use /leave to exit to DIS.', 'yellow');
      return true;
    }

    function handleRaw(text) {
      const t = String(text || '').trim().toLowerCase();
      if (!t) return true;

      if (t === 'look') { render(); return true; }
      if (t === 'inventory' || t === 'inv') {
        api.print('Inventory: ' + (inventory.size ? [...inventory].join(', ') : '(empty)'), 'dim');
        return true;
      }

      if (room === 'start') {
        if (t === 'take coin' || t === 'pick up coin' || t === 'get coin') {
          if (!inventory.has('coin')) { inventory.add('coin'); api.print('You pocket the coin.', 'green'); }
          else { api.print('You already have the coin.', 'dim'); }
          return true;
        }
        if (t === 'go east' || t === 'east' || t === 'e') {
          if (!inventory.has('coin')) api.print('The door is locked. A slot suggests a coin might help…', 'yellow');
          else { api.print('You slip the coin into a slot and the door clicks open.', 'green'); room = 'hall'; render(); }
          return true;
        }
      } else if (room === 'hall') {
        if (t === 'go south' || t === 'south' || t === 's') { room = 'start'; render(); return true; }
        if (t === 'give coin' || t === 'pay coin') {
          if (inventory.has('coin')) { inventory.delete('coin'); api.print('The guard nods and steps aside.', 'green'); room = 'win'; render(); }
          else { api.print('You have nothing to offer.', 'yellow'); }
          return true;
        }
      }

      api.print('I don’t understand. Try: look, inventory, take coin, go east/south, give coin.', 'yellow');
      return true;
    }

    return { enter, leave, handleCommand, handleRaw };
  }
};
