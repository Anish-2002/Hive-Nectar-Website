/**
 * Decorator Jar v3 — Matter.js physics engine.
 * Tokens drop with gravity, bounce, and stack in the jar.
 */
import { supabase } from './supabase-config.js';
import { showToast } from './app.js';

let userProfile = null;
let placedTokens = new Set();  // milestoneIds placed in jar
let earnedMilestones = [];
let isDirty = false;

// Matter.js state
let engine, renderer, runner, jarWalls = [];
let physicsReady = false;

export async function initDecorator(profile) {
  userProfile = profile;
  await loadDecorations();
}

// ============ OPEN / CLOSE ============

window.openDecoratorSheet = async function () {
  const sheet = document.getElementById('decoratorSheet');
  if (!sheet) return;
  sheet.style.display = 'flex';
  sheet.style.visibility = 'visible';
  sheet.style.opacity = '1';
  sheet.classList.add('active');

  await loadEarnedTokens();
  setTimeout(() => {
    renderUI();
    initPhysics();
  }, 100);
};

window.closeDecoratorSheet = function () {
  stopPhysics();
  const sheet = document.getElementById('decoratorSheet');
  if (!sheet) return;
  sheet.classList.remove('active');
  sheet.style.visibility = 'hidden';
  sheet.style.opacity = '0';
  setTimeout(() => { sheet.style.display = 'none'; }, 350);
};

// ============ DATA ============

async function loadEarnedTokens() {
  if (!userProfile) return;
  const { data: userM, error } = await supabase
    .from('user_milestones')
    .select('milestone_id, milestones(id, name, icon_url, category, active)')
    .eq('user_id', userProfile.id);
  if (error) { console.error(error); return; }
  earnedMilestones = (userM || [])
    .map(um => um.milestones)
    .filter(m => m && m.active !== false);
}

async function loadDecorations() {
  if (!userProfile) return;
  const { data, error } = await supabase
    .from('user_jar_decorations')
    .select('*')
    .eq('user_id', userProfile.id);
  if (!error && data) {
    placedTokens.clear();
    data.forEach(d => placedTokens.add(d.milestone_id));
  } else {
    try {
      const saved = JSON.parse(localStorage.getItem(`jar_deco_${userProfile.id}`) || '[]');
      placedTokens.clear();
      saved.forEach(s => placedTokens.add(s.milestone_id));
    } catch {}
  }
  isDirty = false;
}

// ============ UI RENDER ============

function renderUI() {
  const container = document.getElementById('jarContainer');
  if (!container) return;

  container.innerHTML = `
    <div class="physics-jar-layout">
      <!-- Token badges above jar -->
      <div class="physics-token-source" id="physicsTokenSource"></div>

      <!-- Jar with DOM token layer and bees -->
      <div class="physics-jar-wrapper" style="position:relative; display:inline-block;">
        <div class="physics-jar" id="physicsJar">
          <div class="glass-reflection"></div>
          <!-- Honey layer — warm amber filling between coins -->
          <div class="honey-layer">
            <div class="honey-shimmer"></div>
            <div class="honey-bubble" style="left:20%;bottom:30%;width:12px;height:12px;animation-delay:0s;"></div>
            <div class="honey-bubble" style="left:55%;bottom:50%;width:8px;height:8px;animation-delay:1.2s;"></div>
            <div class="honey-bubble" style="left:75%;bottom:25%;width:10px;height:10px;animation-delay:2.5s;"></div>
            <div class="honey-bubble" style="left:35%;bottom:65%;width:6px;height:6px;animation-delay:0.8s;"></div>
          </div>
          <div id="tokensLayer" style="position:absolute;inset:0;z-index:10;pointer-events:none;"></div>
        </div>
        <!-- Bees outside jar's overflow:hidden so they can fly around it -->
        <div class="bee-orbit" id="bee1-orbit"><div class="bee">${beeSvg()}</div></div>
        <div class="bee-orbit" id="bee2-orbit"><div class="bee">${beeSvg()}</div></div>
        <div class="bee-orbit" id="bee3-orbit"><div class="bee">${beeSvg()}</div></div>
      </div>

      <div class="jar-glow"></div>

      <!-- Actions -->
      <div class="jar-actions">
        <button class="btn btn-success" onclick="saveJarDecoration()" style="flex:2;"><i class="fas fa-save"></i> Save</button>
        <button class="btn btn-secondary" onclick="clearJarDecoration()" style="flex:1;"><i class="fas fa-trash"></i> Clear</button>
      </div>
      <div id="sparkle-layer" style="position:fixed;inset:0;pointer-events:none;z-index:110;"></div>
    </div>
  `;

  renderTokenBadges();
}

