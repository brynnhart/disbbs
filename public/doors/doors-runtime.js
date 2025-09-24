// Lightweight Door Dispatcher/Runtime (DDR)
(function(){
  const doors = new Map();    // slug -> { module, api, mount, cleanup }
  const loading = new Map();  // slug -> Promise

  function loadScriptOnce(src){
    if (!loading.has(src)){
      loading.set(src, new Promise((resolve, reject)=>{
        const s = document.createElement('script');
        s.src = src; s.async = true;
        s.onload = ()=>resolve(); s.onerror = reject;
        document.head.appendChild(s);
      }));
    }
    return loading.get(src);
  }

  // Expect each door to register itself as window.DDR_Doors[slug] = factory
  window.DDR_Doors = window.DDR_Doors || {};

  async function openDoor({ slug, mountId, opts, send }){
    const mount = document.getElementById(mountId);
    if (!mount) return;

    // Load the door bundle if needed
    if (!window.DDR_Doors[slug]){
      await loadScriptOnce(`/doors/${slug}/bundle.js`);
    }
    const factory = window.DDR_Doors[slug];
    if (typeof factory !== 'function') {
      const p = document.createElement('div');
      p.textContent = `Door "${slug}" failed to load.`;
      mount.appendChild(p);
      return;
    }

    // Boot the door
    const api = factory({ mount, send, opts });
    doors.set(slug, { api, mount, cleanup: api?.destroy || null });
  }

  function dispatchToDoor(slug, event){
    const entry = doors.get(slug);
    if (entry && entry.api && typeof entry.api.onEvent === 'function'){
      entry.api.onEvent(event);
    }
  }

  function closeDoor(slug){
    const entry = doors.get(slug);
    if (!entry) return;
    try { entry.cleanup && entry.cleanup(); } catch {}
    if (entry.mount) entry.mount.innerHTML = '';
    doors.delete(slug);
  }

  window.DDR = { openDoor, dispatchToDoor, closeDoor };
})();
