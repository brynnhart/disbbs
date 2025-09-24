// Registers a simple canvas door named 'astroblaster'
window.DDR_Doors = window.DDR_Doors || {};
window.DDR_Doors['astroblaster'] = function DoorFactory(ctx){
  const { mount, send, opts } = ctx;
  const canvas = document.createElement('canvas');
  const desiredW = opts && opts.width ? Math.max(320, Math.min(1024, parseInt(opts.width, 10) || 720)) : 720;
  const desiredH = opts && opts.height ? Math.max(240, Math.min(720, parseInt(opts.height, 10) || 420)) : 420;
  canvas.width = desiredW;
  canvas.height = desiredH;
  canvas.style.width = desiredW + 'px';
  canvas.style.height = desiredH + 'px';
  const W = canvas.width, H = canvas.height;
  mount.appendChild(canvas);
  const g = canvas.getContext('2d');

  let t=0, running=true, score=0;
  const ship = { x: W/2, y: H*0.8, vx:0 };
  const keys = new Set();
  const ast = [];
  for (let i=0;i<20;i++) ast.push({ x: Math.random()*W, y: -Math.random()*H, v: 0.4+Math.random()*0.8 });

  function step(){
    if (!running) return;
    t+=1/60;
    // input
    ship.vx = (keys.has('ArrowRight')? 1:0) - (keys.has('ArrowLeft')?1:0);
    ship.x += ship.vx*4;
    ship.x = Math.max(10, Math.min(W-10, ship.x));

    // sim
    for (const a of ast){
      a.y += a.v;
      if (a.y > H+20){ a.y=-20; a.x=Math.random()*W; score+=10; }
      const dx=a.x-ship.x, dy=a.y-ship.y;
      if (dx*dx+dy*dy < 18*18){ running=false; gameOver(); return; }
    }

    // draw
    g.clearRect(0,0,W,H);
    g.fillStyle='#050505'; g.fillRect(0,0,W,H);
    // stars
    g.globalAlpha=0.7;
    for (let i=0;i<80;i++){
      const x=(i*97+t*30)%W; const y=(i*53+t*60)%H;
      g.fillStyle = i%7===0?'#19C3C3':'#999';
      g.fillRect(x, y, 2, 2);
    }
    g.globalAlpha=1;
    // ship
    g.fillStyle='#CC66FF';
    g.beginPath(); g.moveTo(ship.x, ship.y-10); g.lineTo(ship.x-10, ship.y+10); g.lineTo(ship.x+10, ship.y+10); g.closePath(); g.fill();
    // asteroids
    g.fillStyle='#E6E6E6';
    for (const a of ast){ g.beginPath(); g.arc(a.x,a.y,8,0,Math.PI*2); g.fill(); }
    // HUD
    g.fillStyle='#19C3C3'; g.font='14px ui-monospace, monospace';
    g.fillText('Score: '+score, 10, 20);

    requestAnimationFrame(step);
  }

  function gameOver(){
    g.fillStyle='rgba(0,0,0,0.5)'; g.fillRect(0,0,W,H);
    g.fillStyle='#FF4545'; g.font='24px ui-monospace, monospace';
    g.fillText('GAME OVER', W/2-80, H/2);
    g.fillStyle='#E6E6E6'; g.font='14px ui-monospace, monospace';
    g.fillText('Press Enter to submit score, or Esc to exit', W/2-180, H/2+24);
  }

  function onKey(e, down){
    if (e.repeat) return;
    if (down) keys.add(e.key); else keys.delete(e.key);
    if (!running){
      if (down && e.key === 'Enter'){ send({ type:'score', value: score }); }
      if (down && e.key === 'Escape'){ send({ type:'leave' }); }
    }
  }
  const keydown=(e)=>onKey(e,true), keyup=(e)=>onKey(e,false);
  window.addEventListener('keydown',keydown); window.addEventListener('keyup',keyup);

  step();

  return {
    onEvent(ev){
      // if the server ever wants to push events
    },
    destroy(){
      running=false;
      window.removeEventListener('keydown',keydown);
      window.removeEventListener('keyup',keyup);
    }
  };
};