function beeSvg() {
  return `<div style="width:34px;height:22px;"><img src="data:image/svg+xml;base64,PHN2ZyB2aWV3Qm94PSIwIDAgMzQgMjIiIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyI+CiAgPGVsbGlwc2UgY3g9IjE3IiBjeT0iMTQiIHJ4PSIxNyIgcnk9IjExIiBmaWxsPSJyZ2JhKDI1NSwyMjAsNjAsMC4yNSkiLz4KICA8ZWxsaXBzZSBjeD0iMTIiIGN5PSI3IiByeD0iOSIgcnk9IjUuNSIgZmlsbD0icmdiYSgyNTUsMjU1LDI1NSwuNzIpIiBzdHJva2U9InJnYmEoMjU1LDIyMCw4MCwuNCkiIHN0cm9rZS13aWR0aD0iLjYiLz4KICA8ZWxsaXBzZSBjeD0iMjIiIGN5PSI3IiByeD0iOSIgcnk9IjUuNSIgZmlsbD0icmdiYSgyNTUsMjU1LDI1NSwuNzIpIiBzdHJva2U9InJnYmEoMjU1LDIyMCw4MCwuNCkiIHN0cm9rZS13aWR0aD0iLjYiLz4KICA8ZWxsaXBzZSBjeD0iMTciIGN5PSIxNCIgcng9IjExIiByeT0iNyIgZmlsbD0icmdiYSgyNTUsMjA0LDAsLjkpIi8+CiAgPGxpbmUgeDE9IjExIiB5MT0iMTQiIHgyPSIyMyIgeTI9IjE0IiBzdHJva2U9InJnYmEoOTAsNTAsMCwuMzgpIiBzdHJva2Utd2lkdGg9IjEuNCIvPgogIDxsaW5lIHgxPSIxMyIgeTE9IjkiIHgyPSIxMyIgeTI9IjE5IiBzdHJva2U9InJnYmEoOTAsNTAsMCwuMjgpIiBzdHJva2Utd2lkdGg9IjEuMiIvPgogIDxsaW5lIHgxPSIxNyIgeTE9IjgiIHgyPSIxNyIgeTI9IjIwIiBzdHJva2U9InJnYmEoOTAsNTAsMCwuMjgpIiBzdHJva2Utd2lkdGg9IjEuMiIvPgogIDxsaW5lIHgxPSIyMSIgeTE9IjkiIHgyPSIyMSIgeTI9IjE5IiBzdHJva2U9InJnYmEoOTAsNTAsMCwuMjgpIiBzdHJva2Utd2lkdGg9IjEuMiIvPgogIDxjaXJjbGUgY3g9IjI2IiBjeT0iMTEiIHI9IjMuNSIgZmlsbD0icmdiYSgyNTUsMjQwLDEyMCwuNzUpIi8+Cjwvc3ZnPg==" alt="bee" style="width:100%;height:100%;"></div>`;
}

function renderTokenBadges() {
  const source = document.getElementById('physicsTokenSource');
  if (!source) return;

  const unplaced = earnedMilestones.filter(m => !placedTokens.has(m.id));
  if (unplaced.length === 0) {
    source.innerHTML = '<p class="tiny muted" style="padding:8px;text-align:center;">All tokens in the jar! 🎉</p>';
    return;
  }

  // Also show placed tokens as greyed out so user can re-drop them
  earnedMilestones.forEach(m => {
    const isPlaced = placedTokens.has(m.id);
    const el = document.createElement('div');
    el.className = `physics-badge ${isPlaced ? 'placed' : ''}`;
    el.title = isPlaced ? `${m.name} (already in jar — click to re-drop)` : m.name;

    if (m.icon_url) {
      const img = document.createElement('img');
      img.src = m.icon_url;
      img.alt = m.name;
      img.className = 'physics-badge-img';
      el.appendChild(img);
    } else {
      el.textContent = '🏆';
      el.style.fontSize = '1.4rem';
    }

    const label = document.createElement('span');
    label.className = 'physics-badge-label';
    label.textContent = m.name;
    el.appendChild(label);

    if (!isPlaced) {
      el.onclick = () => dropToken(m.id, m.icon_url);
    } else {
      el.onclick = () => {
        // Remove from jar and re-drop
        placedTokens.delete(m.id);
        dropToken(m.id, m.icon_url);
        renderTokenBadges();
        isDirty = true;
      };
    }

    source.appendChild(el);
  });
}

