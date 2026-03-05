(() => {
  'use strict';

  const WORLD_WIDTH = 360;
  const WORLD_HEIGHT = 220;
  const SPRITE_SIZE = 16;
  const DRAW_SIZE = 26;

  const STATUS_ICON = {
    Idle: 'Z',
    Thinking: '?',
    'Tool-Running': '*',
    Outputting: '+',
    Waiting: '...'
  };

  const colorSeeds = [
    ['#5b8f5a', '#3f6e3d', '#cde8b5'],
    ['#7899d1', '#4d6f9f', '#dae8ff'],
    ['#d97f5a', '#a45536', '#ffd9bf'],
    ['#9b80c6', '#6d5798', '#eedcff'],
    ['#d0b44f', '#987e2c', '#fff1b8'],
    ['#5ca59a', '#35756d', '#d2fff7']
  ];

  const canvas = document.getElementById('office-canvas');
  const activeCountEl = document.getElementById('active-count');
  const lastUpdateEl = document.getElementById('last-update');
  const projectFilterEl = document.getElementById('project-filter');
  const sessionFilterEl = document.getElementById('session-filter');
  const agentListEl = document.getElementById('agent-list');

  const uiState = {
    projectFilter: 'all',
    sessionFilter: 'all'
  };

  const appState = {
    snapshot: {
      agents: [],
      activeAgentCount: 0,
      config: {
        enablePokeapiSprites: false
      }
    },
    entityById: new Map(),
    projects: [],
    sessions: []
  };

  const worldCanvas = document.createElement('canvas');
  worldCanvas.width = WORLD_WIDTH;
  worldCanvas.height = WORLD_HEIGHT;
  const worldCtx = worldCanvas.getContext('2d');
  worldCtx.imageSmoothingEnabled = false;

  const screenCtx = canvas.getContext('2d');
  screenCtx.imageSmoothingEnabled = false;

  const workstations = [
    { x: 70, y: 72 },
    { x: 140, y: 72 },
    { x: 210, y: 72 },
    { x: 285, y: 72 },
    { x: 70, y: 150 },
    { x: 140, y: 150 },
    { x: 210, y: 150 },
    { x: 285, y: 150 }
  ];

  function hashCode(input) {
    let h = 2166136261;
    for (let i = 0; i < input.length; i += 1) {
      h ^= input.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return Math.abs(h >>> 0);
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function toShortId(value) {
    if (!value) {
      return 'unknown';
    }
    return value.length <= 14 ? value : `${value.slice(0, 6)}...${value.slice(-5)}`;
  }

  function setCanvasSize() {
    const rect = canvas.getBoundingClientRect();
    const dpr = Math.max(1, Math.floor(window.devicePixelRatio || 1));
    const width = Math.max(320, Math.floor(rect.width));
    const height = Math.max(240, Math.floor(rect.height));

    canvas.width = width * dpr;
    canvas.height = height * dpr;
    screenCtx.setTransform(1, 0, 0, 1, 0, 0);
    screenCtx.scale(dpr, dpr);
    screenCtx.imageSmoothingEnabled = false;
  }

  class LocalSpriteProvider {
    constructor() {
      this.cache = new Map();
    }

    getSprite(agent, frame, status) {
      const palette = colorSeeds[hashCode(agent.agentId) % colorSeeds.length];
      const key = `${palette.join('|')}:${status}:${frame}`;
      if (this.cache.has(key)) {
        return this.cache.get(key);
      }

      const sprite = document.createElement('canvas');
      sprite.width = SPRITE_SIZE;
      sprite.height = SPRITE_SIZE;
      const ctx = sprite.getContext('2d');
      ctx.imageSmoothingEnabled = false;

      const body = palette[0];
      const outline = palette[1];
      const light = palette[2];

      const bob = status === 'Idle' ? (frame % 2 === 0 ? 0 : 1) : 0;

      function px(x, y, color) {
        ctx.fillStyle = color;
        ctx.fillRect(x, y + bob, 1, 1);
      }

      for (let y = 5; y <= 11; y += 1) {
        for (let x = 4; x <= 11; x += 1) {
          px(x, y, body);
        }
      }

      for (let y = 4; y <= 12; y += 1) {
        px(3, y, outline);
        px(12, y, outline);
      }
      for (let x = 3; x <= 12; x += 1) {
        px(x, 4, outline);
        px(x, 12, outline);
      }

      px(5, 4, body);
      px(10, 4, body);
      px(4, 3, outline);
      px(11, 3, outline);

      px(6, 7, '#111');
      px(9, 7, '#111');
      px(7, 9, light);
      px(8, 9, light);

      if (status === 'Outputting') {
        px(7, 10, '#111');
        px(8, 10, '#111');
        if (frame % 2 === 0) {
          px(9, 10, '#111');
        }
      }

      if (status === 'Tool-Running') {
        const offset = frame % 3;
        px(12, 8 + (offset === 0 ? -1 : offset === 2 ? 1 : 0), '#e9e2d0');
        px(13, 8, '#111');
      }

      if (status === 'Waiting') {
        px(7, 10, '#111');
      }

      if (status === 'Thinking') {
        px(7, 6, light);
      }

      this.cache.set(key, sprite);
      return sprite;
    }
  }

  class PokeApiSpriteProvider {
    constructor(localProvider) {
      this.localProvider = localProvider;
      this.images = new Map();
    }

    getSprite(agent, frame, status) {
      const id = (hashCode(agent.agentId) % 151) + 1;
      const cached = this.images.get(id);
      if (!cached) {
        const image = new Image();
        image.decoding = 'async';
        image.referrerPolicy = 'no-referrer';
        image.src = `https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/${id}.png`;
        this.images.set(id, { image, loaded: false });
        image.onload = () => {
          const row = this.images.get(id);
          if (row) {
            row.loaded = true;
          }
        };
        image.onerror = () => {
          this.images.set(id, { image: null, loaded: false, failed: true });
        };
        return this.localProvider.getSprite(agent, frame, status);
      }

      if (cached.loaded && cached.image) {
        return cached.image;
      }

      return this.localProvider.getSprite(agent, frame, status);
    }
  }

  const localProvider = new LocalSpriteProvider();
  const pokeProvider = new PokeApiSpriteProvider(localProvider);

  function spriteProvider() {
    return appState.snapshot.config && appState.snapshot.config.enablePokeapiSprites ? pokeProvider : localProvider;
  }

  function ensureEntity(agent) {
    let entity = appState.entityById.get(agent.agentId);
    if (entity) {
      return entity;
    }

    let x = 28 + (hashCode(agent.agentId + 'x') % (WORLD_WIDTH - 56));
    let y = 34 + (hashCode(agent.agentId + 'y') % (WORLD_HEIGHT - 68));

    if (agent.parentId) {
      const parent = appState.entityById.get(agent.parentId);
      if (parent) {
        x = parent.x + ((hashCode(agent.agentId) % 13) - 6);
        y = parent.y + ((hashCode(agent.agentId + 'p') % 13) - 6);
      }
    }

    entity = {
      id: agent.agentId,
      x,
      y,
      targetX: x,
      targetY: y,
      wanderAt: performance.now(),
      orbitOffset: hashCode(agent.agentId) % 360
    };

    appState.entityById.set(agent.agentId, entity);
    return entity;
  }

  function reconcileEntities(agents) {
    const live = new Set(agents.map((agent) => agent.agentId));

    for (const id of appState.entityById.keys()) {
      if (!live.has(id)) {
        appState.entityById.delete(id);
      }
    }

    for (const agent of agents) {
      ensureEntity(agent);
    }
  }

  function filteredAgents() {
    return appState.snapshot.agents.filter((agent) => {
      if (uiState.projectFilter !== 'all' && agent.projectId !== uiState.projectFilter) {
        return false;
      }
      if (uiState.sessionFilter !== 'all' && agent.sessionId !== uiState.sessionFilter) {
        return false;
      }
      return true;
    });
  }

  function updateFilterOptions() {
    const projects = Array.from(new Set(appState.snapshot.agents.map((agent) => agent.projectId))).sort();
    const sessions = Array.from(new Set(appState.snapshot.agents.map((agent) => agent.sessionId))).sort();

    appState.projects = projects;
    appState.sessions = sessions;

    projectFilterEl.innerHTML = '<option value="all">All</option>';
    for (const project of projects) {
      const opt = document.createElement('option');
      opt.value = project;
      opt.textContent = project;
      if (project === uiState.projectFilter) {
        opt.selected = true;
      }
      projectFilterEl.appendChild(opt);
    }

    if (!projects.includes(uiState.projectFilter)) {
      uiState.projectFilter = 'all';
    }

    sessionFilterEl.innerHTML = '<option value="all">All</option>';
    for (const session of sessions) {
      const opt = document.createElement('option');
      opt.value = session;
      opt.textContent = session;
      if (session === uiState.sessionFilter) {
        opt.selected = true;
      }
      sessionFilterEl.appendChild(opt);
    }

    if (!sessions.includes(uiState.sessionFilter)) {
      uiState.sessionFilter = 'all';
    }
  }

  function renderAgentList() {
    const rows = filteredAgents()
      .sort((a, b) => Number(b.isActive) - Number(a.isActive) || b.lastSeen - a.lastSeen)
      .slice(0, 80);

    if (rows.length === 0) {
      agentListEl.innerHTML = '<div class="agent-card">No agents match current filter.</div>';
      return;
    }

    agentListEl.innerHTML = rows
      .map((agent) => {
        const secsAgo = Math.max(0, Math.floor((Date.now() - agent.lastSeen) / 1000));
        return [
          '<article class="agent-card">',
          `<div class="name">${escapeHtml(toShortId(agent.agentId))}</div>`,
          `<div class="meta">${escapeHtml(agent.projectId)} | ${escapeHtml(agent.sessionId)}</div>`,
          `<span class="status-chip">${escapeHtml(agent.status)}</span>`,
          `<div>tool: ${escapeHtml(agent.lastTool || '-')}</div>`,
          `<div>last: ${secsAgo}s ago</div>`,
          agent.parentId ? `<div>parent: ${escapeHtml(toShortId(agent.parentId))}</div>` : '',
          '</article>'
        ].join('');
      })
      .join('');
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function applySnapshot(snapshot) {
    appState.snapshot = snapshot;
    reconcileEntities(snapshot.agents);
    updateFilterOptions();
    renderAgentList();
    activeCountEl.textContent = String(snapshot.activeAgentCount || 0);
    lastUpdateEl.textContent = new Date(snapshot.lastUpdate || Date.now()).toLocaleTimeString();
  }

  function updateEntityMotion(now) {
    const agents = filteredAgents();
    const byId = new Map(agents.map((agent) => [agent.agentId, agent]));

    for (const agent of agents) {
      const entity = ensureEntity(agent);
      const active = !!agent.isActive;

      if (agent.parentId && byId.has(agent.parentId)) {
        const parentEntity = ensureEntity(byId.get(agent.parentId));
        const theta = ((now / 1000) * 1.7 + entity.orbitOffset * 0.06) % (Math.PI * 2);
        const radius = 14 + (hashCode(agent.agentId) % 10);
        entity.targetX = parentEntity.x + Math.cos(theta) * radius;
        entity.targetY = parentEntity.y + Math.sin(theta) * radius;
      } else if (active) {
        const ws = workstations[hashCode(agent.agentId) % workstations.length];
        entity.targetX = ws.x + ((hashCode(agent.agentId + 'dx') % 7) - 3);
        entity.targetY = ws.y + ((hashCode(agent.agentId + 'dy') % 5) - 2);
      } else if (now > entity.wanderAt) {
        entity.targetX = 24 + (hashCode(agent.agentId + String(now)) % (WORLD_WIDTH - 48));
        entity.targetY = 30 + (hashCode(String(now) + agent.agentId) % (WORLD_HEIGHT - 62));
        entity.wanderAt = now + 2200 + (hashCode(agent.agentId + 'w') % 1800);
      }

      const speed = active ? 0.11 : 0.05;
      entity.x += (entity.targetX - entity.x) * speed;
      entity.y += (entity.targetY - entity.y) * speed;
      entity.x = clamp(entity.x, 12, WORLD_WIDTH - 12);
      entity.y = clamp(entity.y, 22, WORLD_HEIGHT - 8);
    }
  }

  function drawBackground(time) {
    worldCtx.clearRect(0, 0, WORLD_WIDTH, WORLD_HEIGHT);

    worldCtx.fillStyle = '#e7efe2';
    worldCtx.fillRect(0, 0, WORLD_WIDTH, WORLD_HEIGHT);

    worldCtx.fillStyle = '#d8e4cf';
    for (let y = 0; y < WORLD_HEIGHT; y += 12) {
      worldCtx.fillRect(0, y, WORLD_WIDTH, 1);
    }
    for (let x = 0; x < WORLD_WIDTH; x += 12) {
      worldCtx.fillRect(x, 0, 1, WORLD_HEIGHT);
    }

    worldCtx.fillStyle = '#c8d5c0';
    worldCtx.fillRect(0, 178, WORLD_WIDTH, 42);

    worldCtx.fillStyle = '#b8c7ae';
    workstations.forEach((ws, i) => {
      const flicker = (Math.floor(time / 300 + i) % 2) * 2;
      worldCtx.fillRect(ws.x - 13, ws.y - 8, 26, 14);
      worldCtx.fillStyle = '#8b95a9';
      worldCtx.fillRect(ws.x - 8, ws.y - 15, 16, 6 + flicker);
      worldCtx.fillStyle = '#b8c7ae';
    });
  }

  function drawConnections(agents) {
    const byId = new Map(agents.map((agent) => [agent.agentId, agent]));
    worldCtx.strokeStyle = 'rgba(40, 55, 75, 0.35)';
    worldCtx.lineWidth = 1;

    for (const agent of agents) {
      if (!agent.parentId || !byId.has(agent.parentId)) {
        continue;
      }
      const parentEntity = appState.entityById.get(agent.parentId);
      const childEntity = appState.entityById.get(agent.agentId);
      if (!parentEntity || !childEntity) {
        continue;
      }

      worldCtx.beginPath();
      worldCtx.moveTo(Math.round(parentEntity.x), Math.round(parentEntity.y));
      worldCtx.lineTo(Math.round(childEntity.x), Math.round(childEntity.y));
      worldCtx.stroke();
    }
  }

  function drawAgents(agents, now) {
    const drawRows = agents
      .map((agent) => ({
        agent,
        entity: appState.entityById.get(agent.agentId)
      }))
      .filter((row) => !!row.entity)
      .sort((a, b) => a.entity.y - b.entity.y);

    const provider = spriteProvider();

    worldCtx.font = '6px monospace';
    worldCtx.textBaseline = 'top';

    for (const row of drawRows) {
      const { agent, entity } = row;
      const frame = Math.floor(now / 180 + hashCode(agent.agentId)) % 3;
      const bob = agent.status === 'Idle' ? Math.sin((now / 480) + hashCode(agent.agentId) * 0.01) * 1.5 : 0;
      const sprite = provider.getSprite(agent, frame, agent.status);

      const x = Math.round(entity.x - DRAW_SIZE / 2);
      const y = Math.round(entity.y - DRAW_SIZE + bob);

      worldCtx.imageSmoothingEnabled = false;
      worldCtx.drawImage(sprite, x, y, DRAW_SIZE, DRAW_SIZE);

      const badge = toShortId(agent.agentId);
      const badgeWidth = Math.min(90, badge.length * 4 + 6);
      worldCtx.fillStyle = 'rgba(255, 248, 230, 0.95)';
      worldCtx.fillRect(x - 2, y - 8, badgeWidth, 7);
      worldCtx.strokeStyle = '#1a1d1f';
      worldCtx.strokeRect(x - 2, y - 8, badgeWidth, 7);
      worldCtx.fillStyle = '#15191d';
      worldCtx.fillText(badge, x, y - 7);

      const icon = STATUS_ICON[agent.status] || '?';
      const bubbleX = x + DRAW_SIZE - 2;
      const bubbleY = y + 2;
      worldCtx.fillStyle = '#ffffff';
      worldCtx.fillRect(bubbleX, bubbleY, 14, 8);
      worldCtx.strokeStyle = '#1a1d1f';
      worldCtx.strokeRect(bubbleX, bubbleY, 14, 8);
      worldCtx.fillStyle = '#111';
      worldCtx.fillText(icon, bubbleX + 2, bubbleY + 1);
    }
  }

  function composeToScreen() {
    const rect = canvas.getBoundingClientRect();
    const width = Math.max(1, Math.floor(rect.width));
    const height = Math.max(1, Math.floor(rect.height));

    screenCtx.clearRect(0, 0, width, height);
    screenCtx.fillStyle = '#e6ede2';
    screenCtx.fillRect(0, 0, width, height);

    const scale = Math.max(1, Math.floor(Math.min(width / WORLD_WIDTH, height / WORLD_HEIGHT)));
    const drawW = WORLD_WIDTH * scale;
    const drawH = WORLD_HEIGHT * scale;
    const offsetX = Math.floor((width - drawW) / 2);
    const offsetY = Math.floor((height - drawH) / 2);

    screenCtx.imageSmoothingEnabled = false;
    screenCtx.drawImage(worldCanvas, offsetX, offsetY, drawW, drawH);
  }

  function render(now) {
    updateEntityMotion(now);
    drawBackground(now);
    const agents = filteredAgents();
    drawConnections(agents);
    drawAgents(agents, now);
    composeToScreen();
    requestAnimationFrame(render);
  }

  async function loadInitialState() {
    const res = await fetch('/api/state', { cache: 'no-cache' });
    if (!res.ok) {
      throw new Error(`state load failed: ${res.status}`);
    }
    const data = await res.json();
    applySnapshot(data);
  }

  function connectEvents() {
    const stream = new EventSource('/events');
    stream.addEventListener('state', (event) => {
      try {
        const snapshot = JSON.parse(event.data);
        applySnapshot(snapshot);
      } catch (error) {
        // Ignore malformed event payloads.
      }
    });

    stream.onerror = () => {
      // EventSource reconnects automatically.
    };

    return stream;
  }

  function bindUi() {
    projectFilterEl.addEventListener('change', () => {
      uiState.projectFilter = projectFilterEl.value;
      renderAgentList();
    });

    sessionFilterEl.addEventListener('change', () => {
      uiState.sessionFilter = sessionFilterEl.value;
      renderAgentList();
    });

    window.addEventListener('resize', setCanvasSize);
  }

  async function boot() {
    bindUi();
    setCanvasSize();

    try {
      await loadInitialState();
    } catch (error) {
      agentListEl.innerHTML = `<div class="agent-card">Failed to load state: ${escapeHtml(error.message)}</div>`;
    }

    connectEvents();
    requestAnimationFrame(render);
  }

  boot();
})();
