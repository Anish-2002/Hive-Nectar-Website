/**
 * ============================================================================
 * pwa.js - the profile page as an installable app
 * ============================================================================
 *
 * Responsibilities, all of them confined to the profile page:
 *
 *   1. register /sw.js with scope "/profile.html" (so no other page is ever
 *      served from the cache);
 *   2. offer an "Install app" button: the real prompt where the browser has
 *      one, one-line Add-to-Home-Screen instructions on iOS Safari;
 *   3. tell the member when a new build is live and let them update in place
 *      (worker posts SKIP_WAITING, page reloads once) - a deploy must never
 *      leave an installed app frozen on an old bundle;
 *   4. when the app is opened from the home screen with no session, ask for the
 *      password inside the app instead of redirecting to /login.html, which is
 *      outside the manifest scope and would hand the member to the browser.
 *
 * No emoji, ASCII-only source (the admin verifier enforces it).
 */
import { supabase } from './supabase-config.js';

const SW_URL = '/sw.js';
const SW_SCOPE = '/profile.html';
const SW_ENABLED =
  location.protocol === 'https:' ||
  new URLSearchParams(location.search).has('sw');   // local verification hook

const isStandalone = () =>
  (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) ||
  window.matchMedia('(display-mode: fullscreen)').matches ||
  window.navigator.standalone === true;

const isIOS = () =>
  /iP(hone|ad|od)/.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

/* ------------------------------------------------------------------ styles */
function injectStyles() {
  if (document.getElementById('pwa-style')) return;
  const css = `
  .pwa-row {
    width: 100%; display: flex; align-items: center; justify-content: center;
    gap: 10px; flex-wrap: wrap; margin: 10px 0 2px;
  }
  .pwa-row[hidden] { display: none; }
  .pwa-note { font-size: 12.5px; font-weight: 600; opacity: .75; }
  #pwaUpdate {
    position: fixed; left: 50%; bottom: 18px; transform: translateX(-50%);
    z-index: 9999; display: flex; align-items: center; gap: 12px;
    padding: 11px 14px; border-radius: 14px; max-width: min(92vw, 460px);
    background: #24180c; color: #fff7e6;
    box-shadow: 0 12px 34px rgba(0,0,0,.32);
    font: 600 13.5px/1.35 Inter, system-ui, sans-serif;
  }
  #pwaUpdate[hidden] { display: none; }
  #pwaUpdate span { flex: 1 1 auto; }
  #pwaUpdate button {
    border: 0; border-radius: 10px; padding: 8px 13px; cursor: pointer;
    font: 800 12.5px/1 Inter, system-ui, sans-serif;
  }
  #pwaUpdateBtn { background: #d9a441; color: #24180c; }
  #pwaUpdateLater { background: transparent; color: #d8cdbb; }
  #pwaGate {
    position: fixed; inset: 0; z-index: 10000; display: flex;
    align-items: center; justify-content: center; padding: 18px;
    background: #fff9f0;
    font: 400 15px/1.5 Inter, system-ui, sans-serif;
    overflow-y: auto; -webkit-overflow-scrolling: touch;
    touch-action: pan-y;
  }
  #pwaGate .gate-card {
    width: 100%; max-width: 380px; background: #fff; border-radius: 18px;
    padding: 22px 20px 18px; box-shadow: 0 14px 44px rgba(60,40,10,.16);
    border: 1px solid rgba(200,169,110,.35);
  }
  #pwaGate img.gate-logo { width: 64px; height: 64px; border-radius: 14px; display: block; margin: 0 auto 12px; }
  #pwaGate h2 { margin: 0 0 4px; font: 800 20px/1.25 Inter, system-ui, sans-serif; color: #2b2118; text-align: center; }
  #pwaGate p.gate-sub { margin: 0 0 16px; font-size: 13px; color: #6b6252; text-align: center; }
  #pwaGate label { display: block; font-size: 12.5px; font-weight: 700; color: #4a4033; margin: 12px 0 5px; }
  #pwaGate .input-wrapper { position: relative; }
  #pwaGate .input-wrapper > i {
    position: absolute; left: 14px; top: 50%; transform: translateY(-50%);
    color: #9a8f7d; pointer-events: none; font-size: 14px;
  }
  #pwaGate input {
    width: 100%; box-sizing: border-box; padding: 12px 14px 12px 40px;
    border: 1.5px solid #e2d9c8; border-radius: 12px; background: #fffdf8;
    font: 400 15px/1.2 Inter, system-ui, sans-serif; color: #2b2118;
  }
  #pwaGate input:focus { outline: none; border-color: #b8860b; }
  #pwaGate .input-wrapper.has-pw-toggle input { padding-right: 52px; }
  #pwaGate .pw-toggle {
    position: absolute; right: 6px; top: 50%; transform: translateY(-50%);
    width: 36px; height: 36px; padding: 0; border: 0; border-radius: 10px;
    background: transparent; color: #6b6252; cursor: pointer;
    display: inline-flex; align-items: center; justify-content: center;
  }
  #pwaGate .pw-toggle i { position: static; transform: none; color: inherit; font-size: 15px; pointer-events: none; }
  #pwaGate .gate-err { display: none; margin: 12px 0 0; font-size: 13px; color: #a02c1e; }
  #pwaGate .gate-err.on { display: block; }
  #pwaGate button[type=submit] {
    width: 100%; margin-top: 16px; padding: 13px; border: 0; border-radius: 12px;
    background: #3f6b4f; color: #fff !important; font: 800 14.5px/1 Inter, system-ui, sans-serif;
    cursor: pointer;
  }
  #pwaGate button[type=submit]:disabled { opacity: .6; cursor: default; }
  #pwaGate .gate-links { margin: 14px 0 0; text-align: center; font-size: 12.5px; }
  #pwaGate .gate-links a { color: #8a6a1d; font-weight: 700; text-decoration: none; }
  #pwaGate .gate-switch { margin-top: 6px; }
  `;
  const style = document.createElement('style');
  style.id = 'pwa-style';
  style.textContent = css;
  document.head.appendChild(style);
}

