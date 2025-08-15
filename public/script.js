const timeRangeSelect = document.getElementById('timeRange');
const refreshButton = document.getElementById('refresh');

const datasetsConfig = (label, color) => ({
  label,
  data: [],
  borderColor: color,
  backgroundColor: color + '33',
  fill: true,
  tension: 0.35,
  pointRadius: 0,
});

const cpuSparkCtx = document.getElementById('cpuSpark').getContext('2d');
const memorySparkCtx = document.getElementById('memorySpark').getContext('2d');
const diskSparkCtx = document.getElementById('diskSpark').getContext('2d');

const xAxisConfig = {
  type: 'time',
  time: { unit: 'minute' },
  ticks: { color: '#94a3b8' },
  grid: { color: 'rgba(148,163,184,0.1)' },
};

function createChart(ctx, label, color) {
  return new Chart(ctx, {
    type: 'line',
    data: { datasets: [datasetsConfig(label, color)] },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: { mode: 'index', intersect: false },
      },
      interaction: { mode: 'index', intersect: false },
      scales: {
        x: { display: false, type: 'time', time: { unit: 'minute' } },
        y: {
          min: 0,
          max: 100,
          display: false,
        },
      },
    },
  });
}

const cpuChart = createChart(cpuSparkCtx, 'CPU', '#f59e0b');
const memoryChart = createChart(memorySparkCtx, 'Memory', '#22c55e');
const diskChart = createChart(diskSparkCtx, 'Disk', '#60a5fa');

async function fetchMetrics(range) {
  const res = await fetch(`/api/metrics?range=${encodeURIComponent(range)}`);
  return res.json();
}

function updateChart(chart, points) {
  chart.data.labels = points.map((p) => new Date(p.x));
  chart.data.datasets[0].data = points.map((p) => p.y);
  chart.update('none');
}

function toPercent(value) {
  return Math.round(value * 1000) / 10; // 0-100 with 0.1 precision
}

function transformData(samples) {
  return {
    cpu: samples.map((s) => ({ x: s.timestamp, y: toPercent(s.cpu.average) })),
    memory: samples.map((s) => ({ x: s.timestamp, y: toPercent(s.memory.usage) })),
    disk: samples.map((s) => ({ x: s.timestamp, y: toPercent(s.disk.usage) })),
  };
}

async function load(range) {
  const { data } = await fetchMetrics(range);
  const t = transformData(data);
  updateChart(cpuChart, t.cpu);
  updateChart(memoryChart, t.memory);
  updateChart(diskChart, t.disk);
  // Update values in tiles
  const last = data[data.length - 1];
  if (last) {
    document.getElementById('cpuValue').textContent = toPercent(last.cpu.average) + '%';
    document.getElementById('memoryValue').textContent = toPercent(last.memory.usage) + '%';
    document.getElementById('diskValue').textContent = toPercent(last.disk.usage) + '%';
  }
}

if (timeRangeSelect) timeRangeSelect.addEventListener('change', () => load(timeRangeSelect.value));
if (refreshButton) refreshButton.addEventListener('click', () => load(timeRangeSelect ? timeRangeSelect.value : '1h'));

// Initial load and periodic refresh for "latest"
load(timeRangeSelect ? timeRangeSelect.value : '1h');
setInterval(async () => {
  try {
    const res = await fetch('/api/metrics/latest');
    const sample = await res.json();
    // push into charts maintaining order
    function append(chart, value) {
      chart.data.labels.push(new Date(sample.timestamp));
      chart.data.datasets[0].data.push(toPercent(value));
      // keep labels/data within 24h window; Chart.js is lenient, we trim by count
      const maxPoints = 24 * 60 + 5;
      if (chart.data.labels.length > maxPoints) {
        chart.data.labels.shift();
        chart.data.datasets[0].data.shift();
      }
      chart.update('none');
    }
    append(cpuChart, sample.cpu.average);
    append(memoryChart, sample.memory.usage);
    append(diskChart, sample.disk.usage);
    // Update tile values live
    document.getElementById('cpuValue').textContent = toPercent(sample.cpu.average) + '%';
    document.getElementById('memoryValue').textContent = toPercent(sample.memory.usage) + '%';
    document.getElementById('diskValue').textContent = toPercent(sample.disk.usage) + '%';
  } catch (e) {
    // ignore transient errors
  }
}, 30 * 1000);

