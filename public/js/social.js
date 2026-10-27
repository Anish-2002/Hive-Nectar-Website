/* Social layer for My Profile — leaderboard, friend search, partner invites by
 * email, and public/private visibility.
 *
 * Everything cross-user goes through the SECURITY DEFINER RPCs created by
 * scripts/sql/2026-10-13-profiles-public-alias-leaderboard.sql.
 * `profiles` RLS is own-row-only, so a direct .from('profiles') query can never
 * see another member — do not "simplify" these calls into table reads.
 *
 * Rules encoded here:
 *   • Private member  -> shown as their ALIAS everywhere (leaderboard, invite,
 *                        profile card). Never name, avatar, tier or task count.
 *   • Public member   -> real name, avatar, tier, tasks, nectar, rank.
 *   • Friend search   -> public profiles only.
 *   • Partner invites -> Collective tier (member_tier >= 3) only; everyone else
 *                        gets the "upgrade to Collective" popup.
 */

import { supabase } from './supabase-config.js';
import { showToast } from './app.js';

const esc = (s) =>
  String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let me = null;          // my own profiles row (own-row RLS permits this read)
let wired = false;

/* ── small helpers ─────────────────────────────────────────────────────── */
async function rpc(fn, args = {}) {
  try {
    const { data, error } = await supabase.rpc(fn, args);
    if (error) { console.warn('[social]', fn, error.message); return { ok: false, error: error.message }; }
    return data && typeof data === 'object' ? data : { ok: true, data };
  } catch (e) {
    console.warn('[social]', fn, e);
    return { ok: false, error: 'network' };
  }
}

const initials = (n) => {
  const t = String(n || '?').trim();
  if (!t) return '?';
  const p = t.split(/\s+/);
  return (p[0][0] + (p[1] ? p[1][0] : '')).toUpperCase();
};

const avatarHtml = (row, cls = 'soc-av') =>
  row && row.avatar
    ? `<img class="${cls}" src="${esc(row.avatar)}" alt="">`
    : `<span class="${cls} soc-av-i">${esc(initials(row && row.display))}</span>`;

const isPrivate = (row) => row && row.is_public === false;
const lockChip = (row) => (isPrivate(row) ? '<span class="soc-lock" title="Private profile"><i class="fas fa-lock"></i> alias</span>' : '');
const nectar = (n) => Number(n || 0).toLocaleString();

function tierLabel(row) {
  const t = row && row.tier ? String(row.tier) : '';
  if (!t || /^tier\s*0$/i.test(t)) return 'Free';
  return t.replace(/^tier\s*/i, 'Tier ').replace(/^\w/, (c) => c.toUpperCase());
}

function upgradePopup() {
  if (typeof window.showCollectiveRequired === 'function') return window.showCollectiveRequired();
  showToast('Partner collaboration is part of the Collective tier.', 'error');
}

/* ── one reusable modal ────────────────────────────────────────────────── */
function ensureModal() {
  let m = document.getElementById('socModal');
  if (m) return m;
  m = document.createElement('div');
  m.id = 'socModal';
  m.className = 'soc-overlay';
  m.hidden = true;
  m.innerHTML = `
    <div class="soc-panel" role="dialog" aria-modal="true" aria-label="Meadow">
      <button type="button" class="soc-x" id="socClose" aria-label="Close">&times;</button>
      <div id="socBody"></div>
    </div>`;
  document.body.appendChild(m);
  m.addEventListener('click', (e) => { if (e.target === m) closeModal(); });
  m.querySelector('#socClose').addEventListener('click', closeModal);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !m.hidden) closeModal();
  });
  return m;
}

function openModal(html) {
  const m = ensureModal();
  m.querySelector('#socBody').innerHTML = html;
  m.hidden = false;
  m.classList.add('on');
  document.body.classList.add('soc-noscroll');
  m.querySelector('.soc-panel').scrollTop = 0;
  return m;
}

function closeModal() {
  const m = document.getElementById('socModal');
  if (!m) return;
  m.hidden = true;
  m.classList.remove('on');
  document.body.classList.remove('soc-noscroll');
}