/* --------------------------------------------------------- update banner */
function mountUpdateBanner() {
  if (document.getElementById('pwaUpdate')) return document.getElementById('pwaUpdate');
  const box = document.createElement('div');
  box.id = 'pwaUpdate';
  box.hidden = true;
  box.setAttribute('role', 'status');
  box.innerHTML =
    '<span>New version available</span>' +
    '<button type="button" id="pwaUpdateBtn">Update</button>' +
    '<button type="button" id="pwaUpdateLater">Later</button>';
  document.body.appendChild(box);
  return box;
}

function wireUpdates(reg) {
  const box = mountUpdateBanner();
  const later = box.querySelector('#pwaUpdateLater');
  later.addEventListener('click', () => { box.hidden = true; });

  const offer = (worker) => {
    if (!worker || !navigator.serviceWorker.controller) return;  // first install, nothing to swap
    box.hidden = false;
    box.querySelector('#pwaUpdateBtn').onclick = () => {
      box.hidden = true;
      worker.postMessage({ type: 'SKIP_WAITING' });
    };
  };

  if (reg.waiting) offer(reg.waiting);

  reg.addEventListener('updatefound', () => {
    const incoming = reg.installing;
    if (!incoming) return;
    incoming.addEventListener('statechange', () => {
      if (incoming.state === 'installed') offer(incoming);
    });
  });

  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading) return;
    reloading = true;
    location.reload();
  });

  // Long-lived home-screen sessions never navigate, so poll for a new build.
  const check = () => { reg.update().catch(() => {}); };
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') check();
  });
  setInterval(check, 30 * 60 * 1000);
}