// --- Card controls (close/minimize) and drag & drop ---
(() => {
  const grid = document.querySelector('.grid');
  if (!grid) return;
  function wireCardControls(card) {
    const closeBtn = card.querySelector('.card-btn[data-action="close"]');
    const collBtn = card.querySelector('.card-btn[data-action="collapse"]');
    closeBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      card.style.display = 'none';
    });
    collBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      card.classList.toggle('collapsed');
    });
  }
  grid.querySelectorAll('.card').forEach(wireCardControls);

  let dragSrc = null;
  function clearDropClasses(el) { el.classList.remove('drop-above', 'drop-below'); }
  function handleDragStart(e) {
    dragSrc = this;
    this.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    try { e.dataTransfer.setData('text/plain', 'drag'); } catch {}
  }
  function handleDragOver(e) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const target = this;
    if (!dragSrc || dragSrc === target) return;
    const rect = target.getBoundingClientRect();
    const offset = e.clientY - rect.top;
    target.classList.toggle('drop-above', offset < rect.height / 2);
    target.classList.toggle('drop-below', offset >= rect.height / 2);
  }
  function handleDragLeave() { clearDropClasses(this); }
  function handleDrop(e) {
    e.preventDefault();
    const target = this;
    if (!dragSrc || dragSrc === target) return false;
    const rect = target.getBoundingClientRect();
    const offset = e.clientY - rect.top;
    clearDropClasses(target);
    if (offset < rect.height / 2) grid.insertBefore(dragSrc, target);
    else grid.insertBefore(dragSrc, target.nextSibling);
    return false;
  }
  function handleDragEnd() {
    this.classList.remove('dragging');
    grid.querySelectorAll('.card').forEach(clearDropClasses);
  }
  grid.querySelectorAll('.card[draggable="true"]').forEach((card) => {
    // Start drag only from the grip
    const grip = card.querySelector('[data-drag-handle]');
    if (grip) {
      grip.addEventListener('dragstart', (e) => {
        handleDragStart.call(card, e);
        e.stopPropagation();
      });
      // On some browsers, initiating drag requires mousedown on draggable target
      grip.addEventListener('mousedown', () => {
        card.setAttribute('draggable', 'true');
      });
    }
    // Prevent dragstarting from non-grip areas
    card.addEventListener('dragstart', (e) => {
      if (!e.target.closest('[data-drag-handle]')) {
        e.preventDefault();
        return false;
      }
    });
    card.addEventListener('dragover', handleDragOver);
    card.addEventListener('dragleave', handleDragLeave);
    card.addEventListener('drop', handleDrop);
    card.addEventListener('dragend', handleDragEnd);
  });
})();

// --- Weather + Clock ---
(async () => {
  // Weather for San Diego via backend
  try {
    const r = await fetch('/api/weather');
    const w = await r.json();
    if (!w.error) {
      const temp = Math.round(w.temperatureF);
      const icon = w.icon || '🌡️';
      const desc = w.description || '';
      const tv = document.getElementById('weatherValue');
      const ti = document.getElementById('weatherIcon');
      const td = document.getElementById('weatherDesc');
      if (tv) tv.textContent = `${temp}°F`;
      if (ti) ti.textContent = icon;
      if (td) td.textContent = desc;
    }
  } catch {}

  // Clock (America/Los_Angeles)
  const timeEl = document.getElementById('clockTime');
  const dateEl = document.getElementById('clockDate');
  function tickClock() {
    const now = new Date();
    const optsTime = { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true, timeZone: 'America/Los_Angeles' };
    const optsDate = { weekday: 'short', year: 'numeric', month: 'short', day: '2-digit', timeZone: 'America/Los_Angeles' };
    if (timeEl) timeEl.textContent = new Intl.DateTimeFormat(undefined, optsTime).format(now);
    if (dateEl) dateEl.textContent = new Intl.DateTimeFormat(undefined, optsDate).format(now);
  }
  tickClock();
  setInterval(tickClock, 1000);
})();

