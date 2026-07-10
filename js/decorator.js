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
    .select('milestone_id, milestones(id, name, icon_url, category)')
    .eq('user_id', userProfile.id);
  if (error) { console.error(error); return; }
  earnedMilestones = (userM || []).map(um => um.milestones).filter(Boolean);
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

      <!-- Jar -->
      <div class="physics-jar" id="physicsJar">
        <div class="glass-reflection"></div>
      </div>
      <div class="firefly" style="top:10%; left:-15%; animation-delay:0s;"></div>
      <div class="firefly" style="top:40%; right:-12%; animation-delay:1.5s;"></div>
      <div class="firefly" style="top:70%; left:-10%; animation-delay:3s;"></div>
      </div>

      <div class="jar-glow"></div>

      <!-- Actions -->
      <div class="jar-actions">
        <button class="btn btn-success" onclick="saveJarDecoration()" style="flex:2;"><i class="fas fa-save"></i> Save</button>
        <button class="btn btn-secondary" onclick="clearJarDecoration()" style="flex:1;"><i class="fas fa-trash"></i> Clear</button>
      </div>
    </div>
  `;

  renderTokenBadges();
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

function initPhysics() {
  const jarEl = document.getElementById('physicsJar');
  if (!jarEl || typeof Matter === 'undefined') return;

  const w = jarEl.offsetWidth || 320;
  const h = jarEl.offsetHeight || 450;

  const { Engine, Render, Runner, Bodies, Body, Composite, Mouse, MouseConstraint, Events } = Matter;

  engine = Engine.create({ gravity: { x: 0, y: 1.2 } });

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

  // Jar boundaries (invisible walls)
  const wallOpts = { isStatic: true, render: { visible: false } };
  const padding = 4;
  const ground = Bodies.rectangle(w / 2, h - padding / 2, w - 20, 8, wallOpts);
  const leftWall = Bodies.rectangle(padding / 2, h / 2, 8, h, wallOpts);
  const rightWall = Bodies.rectangle(w - padding / 2, h / 2, 8, h, wallOpts);
  // Curved bottom approximation — add angled side pieces
  const cornerBounce = 0.3;
  const leftCorner = Bodies.rectangle(w * 0.08, h - 20, 30, 8, { ...wallOpts, angle: 0.2 });
  const rightCorner = Bodies.rectangle(w * 0.92, h - 20, 30, 8, { ...wallOpts, angle: -0.2 });

  jarWalls = [ground, leftWall, rightWall, leftCorner, rightCorner];
  Composite.add(engine.world, jarWalls);

  // Mouse interaction — drag tokens around inside jar
  const mouse = Mouse.create(renderer.canvas);
  const mouseConstraint = MouseConstraint.create(engine, {
    mouse: mouse,
    constraint: { stiffness: 0.2, render: { visible: false } }
  });
  Composite.add(engine.world, mouseConstraint);

  Render.run(renderer);
  runner = Runner.create();
  Runner.run(runner, engine);
  physicsReady = true;

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

  const { Bodies, Composite } = Matter;

  const size = 24; // body radius
  const visualScale = 0.12; // sprite scale (for ~200px source images)
  const x = 60 + Math.random() * (w - 120);
  const y = -30 - Math.random() * 20;

  const token = Bodies.circle(x, y, size, {
    restitution: 0.5,
    friction: 0.3,
    frictionAir: 0.01,
    density: 0.003,
    render: {
      sprite: {
        texture: iconUrl,
        xScale: visualScale,
        yScale: visualScale,
      }
    }
  });

  token.milestoneId = milestoneId;
  Composite.add(engine.world, token);
  placedTokens.add(milestoneId);
  isDirty = true;
  renderTokenBadges();

  // Auto-detect when token settles and mark placed
  setTimeout(() => {
    // Token is in the jar — it stays
  }, 2000);
}

// ============ SAVE / CLEAR ============

window.saveJarDecoration = async function () {
  if (!userProfile) {
    showToast('No changes to save', 'info');
    return;
  }

  // Collect all tokens currently in physics world
  const currentTokens = new Set();
  if (engine) {
    engine.world.bodies.forEach(b => {
      if (b.milestoneId) currentTokens.add(b.milestoneId);
    });
  }
  // Also include any placedTokens that might not be tracked
  placedTokens.forEach(id => currentTokens.add(id));

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
  renderTokenBadges();
  isDirty = true;
  showToast('Jar cleared', 'info');
};