// ============ PHYSICS ENGINE ============

// Body map: id → { body, el }
let bodyMap = null;
let dragState = null;

// ── Pointer drag handlers ──────────────────────────
function pointerDown(e, body, el) {
  e.preventDefault();
  dragState = { body, el, offX: 0, offY: 0 };
  const rect = document.getElementById('physicsJar').getBoundingClientRect();
  dragState.offX = e.clientX - rect.left - body.position.x;
  dragState.offY = e.clientY - rect.top - body.position.y;
  el.style.zIndex = '20';
  el.style.cursor = 'grabbing';
  el.setPointerCapture(e.pointerId);
}

window.addEventListener('pointermove', (e) => {
  if (!dragState) return;
  const { body, el, offX, offY } = dragState;
  const rect = document.getElementById('physicsJar').getBoundingClientRect();
  const w = rect.width || 320;
  const h = rect.height || 450;
  const size = 24;
  const nx = Math.max(size + 4, Math.min(w - size - 4, e.clientX - rect.left - offX));
  const ny = Math.max(size + 40, Math.min(h - size - 6, e.clientY - rect.top - offY));
  const { Body } = Matter;
  Body.setPosition(body, { x: nx, y: ny });
  Body.setVelocity(body, { x: (nx - body.position.x) * 0.4, y: (ny - body.position.y) * 0.4 });
  el.style.left = (nx - size) + 'px';
  el.style.top = (ny - size) + 'px';
});

window.addEventListener('pointerup', () => {
  if (!dragState) return;
  const { body } = dragState;
  const { Body } = Matter;
  Body.setVelocity(body, { x: 0, y: 0 });
  dragState.el.style.zIndex = '10';
  dragState.el.style.cursor = 'grab';
  dragState = null;
});

window.addEventListener('pointercancel', () => {
  if (dragState) {
    dragState.el.style.zIndex = '10';
    dragState.el.style.cursor = 'grab';
  }
  dragState = null;
});

function initPhysics() {
  const jarEl = document.getElementById('physicsJar');
  if (!jarEl || typeof Matter === 'undefined') return;

  const w = jarEl.offsetWidth || 320;
  const h = jarEl.offsetHeight || 450;

  const { Engine, Render, Runner, Bodies, Body, Composite, Events } = Matter;

  engine = Engine.create({ gravity: { x: 0, y: 2.2 } });
  bodyMap = new Map();
  dragState = null;

  renderer = Render.create({
    element: jarEl,
    engine: engine,
    options: {
      width: w,
      height: h,
      wireframes: false,
      background: 'transparent',
    }
  });

  // Make canvas invisible — physics for collision only, DOM handles visuals
  renderer.canvas.style.opacity = '0';
  renderer.canvas.style.pointerEvents = 'none';

  // Jar boundaries — curved walls matching jar border-radius
  const wallOpts = { isStatic: true, friction: 0.6, render: { visible: false } };
  const R = Math.min(w, h) * 0.22; // approximate bottom border-radius
  const steps = 7;

  // Side walls — full body (overlaps taper above)
  const leftWall = Bodies.rectangle(4, h * 0.4, 10, h * 0.9, wallOpts);
  const rightWall = Bodies.rectangle(w - 4, h * 0.4, 10, h * 0.9, wallOpts);
  const ground = Bodies.rectangle(w / 2, h - 3, w - 2 * R - 20, 10, wallOpts);

  jarWalls = [ground, leftWall, rightWall];

  // Neck-to-body transition walls (jar tapers from narrow neck to wider body)
  const neckW = w * 0.42;
  const neckXe = (w - neckW) / 2;
  const taperLen = h * 0.2;
  const taperDx = w * 0.16;
  const taperAngle = Math.atan2(taperLen, taperDx);
  // Left taper — overlaps with straight wall below
  jarWalls.push(Bodies.rectangle(neckXe / 2 + 2, h * 0.16,
    Math.hypot(taperLen, taperDx) + 8, 10, { ...wallOpts, angle: -taperAngle }));
  // Right taper
  jarWalls.push(Bodies.rectangle(w - neckXe / 2 - 2, h * 0.16,
    Math.hypot(taperLen, taperDx) + 8, 10, { ...wallOpts, angle: taperAngle + 0.01 }));

  // Bottom-left curve segments
  const cx = R, cy = h - R;
  for (let i = 0; i < steps; i++) {
    const a0 = (i / steps) * Math.PI / 2;
    const a1 = ((i+1) / steps) * Math.PI / 2;
    const am = (a0 + a1) / 2;
    const len = R * (Math.PI / 2) / steps;
    const mx = cx - R * Math.cos(am) - 4;
    const my = cy + R * Math.sin(am);
    jarWalls.push(Bodies.rectangle(mx, my, len + 6, 10, { ...wallOpts, angle: am }));
  }

  // Bottom-right curve segments
  for (let i = 0; i < steps; i++) {
    const a0 = (i / steps) * Math.PI / 2;
    const a1 = ((i+1) / steps) * Math.PI / 2;
    const am = (a0 + a1) / 2;
    const len = R * (Math.PI / 2) / steps;
    const mx = w - R + R * Math.cos(am) + 4;
    const my = cy + R * Math.sin(am);
    jarWalls.push(Bodies.rectangle(mx, my, len + 6, 10, { ...wallOpts, angle: Math.PI - am }));
  }
  Composite.add(engine.world, jarWalls);

  Render.run(renderer);
  runner = Runner.create();
  Runner.run(runner, engine);
  physicsReady = true;

  // Sync DOM token positions from physics bodies every frame
  Events.on(engine, 'afterUpdate', () => {
    const size = 24;
    bodyMap.forEach(({ body, el }) => {
      if (dragState && dragState.body === body) return; // skip dragged token
      el.style.left = (body.position.x - size) + 'px';
      el.style.top = (body.position.y - size) + 'px';
    });
  });

  // Handle resize
  window.addEventListener('resize', onPhysicsResize);
}