// --- Rubik's Cube (3x3) ---
(() => {
  const container = document.getElementById('cubeContainer');
  if (!container) return;

  let width = container.clientWidth || 640;
  let height = container.clientHeight || 420;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0b1020);

  const camera = new THREE.PerspectiveCamera(50, width / height, 0.1, 100);
  camera.position.set(4, 4, 4);

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setSize(width, height);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  container.appendChild(renderer.domElement);

  const controls = new THREE.OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.enablePan = false;
  controls.minDistance = 3;
  controls.maxDistance = 10;

  // Lights
  const ambient = new THREE.AmbientLight(0xffffff, 0.9);
  scene.add(ambient);
  const dir = new THREE.DirectionalLight(0xffffff, 0.8);
  dir.position.set(3, 5, 2);
  scene.add(dir);

  // Cubelet factory
  const cubeSize = 1.0;
  const gap = 0.02;
  const faceColors = {
    U: 0xffffff, // white
    D: 0xffff00, // yellow
    L: 0xff8000, // orange
    R: 0xff0000, // red
    F: 0x00ff00, // green
    B: 0x0000ff, // blue
  };

  function createSticker(color) {
    return new THREE.Mesh(
      new THREE.PlaneGeometry(0.9, 0.9),
      new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide })
    );
  }

  function createCubelet(x, y, z) {
    const group = new THREE.Group();
    const base = new THREE.Mesh(
      new THREE.BoxGeometry(cubeSize - gap, cubeSize - gap, cubeSize - gap),
      new THREE.MeshStandardMaterial({ color: 0x111827, metalness: 0.2, roughness: 0.7 })
    );
    group.add(base);
    // stickers per visible face
    const half = (cubeSize - gap) / 2 + 0.01;
    const stickers = [];
    const faces = [
      { axis: 'y', sign: 1, color: faceColors.U },
      { axis: 'y', sign: -1, color: faceColors.D },
      { axis: 'x', sign: -1, color: faceColors.L },
      { axis: 'x', sign: 1, color: faceColors.R },
      { axis: 'z', sign: 1, color: faceColors.F },
      { axis: 'z', sign: -1, color: faceColors.B },
    ];
    for (const f of faces) {
      const s = createSticker(f.color);
      if (f.axis === 'x') {
        s.rotation.y = Math.PI / 2;
        s.position.x = f.sign * half;
      } else if (f.axis === 'y') {
        s.rotation.x = -Math.PI / 2;
        s.position.y = f.sign * half;
      } else if (f.axis === 'z') {
        s.position.z = f.sign * half;
      }
      group.add(s);
      stickers.push(s);
    }
    group.position.set(x, y, z);
    group.userData.coords = { x, y, z };
    return group;
  }

  const cubelets = [];
  const root = new THREE.Group();
  scene.add(root);
  for (let i = -1; i <= 1; i++) {
    for (let j = -1; j <= 1; j++) {
      for (let k = -1; k <= 1; k++) {
        const c = createCubelet(i, j, k);
        cubelets.push(c);
        root.add(c);
      }
    }
  }

  // Rotation helpers
  const quarter = Math.PI / 2;
  const moveDefs = {
    R: { axis: 'x', layer: 1, sign: 1 },
    L: { axis: 'x', layer: -1, sign: -1 },
    U: { axis: 'y', layer: 1, sign: 1 },
    D: { axis: 'y', layer: -1, sign: -1 },
    F: { axis: 'z', layer: 1, sign: 1 },
    B: { axis: 'z', layer: -1, sign: -1 },
  };

  function selectLayer(axis, layer) {
    const eps = 0.01;
    return cubelets.filter((c) => Math.abs(c.userData.coords[axis] - layer) < eps);
  }

  function applyRotationMetadata(layer, axis, dir) {
    // After a quarter-turn, update integer coords
    for (const c of layer) {
      const p = c.userData.coords;
      let { x, y, z } = p;
      const d = dir > 0 ? 1 : -1;
      if (axis === 'x') {
        // rotate around X: (y,z) -> (z, -y)
        [y, z] = d > 0 ? [z, -y] : [-z, y];
      } else if (axis === 'y') {
        // rotate around Y: (x,z) -> (-z, x)
        [x, z] = d > 0 ? [-z, x] : [z, -x];
      } else if (axis === 'z') {
        // rotate around Z: (x,y) -> (y, -x)
        [x, y] = d > 0 ? [y, -x] : [-y, x];
      }
      c.userData.coords = { x, y, z };
    }
  }

  function animateLayerTurn(layer, axis, clockwise, durationMs = 250) {
    return new Promise((resolve) => {
      const dir = clockwise ? 1 : -1;
      const group = new THREE.Group();
      root.add(group);
      for (const c of layer) {
        group.attach(c); // preserve world transform when reparenting into temp group
      }
      const start = performance.now();
      function step(now) {
        const t = Math.min(1, (now - start) / durationMs);
        const angle = dir * quarter * t;
        if (axis === 'x') group.rotation.x = angle;
        if (axis === 'y') group.rotation.y = angle;
        if (axis === 'z') group.rotation.z = angle;
        if (t < 1) {
          requestAnimationFrame(step);
        } else {
          // finalize
          if (axis === 'x') group.rotation.x = 0;
          if (axis === 'y') group.rotation.y = 0;
          if (axis === 'z') group.rotation.z = 0;
          for (const c of layer) {
            root.attach(c); // move cubelets back to root preserving transform
          }
          scene.remove(group);
          applyRotationMetadata(layer, axis, dir);
          resolve();
        }
      }
      requestAnimationFrame(step);
    });
  }

  async function doMove(move, speed = 1.0) {
    const prime = move.endsWith("'");
    const base = prime ? move[0] : move;
    const def = moveDefs[base];
    if (!def) return;
    const layer = selectLayer(def.axis, def.layer);
    const clockwise = prime ? def.sign < 0 : def.sign > 0;
    await animateLayerTurn(layer, def.axis, clockwise, 250 / speed);
  }

  function randomScramble(n = 25) {
    const bases = Object.keys(moveDefs);
    const seq = [];
    let prev = '';
    for (let i = 0; i < n; i++) {
      let m;
      do {
        m = bases[Math.floor(Math.random() * bases.length)];
      } while (prev && m[0] === prev[0]);
      prev = m;
      if (Math.random() < 0.5) m += "'";
      seq.push(m);
    }
    return seq;
  }

  async function playSequence(seq, speed = 1.0) {
    for (const m of seq) {
      await doMove(m, speed);
    }
  }

  // Very simple solver: invert scramble sequence if we keep it.
  let lastScramble = [];

  // Controls
  const btnReset = document.getElementById('cubeReset');
  const btnScramble = document.getElementById('cubeScramble');
  const btnSolve = document.getElementById('cubeSolve');
  const speedInput = document.getElementById('cubeSpeed');
  const presetSel = document.getElementById('cameraPreset');

  function setCameraPreset(name) {
    if (name === 'front') camera.position.set(0, 0, 6);
    else if (name === 'top') camera.position.set(0, 6, 0.01);
    else if (name === 'side') camera.position.set(6, 0, 0.01);
    else camera.position.set(4, 4, 4);
    camera.lookAt(0, 0, 0);
    controls.update();
  }

  btnReset?.addEventListener('click', async () => {
    // naive reset: reload page portion by reloading scene
    while (root.children.length) root.remove(root.children[0]);
    cubelets.splice(0, cubelets.length);
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) for (let k = -1; k <= 1; k++) {
      const c = createCubelet(i, j, k);
      cubelets.push(c);
      root.add(c);
    }
  });

  btnScramble?.addEventListener('click', async () => {
    const seq = randomScramble();
    lastScramble = seq.slice();
    const speed = parseFloat(speedInput.value || '1');
    await playSequence(seq, speed);
  });

  btnSolve?.addEventListener('click', async () => {
    if (!lastScramble.length) return;
    const inverse = lastScramble
      .slice()
      .reverse()
      .map((m) => (m.endsWith("'") ? m[0] : m + "'"));
    const speed = parseFloat(speedInput.value || '1');
    await playSequence(inverse, speed);
    lastScramble = [];
  });

  presetSel?.addEventListener('change', () => setCameraPreset(presetSel.value));
  setCameraPreset('iso');

  // Keyboard moves
  window.addEventListener('keydown', (e) => {
    const key = e.key.toUpperCase();
    if ('FRULDB'.includes(key)) {
      const prime = e.shiftKey;
      doMove(prime ? key + "'" : key, parseFloat(speedInput.value || '1'));
    }
  });

  // Render loop
  function render() {
    controls.update();
    renderer.render(scene, camera);
    requestAnimationFrame(render);
  }
  render();

  // Resize handling
  function handleResize() {
    const w = container.clientWidth || width;
    const h = container.clientHeight || height;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  window.addEventListener('resize', handleResize);
  if ('ResizeObserver' in window) {
    const ro = new ResizeObserver(() => handleResize());
    ro.observe(container);
  }
  // Ensure first layout has correct size
  requestAnimationFrame(handleResize);
})();