/* ── shared: a copyable invite link + the usual share targets ──────────── */
function shareBlock(link, headline) {
  const text = encodeURIComponent(`Join me on The Meadow — we'll grow our meadows together\n${link}`);
  const subj = encodeURIComponent('Join me on The Meadow');
  return `
    <div class="soc-share">
      <p class="soc-ok">${esc(headline)}</p>
      <input class="soc-link" readonly value="${esc(link)}" onclick="this.select()">
      <div class="soc-share-row">
        <button type="button" class="soc-sb" data-copy="${esc(link)}" title="Copy link"><i class="fas fa-link"></i></button>
        <a class="soc-sb" target="_blank" rel="noopener" title="WhatsApp"
           href="https://wa.me/?text=${text}"><i class="fab fa-whatsapp"></i></a>
        <a class="soc-sb" target="_blank" rel="noopener" title="Telegram"
           href="https://t.me/share/url?url=${encodeURIComponent(link)}&text=${text}"><i class="fab fa-telegram"></i></a>
        <a class="soc-sb" target="_blank" rel="noopener" title="Email"
           href="mailto:?subject=${subj}&body=${text}"><i class="fas fa-envelope"></i></a>
        <a class="soc-sb" target="_blank" rel="noopener" title="SMS" href="sms:?body=${text}"><i class="fas fa-comment-sms"></i></a>
      </div>
    </div>`;
}

function wireShare(scope) {
  scope.querySelectorAll('[data-copy]').forEach((b) =>
    b.addEventListener('click', async () => {
      const v = b.getAttribute('data-copy');
      try {
        if (navigator.share) await navigator.share({ title: 'The Meadow', text: 'Join me on The Meadow', url: v });
        else { await navigator.clipboard.writeText(v); showToast('Link copied!', 'success'); }
      } catch (_) { /* user dismissed */ }
    }));
}

/* ── leaderboard ───────────────────────────────────────────────────────── */
async function openLeaderboard() {
  openModal('<p class="soc-load">Loading the meadow…</p>');
  const d = await rpc('get_leaderboard', { p_limit: 50 });
  const body = document.getElementById('socBody');
  if (!body) return;
  if (!d || d.ok === false || !Array.isArray(d.rows)) {
    body.innerHTML = '<p class="soc-load">Leaderboard is unavailable right now.</p>';
    return;
  }
  const meRow = d.me && d.me.rank ? `<p class="soc-sub">You are <b>#${d.me.rank}</b> of ${nectar(d.total)} with <b>${nectar(d.me.nectar)}</b> nectar.</p>` : '';
  // Keep the "Meadow rank" stat card identical to the leaderboard it opens.
  // Keep the rank badges in step with the leaderboard the member is looking at:
  // same RANK() server-side, one paint for the desktop and mobile cards.
  if (d.me && d.me.rank) {
    const text = `#${d.me.rank}`;
    const rankEl = document.getElementById('rankLevel');
    if (rankEl) rankEl.innerText = text;
    const mobileRankEl = document.getElementById('mobileRankLevel');
    if (mobileRankEl) mobileRankEl.innerText = text;
  }
  const rows = d.rows.map((r) => `
    <button type="button" class="soc-row${r.is_me ? ' me' : ''}" data-uid="${esc(r.id)}">
      <span class="soc-rank${r.rank <= 3 ? ' top' : ''}">${r.rank}</span>
      ${avatarHtml(r)}
      <span class="soc-mid">
        <b>${esc(r.display)}${r.is_me ? ' <small>(you)</small>' : ''}</b>
        <small>${esc(tierLabel(r))} · ${nectar(r.tasks_done)} tasks${lockChip(r)}</small>
      </span>
      <span class="soc-right"><b>${nectar(r.nectar)}</b><small>nectar</small></span>
    </button>`).join('');
  body.innerHTML = `
    <h3 class="soc-h"><i class="fas fa-trophy"></i> Meadow leaderboard</h3>
    <p class="soc-sub">Everyone ranked by nectar gathered. Private profiles appear under their alias.</p>
    ${meRow}
    <div class="soc-list">${rows || '<p class="soc-load">No members ranked yet.</p>'}</div>`;
  body.querySelectorAll('[data-uid]').forEach((b) =>
    b.addEventListener('click', () => openProfileCard(b.getAttribute('data-uid'))));
}

