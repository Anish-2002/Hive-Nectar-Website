// js/nav-auth.js — auth-aware header.
//
// Every page ships the same static nav with a bare "Login to Pollen Pop" link,
// so a signed-in member still reads "Login" in the header. This module swaps
// that link for the signed-in affordances (Profile · My Jar · Log out) as soon
// as a session exists, and keeps both states in sync through onAuthStateChange.
//
// Additive by design: it only rewrites the nav if the nav is present, and it
// degrades to the untouched static link if anything is missing, so pages that
// have no Supabase client (or no session yet) look exactly as they did before.
import { supabase } from './supabase-config.js';

const LOGIN_LINK = 'a[href="login.html"], a[href="./login.html"]';

function buildInMenu(outEl) {
  const box = document.createElement('span');
  box.className = 'nav-auth-in';
  // display:contents means the span itself generates no box, so these links
  // become direct flex items of .nav-links — inheriting the desktop row and the
  // mobile column exactly like the static links do.
  box.style.display = 'none';
  box.innerHTML =
    '<a href="profile.html">My Profile</a>' +
    '<a href="decorator.html">Honey Jar</a>' +
    '<a href="#" class="nav-logout" role="button">Log out</a>';
  outEl.insertAdjacentElement('afterend', box);
  return box;
}

function render(outEl, inEl, signedIn) {
  outEl.style.display = signedIn ? 'none' : '';
  inEl.style.display = signedIn ? 'contents' : 'none';
}

async function main() {
  const nav = document.getElementById('navLinks') || document.querySelector('.nav-links');
  if (!nav) return;                                   // no header on this page
  const outEl = nav.querySelector(LOGIN_LINK) || nav.querySelector('a[href$="login.html"]');
  if (!outEl) return;                                 // header already custom
  const inEl = buildInMenu(outEl);

  inEl.querySelector('.nav-logout').addEventListener('click', async (e) => {
    e.preventDefault();
    try { await supabase.auth.signOut(); } catch (err) { /* already gone */ }
    location.href = 'login.html';
  });

  let session = null;
  try {
    const res = await supabase.auth.getSession();
    session = res && res.data ? res.data.session : null;
  } catch (err) { /* offline: keep the static link */ }
  render(outEl, inEl, !!session);

  try {
    supabase.auth.onAuthStateChange((_event, s) => render(outEl, inEl, !!s));
  } catch (err) { /* older client: the initial state still applies */ }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', main);
} else {
  main();
}