// --- News + Stocks widgets ---
(function () {
  async function loadTopNews() {
    try {
      const symbols = 'SPY,QQQ,DIA,IWM,TLT,TSLA,MSFT,GOOGL,C,ABBV,NVDA,TSM,WMT,BSX,EOG';
      const r = await fetch(`/api/news/top?symbols=${encodeURIComponent(symbols)}`);
      const { news = [] } = await r.json();
      const ul = document.getElementById('newsList');
      if (!ul) return;
      ul.innerHTML = '';
      for (const n of news) {
        const li = document.createElement('li');
        const a = document.createElement('a');
        a.href = n.link;
        const tag = (n.tickers && n.tickers.length) ? `${n.tickers.slice(0,2).join('/')}` : '';
        a.textContent = (n.title || '');
        a.target = '_blank';
        const t = document.createElement('time');
        if (n.pubDate) t.textContent = new Date(n.pubDate).toLocaleString();
        li.appendChild(a);
        if (tag) {
          const tags = document.createElement('span');
          tags.className = 'tags';
          tags.textContent = ` [${tag}]`;
          li.appendChild(tags);
        }
        if (n.pubDate) li.appendChild(t);
        ul.appendChild(li);
      }
      if (!news || news.length === 0) {
        ul.innerHTML = '<li class="muted">No stories available.</li>';
      }
    } catch {}
  }

  async function loadAINews() {
    try {
      const r = await fetch('/api/news/ai');
      const { news = [] } = await r.json();
      const ul = document.getElementById('aiNewsList');
      if (!ul) return;
      ul.innerHTML = '';
      for (const n of news) {
        const li = document.createElement('li');
        const a = document.createElement('a');
        a.href = n.link;
        a.textContent = (n.title || '');
        a.target = '_blank';
        const t = document.createElement('time');
        if (n.pubDate) t.textContent = new Date(n.pubDate).toLocaleString();
        li.appendChild(a);
        if (n.pubDate) li.appendChild(t);
        ul.appendChild(li);
      }
      if (!news || news.length === 0) {
        ul.innerHTML = '<li class="muted">No stories available.</li>';
      }
    } catch {}
  }

  async function loadStocks() {
    try {
      const symbols = 'SPY,QQQ,DIA,IWM,TLT,TSLA,MSFT,GOOGL,C,ABBV,NVDA,TSM,WMT,BSX,EOG';
      const r = await fetch(`/api/stocks?symbols=${encodeURIComponent(symbols)}`);
      const { data = [] } = await r.json();
      const wrap = document.getElementById('stocks');
      if (!wrap) return;
      wrap.innerHTML = '';
      for (const q of data) {
        const el = document.createElement('div');
        el.className = 'ticker';
        const chg = Number(q.change || 0);
        const chgPct = Number(q.changePercent || 0);
        const cls = chg >= 0 ? 'up' : 'down';
        el.innerHTML = `
          <div class="sym">${q.symbol}</div>
          <div class="px">${q.price?.toFixed(2) ?? '—'} <span class="chg ${cls}">${chg >= 0 ? '+' : ''}${chg.toFixed(2)} (${chgPct.toFixed(2)}%)</span></div>
          <div class="meta">Prev: ${q.previousClose?.toFixed(2) ?? '—'} ${q.currency || ''}</div>
        `;
        wrap.appendChild(el);
      }
    } catch {}
  }

  // Initial loads
  loadTopNews();
  loadAINews();
  loadStocks();

  // TradingView now rendered via iframes; no client-side injection needed

  // Periodic refreshes every few minutes
  setInterval(loadTopNews, 3 * 60 * 1000);
  setInterval(loadAINews, 5 * 60 * 1000);
  setInterval(loadStocks, 3 * 60 * 1000);
})();

// Removed Ticker Trend widget; replaced by AI News above