function stopPhysics() {
  if (!physicsReady) return;
  const { Render, Runner, Engine } = Matter;
  Runner.stop(runner);
  Render.stop(renderer);
  renderer.canvas.remove();
  Engine.clear(engine);
  physicsReady = false;
  bodyMap = null;
  dragState = null;
  window.removeEventListener('resize', onPhysicsResize);
}

function onPhysicsResize() {
  if (!physicsReady) return;
  const jarEl = document.getElementById('physicsJar');
  if (!jarEl) return;
  renderer.options.width = jarEl.offsetWidth;
  renderer.options.height = jarEl.offsetHeight;
  renderer.canvas.width = jarEl.offsetWidth;
  renderer.canvas.height = jarEl.offsetHeight;
}

// ============ DROP TOKEN ============

function dropToken(milestoneId, iconUrl) {
  if (!physicsReady || !iconUrl) return;

  const jarEl = document.getElementById('physicsJar');
  const w = jarEl.offsetWidth || 320;

  const { Bodies, Composite, Body } = Matter;

  const size = 24;
  const x = w / 2 + (Math.random() - 0.5) * 20;
  const y = 20;

  const token = Bodies.circle(x, y, size, {
    restitution: 0.5 + Math.random() * 0.15,
    friction: 0.3 + Math.random() * 0.1,
    frictionAir: 0.015 + Math.random() * 0.008,
    density: 0.002 + Math.random() * 0.001,
    inertia: Infinity,           // ← NO ROTATION
    frictionStatic: 0.3,
    render: { visible: false },  // canvas invisible, DOM handles visuals
  });

  // Small random nudge so coins scatter a bit
  Body.setVelocity(token, { x: (Math.random() - 0.5) * 1, y: 0.5 + Math.random() * 0.5 });

  token.milestoneId = milestoneId;
  Composite.add(engine.world, token);
  placedTokens.add(milestoneId);
  isDirty = true;
  renderTokenBadges();

  // Create DOM element for this token
  const tokenEl = document.createElement('div');
  tokenEl.className = 'placed-token pop-in';
  if (iconUrl) {
    const img = document.createElement('img');
    img.src = iconUrl;
    img.alt = 'token';
    img.style.width = '100%';
    img.style.height = '100%';
    img.style.objectFit = 'contain';
    tokenEl.appendChild(img);
  } else {
    tokenEl.textContent = '🪙';
    tokenEl.style.fontSize = '1.2rem';
  }
  tokenEl.style.position = 'absolute';
  tokenEl.style.left = (x - size) + 'px';
  tokenEl.style.top = (y - size) + 'px';
  tokenEl.style.width = (size * 2) + 'px';
  tokenEl.style.height = (size * 2) + 'px';
  tokenEl.style.borderRadius = '50%';
  tokenEl.style.zIndex = '10';
  tokenEl.style.pointerEvents = 'auto';
  tokenEl.style.cursor = 'grab';
  tokenEl.style.background = 'radial-gradient(circle at 30% 30%, #fce595, #d89612 80%)';
  tokenEl.style.boxShadow = '0 4px 10px rgba(180,120,0,0.38), inset 0 2px 4px rgba(255,255,180,0.5)';
  tokenEl.style.border = '2px solid #fff0b3';
  tokenEl.style.display = 'flex';
  tokenEl.style.alignItems = 'center';
  tokenEl.style.justifyContent = 'center';
  tokenEl.style.overflow = 'hidden';

  // Drag events
  tokenEl.addEventListener('pointerdown', (e) => pointerDown(e, token, tokenEl));

  const tokensLayer = document.getElementById('tokensLayer');
  if (tokensLayer) tokensLayer.appendChild(tokenEl);
  bodyMap.set(token.id, { body: token, el: tokenEl });

  // Sparkles + ripple effect after coin falls a bit
  setTimeout(() => {
    const rect = jarEl.getBoundingClientRect();
    spawnSparkles(rect.left + token.position.x, rect.top + token.position.y);
    doRipple(token.position.x, token.position.y);
  }, 400);
}