/* ── one member's card ─────────────────────────────────────────────────── */
async function openProfileCard(id) {
  openModal('<p class="soc-load">Opening profile…</p>');
  const d = await rpc('get_public_profile', { p_id: id });
  const body = document.getElementById('socBody');
  if (!body) return;
  if (!d || d.ok === false) {
    body.innerHTML = '<p class="soc-load">That member could not be found.</p>';
    return;
  }
  const priv = isPrivate(d);
  const stat = (k, v) => `<div class="soc-cell"><span>${k}</span><b>${v}</b></div>`;
  body.innerHTML = `
    <div class="soc-card-head">
      ${avatarHtml(d, 'soc-av big')}
      <div>
        <h3 class="soc-h">${esc(d.display)}${d.is_me ? ' <small>(you)</small>' : ''}</h3>
        <p class="soc-sub">${priv
          ? '<i class="fas fa-lock"></i> Private profile — shown as an alias'
          : `${esc(tierLabel(d))}${d.member_status ? ' · ' + esc(d.member_status) : ''}`}</p>
      </div>
    </div>
    <div class="soc-grid">
      ${stat('Nectar gathered', nectar(d.nectar))}
      ${stat('Meadow rank', d.rank ? '#' + d.rank : '—')}
      ${priv ? '' : stat('Tasks completed', nectar(d.tasks_done))}
      ${priv ? '' : stat('CO₂e saved', nectar(Number(d.co2e || 0).toFixed(0)))}
      ${priv || !d.stage ? '' : stat('Stage', esc(d.stage))}
      ${priv || !d.join_date ? '' : stat('Growing since', esc(new Date(d.join_date).toLocaleDateString()))}
    </div>
    ${priv ? '<p class="soc-note">This member keeps their meadow private, so only their alias, nectar and rank are visible.</p>' : ''}`;
}

/* ── friend search (public profiles only) ──────────────────────────────── */
async function runSearch(q) {
  const box = document.getElementById('friendResults');
  if (!box) return;
  if (!q || q.trim().length < 2) {
    box.innerHTML = '<p class="empty">Type at least 2 letters to search.</p>';
    return;
  }
  box.innerHTML = '<p class="soc-load">Searching…</p>';
  const d = await rpc('search_public_profiles', { p_query: q.trim(), p_limit: 20 });
  if (!d || d.ok === false) { box.innerHTML = '<p class="empty">Search failed — try again.</p>'; return; }
  if (d.need_more) { box.innerHTML = '<p class="empty">Type at least 2 letters to search.</p>'; return; }
  const rows = d.rows || [];
  if (!rows.length) {
    box.innerHTML = `<p class="empty">No public profile matches “${esc(q.trim())}”.</p>`;
    return;
  }
  box.innerHTML = rows.map((r) => `
    <button type="button" class="soc-row" data-uid="${esc(r.id)}">
      ${avatarHtml(r)}
      <span class="soc-mid"><b>${esc(r.display)}${r.is_me ? ' <small>(you)</small>' : ''}</b>
        <small>${esc(tierLabel(r))} · ${nectar(r.tasks_done)} tasks</small></span>
      <span class="soc-right"><b>${nectar(r.nectar)}</b><small>nectar</small></span>
    </button>`).join('');
  box.querySelectorAll('[data-uid]').forEach((b) =>
    b.addEventListener('click', () => openProfileCard(b.getAttribute('data-uid'))));
}

