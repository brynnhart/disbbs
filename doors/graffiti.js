const { DoorManager } = require('./manager');
const { nowEpoch } = require('../src/utils/time');

const GRID_WIDTH = 16;
const GRID_HEIGHT = 12;
const DEFAULT_EMPTY_COLOR = '#111111';

const NAMED_COLORS = {
  red: '#E74C3C',
  orange: '#E67E22',
  yellow: '#F1C40F',
  green: '#2ECC71',
  lime: '#A3E635',
  teal: '#1ABC9C',
  blue: '#3498DB',
  navy: '#1F3A93',
  cyan: '#00FFFF',
  aqua: '#00FFFF',
  turquoise: '#40E0D0',
  purple: '#9B59B6',
  violet: '#8E44AD',
  magenta: '#FF00FF',
  fuchsia: '#FF00FF',
  pink: '#FF69B4',
  lavender: '#B57EDC',
  brown: '#8B4513',
  maroon: '#800000',
  gold: '#FFD700',
  silver: '#C0C0C0',
  gray: '#95A5A6',
  grey: '#95A5A6',
  charcoal: '#36454F',
  black: '#000000',
  white: '#FFFFFF',
};

const COLOR_NAME_LIST = Array.from(new Set(
  Object.keys(NAMED_COLORS)
    .filter(name => !['grey', 'aqua', 'fuchsia'].includes(name))
)).sort((a, b) => a.localeCompare(b));