/* --------------------------------------------------------- install button */
function wireInstall() {
  const btn = document.getElementById('pwaInstallBtn');
  const row = document.getElementById('pwaRow');
  if (!btn || !row) return;
  if (isStandalone()) return;                      // already installed

  let prompt = null;
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    prompt = e;
    row.hidden = false;
  });

  window.addEventListener('appinstalled', () => {
    row.hidden = true;
    prompt = null;
  });

  // iOS Safari never fires beforeinstallprompt: show the manual route instead.
  if (isIOS() && !prompt) {
    row.hidden = false;
    const note = row.querySelector('#pwaNote');
    if (note) note.textContent = 'Install: Share, then Add to Home Screen';
  }

  btn.addEventListener('click', async () => {
    if (prompt) {
      prompt.prompt();
      try { await prompt.userChoice; } catch (_) {}
      prompt = null;
      row.hidden = true;
      return;
    }
    const note = row.querySelector('#pwaNote');
    if (note) {
      note.textContent = isIOS()
        ? 'Install: Share, then Add to Home Screen'
        : 'Open this page in Chrome to install it';
    }
  });
}

/* ------------------------------------------------------- standalone login */
function showSignIn() {
  if (document.getElementById('pwaGate')) return;
  injectStyles();

  const gate = document.createElement('div');
  gate.id = 'pwaGate';
  gate.setAttribute('role', 'dialog');
  gate.setAttribute('aria-modal', 'true');
  gate.setAttribute('aria-label', 'Sign in to The Meadow');
  gate.innerHTML = `
    <div class="gate-card">
      <img class="gate-logo" src="icons/icon-192.png" alt="The Meadow" width="64" height="64">
      <h2>Sign in to The Meadow</h2>
      <p class="gate-sub">You stay signed in on this device.</p>
      <form id="pwaGateForm" novalidate>
        <label for="pwaEmail">Email</label>
        <div class="input-wrapper">
          <i class="fas fa-envelope" aria-hidden="true"></i>
          <input id="pwaEmail" type="email" autocomplete="username" inputmode="email" required placeholder="you@example.com">
        </div>
        <label for="pwaPass">Password</label>
        <div class="input-wrapper">
          <i class="fas fa-lock" aria-hidden="true"></i>
          <input id="pwaPass" type="password" autocomplete="current-password" required placeholder="Your password">
        </div>
        <p class="gate-err" id="pwaGateErr" role="alert"></p>
        <button type="submit" id="pwaGateSubmit">Sign in</button>
      </form>
      <div class="gate-links">
        <a href="forgot-password.html" target="_blank" rel="noopener">Forgot password?</a>
        <div class="gate-switch">No account yet? <a href="join.html" target="_blank" rel="noopener">Create one</a></div>
      </div>
    </div>`;
  document.body.appendChild(gate);

  if (window.MeadowPwToggle) window.MeadowPwToggle.init(gate);

  const form = gate.querySelector('#pwaGateForm');
  const err = gate.querySelector('#pwaGateErr');
  const submit = gate.querySelector('#pwaGateSubmit');
  const fail = (msg) => { err.textContent = msg; err.classList.add('on'); };

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.classList.remove('on');
    const email = gate.querySelector('#pwaEmail').value.trim();
    const password = gate.querySelector('#pwaPass').value;
    if (!email || !password) { fail('Enter your email and password.'); return; }
    submit.disabled = true;
    submit.textContent = 'Signing in...';
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) {
      fail(error.message || 'Could not sign in. Check your details.');
      submit.disabled = false;
      submit.textContent = 'Sign in';
      return;
    }
    gate.remove();
    location.replace('profile.html?src=pwa');
  });

  const first = gate.querySelector('#pwaEmail');
  if (first) first.focus({ preventScroll: true });
}

/* --------------------------------------------------------------- register */
function registerWorker() {
  if (!('serviceWorker' in navigator) || !SW_ENABLED) return;
  navigator.serviceWorker.register(SW_URL, { scope: SW_SCOPE })
    .then((reg) => {
      wireUpdates(reg);
      reg.update().catch(() => {});
    })
    .catch((err) => {
      // Never break the page over this: the site works without a worker.
      console.warn('[pwa] service worker registration failed', err && err.message);
    });
}

function init() {
  injectStyles();
  wireInstall();
  registerWorker();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

window.MeadowPwa = { isStandalone, showSignIn, isIOS };