/* Re-read just the tier so the gate never depends on a page-load value. */
async function refreshTier() {
  if (!me || !me.id) return;
  try {
    const { data } = await supabase
      .from('profiles').select('member_tier,tier,is_public,alias')
      .eq('id', me.id).maybeSingle();
    if (data) Object.assign(me, data);
  } catch (e) { console.warn('[social] refreshTier', e); }
}

/* ── invite a partner by email (Collective only) ───────────────────────── */
async function openInviteByEmail() {
  // member_tier can change while this page is open (the user may upgrade in
  // another tab), so re-read it before gating — a stale cache would lock a
  // freshly-upgraded Collective member out until reload. The invite RPC
  // enforces the same rule server-side; this check is only for the UX.
  await refreshTier();
  if (!me || Number(me.member_tier || 0) < 3) return upgradePopup();
  const m = openModal(`
    <h3 class="soc-h"><i class="fas fa-handshake"></i> Invite a partner</h3>
    <p class="soc-sub">Enter your partner's or colleague's email. If they're already here you can invite them straight away — if not, we'll set up an invite that asks them to join.</p>
    <div class="soc-search">
      <input id="invEmail" type="email" placeholder="name@example.com" autocomplete="off" inputmode="email">
      <button type="button" class="btn pri" id="invCheck">Check</button>
    </div>
    <div id="invResult" class="soc-result"></div>`);
  const input = m.querySelector('#invEmail');
  const out = m.querySelector('#invResult');
  const go = () => checkEmail(input.value, out);
  m.querySelector('#invCheck').addEventListener('click', go);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); go(); } });
  setTimeout(() => input.focus(), 60);
}

async function checkEmail(email, out) {
  const addr = String(email || '').trim();
  if (!addr) return;
  out.innerHTML = '<p class="soc-load">Looking them up…</p>';
  const d = await rpc('lookup_member_for_invite', { p_email: addr });
  if (d.ok === false) {
    if (d.error === 'tier') { closeModal(); return upgradePopup(); }
    out.innerHTML = `<p class="soc-bad">${d.error === 'bad_email'
      ? 'That does not look like an email address.'
      : 'Lookup failed — try again.'}</p>`;
    return;
  }
  if (d.self) { out.innerHTML = '<p class="soc-note">That is your own address</p>'; return; }

  const row = { display: d.display, avatar: null, is_public: d.is_public };
  if (d.member) {
    const state = d.already_partner
      ? '<p class="soc-ok">You are already growing together.</p>'
      : d.pending_invite
        ? '<p class="soc-note">An invite is already waiting for them.</p><div id="invLink"></div>'
        : `<button type="button" class="btn pri" id="invSend">Invite ${esc(d.display || 'them')}</button>`;
    out.innerHTML = `
      <div class="soc-found">
        ${avatarHtml(row)}
        <span class="soc-mid"><b>${esc(d.display)}</b>
          <small>Already on The Meadow${isPrivate(row) ? ' · private' : ''}</small></span>
      </div>${state}`;
    const b = out.querySelector('#invSend');
    if (b) b.addEventListener('click', () => sendInvite(addr, out, `${d.display} is on The Meadow`));
  } else {
    out.innerHTML = `
      <div class="soc-found">
        <span class="soc-av soc-av-i"><i class="fas fa-envelope"></i></span>
        <span class="soc-mid"><b>Not on The Meadow yet</b>
          <small>We'll send them a link that sets up your pairing as they join.</small></span>
      </div>
      <button type="button" class="btn pri" id="invSend">Create join invite</button>`;
    out.querySelector('#invSend').addEventListener('click', () =>
      sendInvite(addr, out, 'Invite ready — send it to them to join'));
  }
}

async function sendInvite(email, out, headline) {
  out.querySelector('#invSend')?.setAttribute('disabled', 'disabled');
  const d = await rpc('create_directed_collab_invite', { p_email: email });
  if (d.ok === false || !d.code) {
    if (d.error === 'tier') { closeModal(); return upgradePopup(); }
    out.innerHTML = `<p class="soc-bad">Could not create the invite${d.error === 'self' ? ' — that is your own address' : ''}.</p>`;
    return;
  }
  const link = `${location.origin}${location.pathname.replace(/[^/]*$/, '')}collaborate.html?code=${encodeURIComponent(d.code)}`;
  out.innerHTML = shareBlock(link, headline);
  wireShare(out);
}