function clamp(value, min, max) {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

function sanitizeStoredColor(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  const hex = raw.startsWith('#') ? raw.slice(1) : raw;
  if (/^[0-9a-fA-F]{6}$/.test(hex)) {
    return `#${hex.toUpperCase()}`;
  }
  return null;
}

function interpretColorInput(input) {
  const trimmed = String(input || '').trim();
  if (!trimmed) return null;
  const lower = trimmed.toLowerCase();

  if (['clear', 'erase', 'blank', 'none', 'empty'].includes(lower)) {
    return { color: null, label: 'Eraser (clears cells)' };
  }

  if (/^#?[0-9a-fA-F]{6}$/.test(trimmed)) {
    const hex = trimmed.replace('#', '').toUpperCase();
    return { color: `#${hex}`, label: `#${hex}` };
  }

  if (/^#?[0-9a-fA-F]{3}$/.test(trimmed)) {
    const expanded = trimmed.replace('#', '').split('').map(ch => ch + ch).join('').toUpperCase();
    return { color: `#${expanded}`, label: `#${expanded}` };
  }

  if (Object.prototype.hasOwnProperty.call(NAMED_COLORS, lower)) {
    const hex = NAMED_COLORS[lower];
    const pretty = lower.charAt(0).toUpperCase() + lower.slice(1);
    return { color: hex, label: `${pretty} (${hex})` };
  }

  return null;
}

function directionFromInput(original, lowered) {
  if (original === '\u001b[A' || lowered === '[a' || lowered === 'arrowup') return { dx: 0, dy: -1 };
  if (original === '\u001b[B' || lowered === '[b' || lowered === 'arrowdown') return { dx: 0, dy: 1 };
  if (original === '\u001b[C' || lowered === '[c' || lowered === 'arrowright') return { dx: 1, dy: 0 };
  if (original === '\u001b[D' || lowered === '[d' || lowered === 'arrowleft') return { dx: -1, dy: 0 };

  switch (lowered) {
    case 'up':
    case 'u':
    case 'k':
    case 'w':
      return { dx: 0, dy: -1 };
    case 'down':
    case 'd':
    case 'j':
    case 's':
      return { dx: 0, dy: 1 };
    case 'left':
    case 'l':
    case 'h':
    case 'a':
      return { dx: -1, dy: 0 };
    case 'right':
    case 'r':
    case 'e':
      return { dx: 1, dy: 0 };
    default:
      return null;
  }
}

function renderGridHTML(grid, cursorX, cursorY) {
  const cellSizeRem = 1.6;
  let html = `<div class="graffiti-grid" style="display:inline-grid;grid-template-columns:repeat(${GRID_WIDTH},${cellSizeRem}rem);gap:0.4rem;padding:0.6rem;border:1px solid #333;background:#050505;border-radius:6px;">`;
  for (let y = 0; y < GRID_HEIGHT; y += 1) {
    for (let x = 0; x < GRID_WIDTH; x += 1) {
      const color = grid[y][x] || DEFAULT_EMPTY_COLOR;
      const isCursor = x === cursorX && y === cursorY;
      const border = isCursor ? '2px solid #ffffff' : '1px solid rgba(255,255,255,0.18)';
      const shadow = isCursor ? 'box-shadow:0 0 8px rgba(255,255,255,0.6);' : '';
      const titleColor = grid[y][x] ? grid[y][x] : 'empty';
      const style = [
        `width:${cellSizeRem}rem`,
        `height:${cellSizeRem}rem`,
        'display:inline-block',
        'box-sizing:border-box',
        `border:${border}`,
        `background:${color}`,
        'border-radius:4px',
        'line-height:1.3rem',
        'text-align:center',
        shadow,
      ].join(';');
      html += `<span title="(${x + 1},${y + 1}) ${titleColor}" style="${style}">${isCursor ? '&#x25A3;' : '&nbsp;'}</span>`;
    }
  }
  html += '</div>';
  return html;
}

module.exports = {
  id: 'graffiti',
  name: 'Graffiti Wall',
  create(api, state, meta = {}) {
    const slug = meta.id || 'graffiti';
    const grid = Array.from({ length: GRID_HEIGHT }, () => Array(GRID_WIDTH).fill(null));
    const statements = api && api.__statements ? api.__statements : null;
    const hasDatabase = !!(statements && statements.selectGraffitiCells && statements.upsertGraffitiCell && statements.deleteGraffitiCell);

    let cursorX = 0;
    let cursorY = 0;
    let selectedColor = '#FFFFFF';
    let selectedLabel = '#FFFFFF';
    let statusLine = '';
    let statusClass = 'dim';

    function setStatus(text, cls = 'dim') {
      statusLine = text || '';
      statusClass = cls || 'dim';
    }

    function selectedPreviewHTML() {
      const swatchStyle = [
        'display:inline-block',
        'width:1.4rem',
        'height:1.4rem',
        'margin-right:0.5rem',
        'border-radius:4px',
        'border:1px solid rgba(255,255,255,0.4)',
        `background:${selectedColor || DEFAULT_EMPTY_COLOR}`,
      ].join(';');
      const label = selectedColor ? selectedLabel : 'Eraser (clears cells)';
      return `<span style="${swatchStyle}"></span>${label}`;
    }

    function loadGrid() {
      if (!hasDatabase) return;
      for (let y = 0; y < GRID_HEIGHT; y += 1) {
        grid[y].fill(null);
      }
      try {
        const rows = statements.selectGraffitiCells.all();
        rows.forEach(row => {
          const x = clamp(Number(row.x), 0, GRID_WIDTH - 1);
          const y = clamp(Number(row.y), 0, GRID_HEIGHT - 1);
          const color = sanitizeStoredColor(row.color);
          if (color) {
            grid[y][x] = color;
          } else {
            grid[y][x] = null;
          }
        });
      } catch (err) {
        setStatus(`Failed to load wall: ${err && err.message ? err.message : err}`, 'red');
      }
    }

    function describeCellColor(hex) {
      if (!hex) return 'cleared';
      const matchName = Object.entries(NAMED_COLORS).find(([name, value]) => value === hex && !['grey', 'aqua', 'fuchsia'].includes(name));
      if (matchName) {
        const pretty = matchName[0].charAt(0).toUpperCase() + matchName[0].slice(1);
        return `${pretty} (${hex})`;
      }
      return hex;
    }

    function render() {
      api.batch(b => {
        b.clear();
        b.print('== Graffiti Wall ==', 'magenta');
        b.print('Arrow keys / WASD / HJKL move. Type a color name or hex like #FF00FF and press Enter to select it. Press Space to paint. Type "clear" to switch to the eraser. Use /leave to exit.', 'cyan');
        if (!hasDatabase) {
          b.print('Database unavailable: wall is read-only.', 'red');
        }
        b.printHTML(`<div>Cursor: <strong>(${cursorX + 1}, ${cursorY + 1})</strong> | Selected: ${selectedPreviewHTML()}</div>`);
        if (statusLine) b.print(statusLine, statusClass);
        b.printHTML(renderGridHTML(grid, cursorX, cursorY));
        b.print(`Named colors: ${COLOR_NAME_LIST.join(', ')}`, 'dim');
      });
    }

    function moveCursor(dx, dy) {
      const nextX = clamp(cursorX + dx, 0, GRID_WIDTH - 1);
      const nextY = clamp(cursorY + dy, 0, GRID_HEIGHT - 1);
      if (nextX !== cursorX || nextY !== cursorY) {
        cursorX = nextX;
        cursorY = nextY;
        setStatus('', 'dim');
      }
      render();
    }

    function selectColor(input) {
      const interpreted = interpretColorInput(input);
      if (!interpreted) {
        setStatus(`Unknown color "${input}". Try a hex code like #FF6600 or one of: ${COLOR_NAME_LIST.slice(0, 12).join(', ')}…`, 'yellow');
        render();
        return true;
      }

      selectedColor = interpreted.color;
      selectedLabel = interpreted.label;
      if (selectedColor) {
        setStatus(`Selected ${interpreted.label}. Press Space to paint.`, 'green');
      } else {
        setStatus('Eraser selected. Press Space to clear a cell.', 'green');
      }
      render();
      return true;
    }

    function applyPaint() {
      if (!hasDatabase) {
        setStatus('Cannot paint right now — database unavailable.', 'red');
        render();
        return true;
      }
      const color = selectedColor;
      const x = cursorX;
      const y = cursorY;
      try {
        if (color) {
          statements.upsertGraffitiCell.run(x, y, color, nowEpoch(), state?.userId || null);
        } else {
          statements.deleteGraffitiCell.run(x, y);
        }
        grid[y][x] = color;
        const desc = describeCellColor(color);
        setStatus(color ? `Painted cell (${x + 1}, ${y + 1}) with ${desc}.` : `Cleared cell (${x + 1}, ${y + 1}).`, 'green');
        DoorManager.broadcastEvent(slug, { type: 'cellUpdate', cell: { x, y, color } }, { except: api.ws });
      } catch (err) {
        setStatus(`Failed to update cell: ${err && err.message ? err.message : err}`, 'red');
      }
      render();
      return true;
    }

    function handleCommand(cmd) {
      if (cmd === 'leave') return 'leave';
      if (cmd === 'help') {
        api.print('Graffiti Wall controls:', 'cyan');
        api.print('  • Arrow keys / WASD / HJKL move the cursor');
        api.print('  • Type a color name (red, blue, teal, …) or hex code (#FFAA33) and press Enter to select');
        api.print('  • Press Space to paint with the selected color; type "clear" to switch to the eraser');
        api.print('  • /leave exits the wall');
        return true;
      }
      api.print('Inside Graffiti Wall. Use /leave to exit or /help for tips.', 'yellow');
      return true;
    }

    function handleRaw(text) {
      const original = typeof text === 'string' ? text : String(text || '');
      if (!original) {
        setStatus('', 'dim');
        render();
        return true;
      }

      if (original === ' ') {
        return applyPaint();
      }

      const trimmed = original.trim();
      const lowered = trimmed.toLowerCase();

      if (!trimmed) {
        if (/\s/.test(original)) {
          return applyPaint();
        }
        setStatus('', 'dim');
        render();
        return true;
      }

      if (lowered === 'space' || lowered === 'paint') {
        return applyPaint();
      }

      const direction = directionFromInput(original, lowered);
      if (direction) {
        moveCursor(direction.dx, direction.dy);
        return true;
      }

      if (lowered === 'help' || lowered === '?') {
        setStatus('Arrows/WASD move • type color or hex to select • Space paints • clear = eraser', 'cyan');
        render();
        return true;
      }

      return selectColor(trimmed);
    }

    function handleEvent(payload) {
      if (!payload || typeof payload !== 'object') return false;
      if (payload.type === 'cellUpdate') {
        const cell = payload.cell || {};
        const x = clamp(Number(cell.x), 0, GRID_WIDTH - 1);
        const y = clamp(Number(cell.y), 0, GRID_HEIGHT - 1);
        const color = sanitizeStoredColor(cell.color);
        grid[y][x] = color;
        setStatus(`Cell (${x + 1}, ${y + 1}) ${color ? `updated to ${describeCellColor(color)}` : 'cleared'}.`, 'cyan');
        render();
        return true;
      }
      if (payload.type === 'refresh') {
        loadGrid();
        setStatus('Wall refreshed.', 'dim');
        render();
        return true;
      }
      return false;
    }

    function enter() {
      api.setPrompt && api.setPrompt('GRAFF>');
      api.setInputType && api.setInputType('text', 'Color name or #hex • arrows move • Space paints');
      setStatus('Welcome to the Graffiti Wall! Select a color and start painting.', 'green');
      loadGrid();
      render();
    }

    function leave() {
      api.setPrompt && api.setPrompt('DIS>');
      api.setInputType && api.setInputType('text', 'type /help for commands');
      api.print('Leaving Graffiti Wall. Returning to DIS…', 'dim');
    }

    return { enter, leave, handleCommand, handleRaw, handleEvent };
  },
};
