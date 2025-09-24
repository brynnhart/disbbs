// Canvas door implementing a Frogger-inspired game called River Runner
window.DDR_Doors = window.DDR_Doors || {};
window.DDR_Doors['frogger'] = function DoorFactory(ctx){
  const { mount, send, opts } = ctx || {};
  const canvas = document.createElement('canvas');
  const TILE = 48;
  const COLS = 13;
  const ROWS = 13;
  const WIDTH = TILE * COLS;
  const HEIGHT = TILE * ROWS;
  const displayW = Math.min(1024, Math.max(400, parseInt(opts?.width, 10) || WIDTH));
  const displayH = Math.min(900, Math.max(360, parseInt(opts?.height, 10) || HEIGHT));

  canvas.width = WIDTH;
  canvas.height = HEIGHT;
  canvas.style.width = displayW + 'px';
  canvas.style.height = displayH + 'px';
  canvas.style.maxWidth = '100%';
  canvas.style.background = '#081121';
  canvas.setAttribute('aria-label', 'River Runner — hop the frog to safety');
  canvas.setAttribute('role', 'img');
  canvas.tabIndex = 0;
  canvas.style.outline = 'none';

  mount.innerHTML = '';
  mount.appendChild(canvas);
  const g = canvas.getContext('2d');

  const homeCols = [1, 4, 6, 8, 11];
  const homes = homeCols.map(col => ({ x: col * TILE + TILE / 2, filled: false }));

  let active = true;
  let state = 'playing'; // 'playing' | 'gameover'
  let lives = 3;
  let score = 0;
  let level = 1;
  let homesFilled = 0;
  let lastTime = performance.now();
  let message = '';
  let messageTimer = 0;

  const frog = {
    x: 0,
    y: 0,
    size: TILE * 0.7,
  };

  let bestRow = ROWS - 1;

  function resetFrog(){
    frog.x = TILE * Math.floor(COLS / 2) + TILE / 2;
    frog.y = TILE * (ROWS - 1) + TILE / 2;
    bestRow = ROWS - 1;
  }

  resetFrog();

  function setMessage(text, duration){
    message = text || '';
    if (duration === Infinity) {
      messageTimer = Infinity;
    } else if (typeof duration === 'number') {
      messageTimer = Math.max(0, duration);
    } else {
      messageTimer = text ? 2 : 0;
    }
  }

  const laneDefs = [
    { row: 0, type: 'goal' },
    { row: 1, type: 'water', dir: 1, speed: 60, count: 3, length: 3 },
    { row: 2, type: 'water', dir: -1, speed: 80, count: 2, length: 4 },
    { row: 3, type: 'water', dir: 1, speed: 70, count: 3, length: 2.5 },
    { row: 4, type: 'water', dir: -1, speed: 90, count: 3, length: 3 },
    { row: 5, type: 'water', dir: 1, speed: 85, count: 2, length: 4 },
    { row: 6, type: 'safe' },
    { row: 7, type: 'road', dir: -1, speed: 140, count: 3, length: 1.6, color: '#F25F5C' },
    { row: 8, type: 'road', dir: 1, speed: 170, count: 3, length: 1.4, color: '#FFE066' },
    { row: 9, type: 'road', dir: -1, speed: 150, count: 2, length: 2.4, color: '#70C1B3' },
    { row: 10, type: 'road', dir: 1, speed: 190, count: 3, length: 1.2, color: '#C15EFF' },
    { row: 11, type: 'road', dir: -1, speed: 130, count: 3, length: 1.8, color: '#FF9F1C' },
    { row: 12, type: 'start' },
  ];

  function createLane(def){
    const lane = { ...def, y: def.row * TILE, objects: [] };
    if (def.type === 'road' || def.type === 'water') {
      const objectWidth = Math.max(TILE * 0.8, (def.length || 1) * TILE);
      const count = Math.max(1, def.count || 1);
      const spacing = (WIDTH + objectWidth) / count;
      for (let i = 0; i < count; i++) {
        const base = i * spacing;
        let x = def.dir > 0 ? base - objectWidth : WIDTH - base;
        if (def.dir < 0) x -= objectWidth;
        lane.objects.push({
          x,
          width: objectWidth,
          speed: Math.max(20, def.speed || 60),
          color: def.color,
        });
      }
    }
    return lane;
  }

  const lanes = laneDefs.map(createLane);

  function difficultyScale(){
    return 1 + (level - 1) * 0.12;
  }

  function clampFrog(){
    const min = TILE / 2;
    const maxX = WIDTH - TILE / 2;
    frog.x = Math.max(min, Math.min(maxX, frog.x));
  }

  function loseLife(reason){
    lives -= 1;
    setMessage(reason || 'You lost a life!', 1.6);
    if (lives <= 0) {
      lives = 0;
      gameOver();
    } else {
      resetFrog();
    }
  }

  function gameOver(){
    state = 'gameover';
    setMessage('Game over! Enter: submit score • R: restart • Esc: exit', Infinity);
  }

  function restart(){
    score = 0;
    lives = 3;
    level = 1;
    homesFilled = 0;
    homes.forEach(h => { h.filled = false; });
    state = 'playing';
    setMessage('New game! Hop to it.', 1.6);
    resetFrog();
  }

  function levelUp(){
    level += 1;
    homesFilled = 0;
    homes.forEach(h => { h.filled = false; });
    score += 200;
    setMessage(`Level ${level}! Everything speeds up.`, 2.4);
    resetFrog();
  }

  function handleHomeArrival(){
    const match = homes.find(h => Math.abs(h.x - frog.x) < TILE * 0.6);
    if (match && !match.filled) {
      match.filled = true;
      homesFilled += 1;
      score += 50;
      setMessage('Home safe!', 1.4);
      resetFrog();
      if (homesFilled === homes.length) {
        levelUp();
      }
      return;
    }
    if (match && match.filled) {
      setMessage('That lily pad is already claimed.', 1.4);
      resetFrog();
      return;
    }
    loseLife('Missed the lily pad!');
  }

  function move(dx, dy){
    if (state !== 'playing') return;
    const nextX = frog.x + dx * TILE;
    const nextY = frog.y + dy * TILE;
    if (nextX < TILE / 2 || nextX > WIDTH - TILE / 2) {
      return;
    }
    frog.x = nextX;
    frog.y = Math.max(TILE / 2, Math.min(HEIGHT - TILE / 2, nextY));
    const newRow = Math.floor(frog.y / TILE);
    if (newRow < bestRow) {
      score += 10;
      bestRow = newRow;
    }
  }

  function update(dt){
    const diff = difficultyScale();
    const frogRow = Math.floor(frog.y / TILE);

    for (const lane of lanes) {
      if (lane.type === 'road' || lane.type === 'water') {
        for (const obj of lane.objects) {
          const dir = lane.dir > 0 ? 1 : -1;
          const velocity = obj.speed * diff * dir;
          obj.x += velocity * dt;
          if (dir > 0 && obj.x > WIDTH + 20) {
            obj.x = -obj.width - TILE * (0.4 + Math.random() * 1.8);
          } else if (dir < 0 && obj.x + obj.width < -20) {
            obj.x = WIDTH + TILE * (0.4 + Math.random() * 1.8);
          }
        }
      }
    }

    const lane = lanes[frogRow];
    if (!lane) return;

    const frogHalf = frog.size / 2;

    if (lane.type === 'road') {
      const fLeft = frog.x - frogHalf;
      const fRight = frog.x + frogHalf;
      const fTop = frog.y - frogHalf;
      const fBottom = frog.y + frogHalf;
      for (const obj of lane.objects) {
        const oLeft = obj.x;
        const oRight = obj.x + obj.width;
        const oTop = lane.y;
        const oBottom = lane.y + TILE;
        if (fRight > oLeft && fLeft < oRight && fBottom > oTop + 6 && fTop < oBottom - 6) {
          loseLife('Splat! Traffic wins.');
          return;
        }
      }
    } else if (lane.type === 'water') {
      let onLog = false;
      const dir = lane.dir > 0 ? 1 : -1;
      for (const obj of lane.objects) {
        const oLeft = obj.x - 6;
        const oRight = obj.x + obj.width + 6;
        if (frog.x > oLeft && frog.x < oRight) {
          onLog = true;
          frog.x += obj.speed * dt * dir * diff;
          break;
        }
      }
      if (!onLog) {
        loseLife('Glub! You fell in the river.');
        return;
      }
      clampFrog();
      if (frog.x <= TILE / 2 + 1 || frog.x >= WIDTH - TILE / 2 - 1) {
        loseLife('Washed away!');
        return;
      }
    }

    if (frogRow === 0) {
      handleHomeArrival();
    }
  }

  function drawBackground(){
    for (const lane of lanes) {
      if (lane.type === 'goal') {
        g.fillStyle = '#0a3a19';
      } else if (lane.type === 'water') {
        g.fillStyle = '#0b2542';
      } else if (lane.type === 'road') {
        g.fillStyle = '#202326';
      } else {
        g.fillStyle = '#123015';
      }
      g.fillRect(0, lane.y, WIDTH, TILE);
      if (lane.type === 'road') {
        g.strokeStyle = 'rgba(255,255,255,0.1)';
        g.setLineDash([16, 16]);
        g.lineWidth = 2;
        g.beginPath();
        g.moveTo(0, lane.y + TILE / 2);
        g.lineTo(WIDTH, lane.y + TILE / 2);
        g.stroke();
        g.setLineDash([]);
      }
    }

    // draw homes on goal row
    for (const slot of homes) {
      g.fillStyle = slot.filled ? '#5CFF6C' : '#1b7030';
      const padWidth = TILE * 0.9;
      const padHeight = TILE * 0.8;
      g.fillRect(slot.x - padWidth / 2, TILE * 0.1, padWidth, padHeight);
      if (!slot.filled) {
        g.strokeStyle = '#3cf56d';
        g.lineWidth = 2;
        g.strokeRect(slot.x - padWidth / 2, TILE * 0.1, padWidth, padHeight);
      }
    }
  }

  function drawObjects(){
    for (const lane of lanes) {
      if (lane.type === 'water') {
        for (const obj of lane.objects) {
          g.fillStyle = '#8b572a';
          g.fillRect(obj.x, lane.y + TILE * 0.18, obj.width, TILE * 0.64);
          g.fillStyle = 'rgba(255,255,255,0.08)';
          g.fillRect(obj.x, lane.y + TILE * 0.18, obj.width, TILE * 0.2);
        }
      } else if (lane.type === 'road') {
        for (const obj of lane.objects) {
          g.fillStyle = obj.color || '#f45';
          g.fillRect(obj.x, lane.y + TILE * 0.2, obj.width, TILE * 0.6);
          g.fillStyle = 'rgba(0,0,0,0.3)';
          g.fillRect(obj.x + 4, lane.y + TILE * 0.7, obj.width - 8, TILE * 0.08);
          g.fillStyle = 'rgba(255,255,255,0.65)';
          g.fillRect(obj.x + obj.width * 0.1, lane.y + TILE * 0.3, obj.width * 0.3, TILE * 0.18);
        }
      }
    }
  }

  function drawFrog(){
    g.fillStyle = '#6dff5f';
    g.beginPath();
    g.arc(frog.x, frog.y, frog.size / 2, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#2d8f2a';
    g.beginPath();
    g.arc(frog.x, frog.y + 4, frog.size / 2.4, 0, Math.PI * 2);
    g.fill();
    // eyes
    g.fillStyle = '#fff';
    g.beginPath();
    g.arc(frog.x - frog.size * 0.2, frog.y - frog.size * 0.2, frog.size * 0.12, 0, Math.PI * 2);
    g.arc(frog.x + frog.size * 0.2, frog.y - frog.size * 0.2, frog.size * 0.12, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#000';
    g.beginPath();
    g.arc(frog.x - frog.size * 0.2, frog.y - frog.size * 0.2, frog.size * 0.06, 0, Math.PI * 2);
    g.arc(frog.x + frog.size * 0.2, frog.y - frog.size * 0.2, frog.size * 0.06, 0, Math.PI * 2);
    g.fill();
  }

  function drawHUD(){
    g.fillStyle = 'rgba(0,0,0,0.5)';
    g.fillRect(0, HEIGHT - TILE * 0.9, WIDTH, TILE * 0.9);
    g.fillStyle = '#ffffff';
    g.font = '16px "Fira Code", "Courier New", monospace';
    g.textBaseline = 'middle';
    g.fillText(`Score: ${score}`, 12, HEIGHT - TILE * 0.55);
    g.fillText(`Lives: ${lives}`, WIDTH / 2 - 40, HEIGHT - TILE * 0.55);
    g.fillText(`Level: ${level}`, WIDTH - 120, HEIGHT - TILE * 0.55);
    if (message && (messageTimer > 0 || messageTimer === Infinity)) {
      g.fillStyle = 'rgba(0,0,0,0.65)';
      g.fillRect(0, HEIGHT - TILE * 1.8, WIDTH, TILE * 0.8);
      g.fillStyle = '#f7f7f7';
      g.font = '18px "Fira Code", "Courier New", monospace';
      g.textAlign = 'center';
      g.fillText(message, WIDTH / 2, HEIGHT - TILE * 1.35);
      g.textAlign = 'start';
    }
    if (state === 'gameover') {
      g.fillStyle = 'rgba(0,0,0,0.6)';
      g.fillRect(0, HEIGHT * 0.25, WIDTH, HEIGHT * 0.5);
      g.fillStyle = '#ff5c5c';
      g.font = '32px "Fira Code", "Courier New", monospace';
      g.textAlign = 'center';
      g.fillText('GAME OVER', WIDTH / 2, HEIGHT * 0.42);
      g.fillStyle = '#ffffff';
      g.font = '18px "Fira Code", "Courier New", monospace';
      g.fillText('Enter: submit score', WIDTH / 2, HEIGHT * 0.52);
      g.fillText('R: restart • Esc: exit door', WIDTH / 2, HEIGHT * 0.58);
      g.textAlign = 'start';
    }
  }

  function draw(){
    g.clearRect(0, 0, WIDTH, HEIGHT);
    drawBackground();
    drawObjects();
    drawFrog();
    drawHUD();
  }

  function tick(now){
    if (!active) return;
    const dt = Math.min(0.1, (now - lastTime) / 1000);
    lastTime = now;
    if (state === 'playing') {
      update(dt);
    }
    if (messageTimer > 0 && messageTimer !== Infinity) {
      messageTimer = Math.max(0, messageTimer - dt);
      if (messageTimer === 0 && state !== 'gameover') {
        message = '';
      }
    }
    draw();
    requestAnimationFrame(tick);
  }

  function onKeyDown(e){
    if (!active) return;
    const key = e.key;
    if (['ArrowUp','ArrowDown','ArrowLeft','ArrowRight',' '].includes(key) || ['w','a','s','d','W','A','S','D'].includes(key)) {
      e.preventDefault();
    }
    if (key === 'Escape') {
      e.preventDefault();
      send && send({ type: 'leave' });
      return;
    }
    if (state === 'gameover') {
      if (key === 'Enter') {
        e.preventDefault();
        send && send({ type: 'score', value: score });
      } else if (key === 'r' || key === 'R') {
        e.preventDefault();
        restart();
      }
      return;
    }
    switch (key) {
      case 'ArrowUp':
      case 'w':
      case 'W':
        move(0, -1);
        break;
      case 'ArrowDown':
      case 's':
      case 'S':
        move(0, 1);
        break;
      case 'ArrowLeft':
      case 'a':
      case 'A':
        move(-1, 0);
        break;
      case 'ArrowRight':
      case 'd':
      case 'D':
        move(1, 0);
        break;
      case 'Enter':
        // ignore enter while playing but prevent accidental newline scrolling
        e.preventDefault();
        break;
      default:
        break;
    }
  }

  window.addEventListener('keydown', onKeyDown);
  requestAnimationFrame(tick);

  return {
    onEvent(ev){
      if (!ev) return;
      if (ev.type === 'focus') {
        canvas.focus && canvas.focus();
      }
    },
    destroy(){
      active = false;
      window.removeEventListener('keydown', onKeyDown);
    }
  };
};