function spawnSparkles(screenX, screenY) {
  const layer = document.getElementById('sparkle-layer');
  if (!layer) return;
  const chars = ['✦','✧','★','✦','✧','✦'];
  for (let i = 0; i < 9; i++) {
    const angle = (i / 9) * Math.PI * 2;
    const d = 38 + Math.random() * 34;
    const s = document.createElement('span');
    s.className = 'sparkle';
    s.textContent = chars[i % chars.length];
    s.style.left = (screenX - 6) + 'px';
    s.style.top = (screenY - 6) + 'px';
    s.style.setProperty('--tx', Math.cos(angle) * d + 'px');
    s.style.setProperty('--ty', Math.sin(angle) * d + 'px');
    layer.appendChild(s);
    setTimeout(() => s.remove(), 700);
  }
}

function doRipple(jarX, jarY) {
  const el = document.createElement('div');
  el.className = 'ripple';
  el.style.left = jarX + 'px';
  el.style.top = jarY + 'px';
  const jarEl = document.getElementById('physicsJar');
  if (jarEl) jarEl.appendChild(el);
  setTimeout(() => el.remove(), 700);
}

// ============ SAVE / CLEAR ============

window.saveJarDecoration = async function () {
  if (!userProfile) {
    showToast('No changes to save', 'info');
    return;
  }

  // Collect all tokens currently in physics world from bodyMap
  const currentTokens = new Set(placedTokens);

  const decorations = [];
  currentTokens.forEach(milestoneId => {
    decorations.push({
      user_id: userProfile.id,
      milestone_id: milestoneId,
      x_pos: 50,
      y_pos: 50,
      scale: 1,
    });
  });

  const { error } = await supabase.rpc('save_jar_decorations', {
    p_user_id: userProfile.id,
    p_decorations: decorations,
  });

  if (error) {
    try {
      localStorage.setItem(`jar_deco_${userProfile.id}`, JSON.stringify(
        Array.from(currentTokens).map(id => ({ milestone_id: id, x: 50, y: 50 }))
      ));
      showToast('Jar saved! (local)', 'success');
    } catch { showToast('Failed to save', 'error'); }
  } else {
    showToast('Jar saved! 🏺', 'success');
  }
  isDirty = false;
};

window.clearJarDecoration = function () {
  if (!physicsReady) return;
  if (placedTokens.size === 0) return;
  if (!confirm('Clear all tokens from the jar?')) return;

  const { Composite } = Matter;
  const toRemove = [];
  engine.world.bodies.forEach(b => {
    if (b.milestoneId) toRemove.push(b);
  });
  toRemove.forEach(b => Composite.remove(engine.world, b));

  placedTokens.clear();
  // Clear DOM tokens
  bodyMap.clear();
  const layer = document.getElementById('tokensLayer');
  if (layer) layer.innerHTML = '';
  renderTokenBadges();
  isDirty = true;
  showToast('Jar cleared', 'info');
};
