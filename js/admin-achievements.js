import { supabase } from './supabase-config.js';

// Simple toast
function showToast(msg, type = 'info') {
  const container = document.getElementById('toast-container');
  if (!container) return;
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.textContent = msg;
  container.appendChild(el);
  setTimeout(() => { el.remove(); }, 3000);
}

async function init() {
  const loader = document.getElementById('global-loader');
  if (loader) loader.style.display = 'flex';
  // Auth check — only admin email can access
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    window.location.href = 'login.html';
    return;
  }
  const adminEmail = document.getElementById('adminEmail');
  if (adminEmail) adminEmail.textContent = `Logged in as: ${user.email}`;

  // Check if admin (only anhishgautam@gmail.com)
  if (user.email !== 'anhishgautam@gmail.com') {
    document.querySelector('main').innerHTML = `
      <div class="card" style="padding: 50px; text-align: center;">
        <i class="fas fa-lock" style="font-size: 3rem; color: var(--cta); margin-bottom: 20px;"></i>
        <h2>Admin Only</h2>
        <p class="tiny muted">You need an admin account to access this page.</p>
        <a href="profile.html" class="btn" style="margin-top: 20px;">Back to Profile</a>
      </div>
    `;
    if (loader) loader.style.display = 'none';
    document.body.classList.remove('data-loading');
    return;
  }

  try {
    await loadMilestones();
    await loadTokens();
  } catch (e) {
    console.error('init error:', e);
  } finally {
    if (loader) loader.style.display = 'none';
    document.body.classList.remove('data-loading');
  }
}

async function loadMilestones() {
  const { data, error } = await supabase
    .from('milestones')
    .select('*')
    .order('category', { ascending: true })
    .order('requirement_value', { ascending: true });

  if (error) {
    document.getElementById('milestonesBody').innerHTML =
      `<tr><td colspan="5" class="tiny muted">Error loading milestones: ${error.message}</td></tr>`;
    return;
  }

  document.getElementById('milestonesCount').textContent = `(${data.length} total)`;
  const tbody = document.getElementById('milestonesBody');
  tbody.innerHTML = data.map(m => `
    <tr>
      <td style="text-align: center;">${m.id}</td>
      <td><strong>${m.name}</strong></td>
      <td><span class="tiny">${m.category}</span></td>
      <td><span class="tiny">${m.requirement_value}</span></td>
      <td style="text-align: center;">
        <label class="switch" data-type="milestone" data-id="${m.id}" data-active="${m.active !== false}">
          <input type="checkbox" ${m.active !== false ? 'checked' : ''} onchange="toggleActive(this)">
          <span class="switch-slider"></span>
        </label>
      </td>
    </tr>
  `).join('');
}

async function loadTokens() {
  const { data, error } = await supabase
    .from('tokens')
    .select('*')
    .order('theme_id', { ascending: true })
    .order('stage', { ascending: true });

  if (error) {
    document.getElementById('tokensBody').innerHTML =
      `<tr><td colspan="6" class="tiny muted">Error loading tokens: ${error.message}</td></tr>`;
    return;
  }

  document.getElementById('tokensCount').textContent = `(${data.length} total)`;
  const tbody = document.getElementById('tokensBody');
  tbody.innerHTML = data.map((t, i) => `
    <tr>
      <td style="text-align: center;">${i + 1}</td>
      <td><strong>${t.name}</strong></td>
      <td><span class="tiny">${t.theme_id}</span></td>
      <td><span class="tiny">${t.stage}</span></td>
      <td><span class="tiny">${t.tasks_required}</span></td>
      <td style="text-align: center;">
        <label class="switch" data-type="token" data-id="${t.id}" data-active="${t.active !== false}">
          <input type="checkbox" ${t.active !== false ? 'checked' : ''} onchange="toggleActive(this)">
          <span class="switch-slider"></span>
        </label>
      </td>
    </tr>
  `).join('');
}

window.toggleActive = async function(checkbox) {
  const label = checkbox.closest('.switch');
  const type = label.dataset.type;       // 'milestone' or 'token'
  const id = label.dataset.id;
  const newActive = checkbox.checked;

  // Optimistic UI — disable toggle during save
  checkbox.disabled = true;

  const table = type === 'milestone' ? 'milestones' : 'tokens';
  const idColumn = type === 'milestone' ? 'id' : 'id';
  const idValue = type === 'milestone' ? parseInt(id) : id;

  const { error } = await supabase
    .from(table)
    .update({ active: newActive })
    .eq(idColumn, idValue);

  checkbox.disabled = false;

  if (error) {
    // Revert checkbox on error
    checkbox.checked = !newActive;
    showToast(`Failed to update ${type}: ${error.message}`, 'error');
    return;
  }

  showToast(`${type === 'milestone' ? 'Milestone' : 'Token'} ${newActive ? 'activated' : 'deactivated'}`, 'success');
  label.dataset.active = String(newActive);
};

init();