/* ── my visibility (used on the profile card + the edit sheet) ─────────── */
function privacyLine() {
  if (!me) return '';
  const pub = me.is_public === true;
  return `
    <div class="soc-privacy">
      <span>${pub ? '<i class="fas fa-globe"></i> Your profile is <b>Public</b>' : `<i class="fas fa-lock"></i> Private — you appear as <b>${esc(me.alias || 'an alias')}</b>`}</span>
      <button type="button" class="soc-mini" id="socPrivacyBtn">${pub ? 'Make private' : 'Change'}</button>
    </div>`;
}

function wirePrivacyBtn(scope) {
  const b = scope.querySelector('#socPrivacyBtn');
  if (!b) return;
  b.addEventListener('click', () => {
    if (typeof window.openEditProfileSheet === 'function') window.openEditProfileSheet();
    setTimeout(() => document.getElementById('visPublic')?.focus(), 320);
  });
}

/* Visibility block injected into the existing Edit Profile sheet. It saves on
 * its own, so it cannot interfere with the sheet's own Save button. */
function buildVisibilityBlock() {
  if (!me) return;
  const pub = me.is_public === true;
  const wrap = document.createElement('div');
  wrap.id = 'visBlock';
  wrap.className = 'vis-block';
  wrap.innerHTML = `
    <h4>Profile visibility</h4>
    <div class="vis-seg" role="group" aria-label="Profile visibility">
      <button type="button" class="vis-opt" id="visPublic" data-v="1" aria-pressed="${pub}">Public</button>
      <button type="button" class="vis-opt" id="visPrivate" data-v="0" aria-pressed="${!pub}">Private</button>
    </div>
    <p class="vis-hint" id="visHint"></p>
    <div id="visAliasWrap" ${pub ? 'hidden' : ''}>
      <label for="visAlias">Your alias</label>
      <input id="visAlias" type="text" maxlength="24" placeholder="e.g. Honeybee" value="${esc(me.alias || '')}">
      <p class="vis-hint">Members see this alias instead of your name while you're private.</p>
    </div>
    <p class="vis-msg" id="visMsg"></p>
    <button type="button" class="btn pri" id="visSave">Save visibility</button>`;

  const hint = () => {
    const isPub = wrap.querySelector('#visPublic').getAttribute('aria-pressed') === 'true';
    wrap.querySelector('#visHint').textContent = isPub
      ? 'Anyone can find you in friend search and see your nectar, tier and completed tasks.'
      : 'Friend search hides you. You appear in the leaderboard, invites and profile cards under your alias only.';
    wrap.querySelector('#visAliasWrap').hidden = isPub;
  };

  wrap.querySelectorAll('.vis-opt').forEach((b) =>
    b.addEventListener('click', () => {
      wrap.querySelectorAll('.vis-opt').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      hint();
    }));
  hint();

  wrap.querySelector('#visSave').addEventListener('click', async (e) => {
    e.preventDefault();
    const isPub = wrap.querySelector('#visPublic').getAttribute('aria-pressed') === 'true';
    const alias = wrap.querySelector('#visAlias').value.trim();
    const msg = wrap.querySelector('#visMsg');
    if (!isPub && alias.length < 3) {
      msg.textContent = 'Please choose an alias of at least 3 characters.';
      msg.className = 'vis-msg bad';
      return;
    }
    e.target.setAttribute('disabled', 'disabled');
    const d = await rpc('set_profile_visibility', { p_public: isPub, p_alias: alias || null });
    e.target.removeAttribute('disabled');
    if (d.ok === false) {
      msg.textContent = d.error === 'alias_taken' ? 'That alias is taken — try another.'
        : d.error === 'alias_required' ? 'An alias is required while your profile is private.'
        : 'Could not save — try again.';
      msg.className = 'vis-msg bad';
      return;
    }
    me.is_public = d.is_public;
    if (d.alias) me.alias = d.alias;
    msg.textContent = d.is_public ? 'Profile is public.' : `Profile is private — shown as ${d.alias}.`;
    msg.className = 'vis-msg ok';
    showToast(d.is_public ? 'Profile is now public' : 'Profile is now private', 'success');
    refreshPrivacyLine();
  });

  const content = document.querySelector('#editProfileSheet .bottom-sheet-content');
  if (content) content.prepend(wrap);
}

function refreshPrivacyLine() {
  const host = document.getElementById('myPrivacy');
  if (host) { host.innerHTML = privacyLine(); wirePrivacyBtn(host); }
}

/* ── wiring ────────────────────────────────────────────────────────────── */
function injectUI() {
  // 1. leaderboard trigger in the hero actions
  const heroActions = document.querySelector('body.page-profile .hero-actions');
  if (heroActions && !document.getElementById('lbBtn')) {
    const b = document.createElement('button');
    b.type = 'button';
    b.id = 'lbBtn';
    b.className = 'btn sec';
    b.innerHTML = '<i class="fas fa-ranking-star"></i> Leaderboard';
    b.addEventListener('click', openLeaderboard);
    heroActions.appendChild(b);
  }

  // 2. the "Meadow rank" stat card opens the same leaderboard
  const rank = document.getElementById('rankLevel');
  const rankCard = rank && rank.closest('.sc');
  if (rankCard && !rankCard.dataset.lbWired) {
    rankCard.dataset.lbWired = '1';
    rankCard.classList.add('clickable');
    rankCard.setAttribute('role', 'button');
    rankCard.setAttribute('tabindex', '0');
    rankCard.addEventListener('click', openLeaderboard);
    rankCard.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openLeaderboard(); }
    });
  }

  // 3. Find friends card, right under the partner card
  const aside = document.querySelector('body.page-profile aside.right');
  if (aside && !document.getElementById('friendsCard')) {
    const card = document.createElement('div');
    card.className = 'card box';
    card.id = 'friendsCard';
    card.innerHTML = `
      <span class="eb">Find friends</span>
      <div class="soc-search">
        <input id="friendQ" type="search" placeholder="Search public profiles…" autocomplete="off">
      </div>
      <div id="friendResults" class="soc-list">
        <p class="empty">Members who set their profile public can be found here.</p>
      </div>
      <div id="myPrivacy"></div>`;
    aside.appendChild(card);

    let t = null;
    const input = card.querySelector('#friendQ');
    const run = () => runSearch(input.value);
    input.addEventListener('input', () => { clearTimeout(t); t = setTimeout(run, 350); });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); clearTimeout(t); run(); } });
  }

  refreshPrivacyLine();
}

export async function initSocial() {
  try {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) return;                       // signed-out: nothing to show

    const { data: profile } = await supabase
      .from('profiles')
      .select('id, first_name, last_name, username, alias, is_public, member_tier, nectar_points, total_tasks_completed, tier, avatar_url')
      .eq('id', session.user.id)
      .single();
    me = profile || { id: session.user.id, is_public: false, member_tier: 0 };

    const mount = () => {
      if (wired) return;
      wired = true;
      injectUI();
      buildVisibilityBlock();
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
    else mount();

    // the edit sheet is created by profile.html's inline script; wait for it
    setTimeout(() => { if (!wired) mount(); }, 900);

    // Privacy and tier can change from another tab (or another device), so
    // re-read them when this tab returns to the foreground instead of trusting
    // values captured at page load.
    document.addEventListener('visibilitychange', async () => {
      if (document.hidden) return;
      await refreshTier();
      refreshPrivacyLine();
    });
  } catch (e) {
    console.warn('[social] init failed', e);
  }
}

// exposed for the invite button + anything else that needs them
window.openInviteByEmail = openInviteByEmail;
window.openLeaderboard = openLeaderboard;
window.openProfileCard = openProfileCard;
window.socialMe = () => me;

initSocial();
