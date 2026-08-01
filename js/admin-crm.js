import { supabase } from './supabase-config.js';
import { Loader } from './app.js';
import { getConfig, sendEmail } from './config.js';

// ======================== TOAST ========================
function toast(msg, type = 'info') {
  const c = document.getElementById('toast-container');
  if (!c) return;
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.textContent = msg;
  c.appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

// ======================== AUTH ========================
let currentUser = null;
let isAdminUser = false;

async function checkAuth() {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) { window.location.href = 'login.html'; return; }
  currentUser = user;

  // Check admin status via RPC
  const { data: admin, error } = await supabase.rpc('is_admin', { p_user_id: user.id });
  if (error || !admin) {
    document.querySelector('.crm-wrap').innerHTML = `
      <div class="card" style="padding:60px;text-align:center;grid-column:1/-1;">
        <i class="fas fa-lock" style="font-size:3rem;color:var(--cta);margin-bottom:20px;"></i>
        <h2>Access Denied</h2>
        <p class="tiny muted" style="margin:12px 0;">Your account (${user.email}) is not in the admin list.</p>
        <a href="profile.html" class="btn">Back to Profile</a>
      </div>`;
    Loader.hide();
    document.body.classList.remove('data-loading');
    return;
  }
  isAdminUser = true;
  document.title = `CRM — ${user.email}`;
  initCRM();
}

// ======================== NAVIGATION ========================
function switchLayer(id) {
  document.querySelectorAll('.crm-layer').forEach(l => l.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  document.getElementById(`layer-${id}`)?.classList.add('active');
  const nav = document.querySelector(`.nav-item[data-layer="${id}"]`);
  if (nav) nav.classList.add('active');
}
document.querySelectorAll('.nav-item[data-layer]').forEach(el => {
  el.addEventListener('click', () => switchLayer(el.dataset.layer));
});

// ======================== DASHBOARD ========================
async function loadDashboard() {
  const { data, error } = await supabase.rpc('get_admin_stats');
  if (error || !data) { toast('Failed to load stats', 'error'); return; }
  const s = typeof data === 'string' ? JSON.parse(data) : data;
  const cards = [
    ['Users', s.total_users || 0, 'fa-users'],
    ['Active Subs', s.active_subscribers || 0, 'fa-star'],
    ['Tasks Done', s.total_tasks_completed || 0, 'fa-check'],
    ['Nectar Earned', s.total_nectar_earned || 0, 'fa-leaf'],
    ['Milestones', s.total_milestones_earned || 0, 'fa-trophy'],
    ['Tokens', s.total_tokens_earned || 0, 'fa-gem'],
    ['Unread Inquiries', s.unread_inquiries || 0, 'fa-inbox'],
    ['New (7d)', s.recent_signups_7d || 0, 'fa-user-plus'],
  ];
  document.getElementById('statsGrid').innerHTML = cards.map(([label, num, icon]) => `
    <div class="stat-card">
      <i class="fas ${icon}" style="font-size:1.2rem;color:var(--primary);margin-bottom:8px;"></i>
      <div class="num">${num}</div>
      <div class="label">${label}</div>
    </div>`).join('');
}

// ======================== USERS ========================
let allUsers = [];
let userSearchTimer = null;

async function loadUsers() {
  const { data, error } = await supabase
    .from('profiles')
    .select('id, first_name, last_name, username, email, join_date, tier, nectar_points, total_tasks_completed, subscription_status, subscription_tier')
    .order('join_date', { ascending: false });
  if (error) { toast('Failed to load users', 'error'); return; }
  allUsers = data || [];
  renderUsers(allUsers);
}

function renderUsers(list) {
  document.getElementById('usersBody').innerHTML = list.map(u => `
    <tr>
      <td class="clickable" onclick="showUserDetail('${u.id}')"><strong>${u.first_name || u.username || '—'}</strong></td>
      <td>${u.email || ''}</td>
      <td class="tiny">${u.join_date ? new Date(u.join_date).toLocaleDateString() : '—'}</td>
      <td><span class="pill ${u.tier || 'free'}">${u.tier || 'free'}</span></td>
      <td>${u.nectar_points || 0}</td>
      <td>${u.total_tasks_completed || 0}</td>
      <td>${u.subscription_status ? `<span class="pill ${u.subscription_status}">${u.subscription_status}</span>` : '—'}</td>
      <td>
        <button class="btn btn-secondary" style="padding:4px 10px;font-size:0.75rem;" onclick="showUserDetail('${u.id}')">
          <i class="fas fa-eye"></i>
        </button>
      </td>
    </tr>`).join('');
}

document.getElementById('userSearch')?.addEventListener('input', e => {
  clearTimeout(userSearchTimer);
  userSearchTimer = setTimeout(() => {
    const q = e.target.value.toLowerCase();
    const filtered = allUsers.filter(u =>
      (u.first_name || '').toLowerCase().includes(q) ||
      (u.email || '').toLowerCase().includes(q) ||
      (u.username || '').toLowerCase().includes(q)
    );
    renderUsers(filtered);
  }, 250);
});

window.showUserDetail = async (userId) => {
  const panel = document.getElementById('userDetail');
  const u = allUsers.find(x => x.id === userId);
  if (!u) return;

  // Load milestones + tokens
  const [{ data: userM }, { data: userT }, { data: userTasks }] = await Promise.all([
    supabase.from('user_milestones').select('milestone_id').eq('user_id', userId),
    supabase.from('user_tokens').select('token_id').eq('user_id', userId),
    supabase.from('user_tasks').select('task_id, completed_at').eq('user_id', userId).order('completed_at', { ascending: false }),
  ]);

  panel.classList.add('open');
  panel.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:start;margin-bottom:8px;">
      <h3 style="margin:0;">${u.first_name || u.username || 'User'}</h3>
      <button class="btn btn-secondary" style="padding:4px 10px;font-size:0.75rem;" onclick="document.getElementById('userDetail').classList.remove('open')"><i class="fas fa-times"></i></button>
    </div>
    <p class="tiny muted">${u.email || ''} — Joined ${u.join_date ? new Date(u.join_date).toLocaleDateString() : '?'}</p>
    <div class="user-detail-grid">
      <div class="field">Tier <div class="val">${u.tier || 'free'}</div></div>
      <div class="field">Sub Status <div class="val">${u.subscription_status || '—'}</div></div>
      <div class="field">Nectar Points <div class="val">${u.nectar_points || 0}</div></div>
      <div class="field">Tasks Done <div class="val">${u.total_tasks_completed || 0}</div></div>
      <div class="field">Milestones <div class="val">${userM?.length || 0}</div></div>
      <div class="field">Tokens <div class="val">${userT?.length || 0}</div></div>
    </div>
    ${userTasks?.length ? `
      <p style="font-size:0.85rem;font-weight:600;margin:12px 0 4px;">Recent Tasks</p>
      ${userTasks.slice(0, 5).map(t => `<div class="tiny muted">• ${t.task_id} — ${new Date(t.completed_at).toLocaleDateString()}</div>`).join('')}
    ` : ''}
    <div style="display:flex;gap:8px;margin-top:16px;flex-wrap:wrap;">
      <button class="btn btn-secondary" style="padding:6px 14px;font-size:0.8rem;" onclick="awardPoints('${userId}')"><i class="fas fa-plus"></i> Award Points</button>
      <button class="btn btn-secondary" style="padding:6px 14px;font-size:0.8rem;" onclick="changeUserTier('${userId}')"><i class="fas fa-tag"></i> Change Tier</button>
    </div>`;
};

window.awardPoints = async (userId) => {
  const amount = prompt('How many nectar points to add?', '10');
  if (!amount || isNaN(amount)) return;
  const { data: p } = await supabase.from('profiles').select('nectar_points').eq('id', userId).single();
  const pts = (p?.nectar_points || 0) + parseInt(amount);
  await supabase.from('profiles').update({ nectar_points: pts }).eq('id', userId);
  toast(`Added ${amount} points`, 'success');
  loadUsers();
  showUserDetail(userId);
};

window.changeUserTier = async (userId) => {
  const tier = prompt('Enter tier (free / plus / steward / collective):', 'free');
  if (!tier || !['free', 'plus', 'steward', 'collective'].includes(tier)) return;
  const updates = { tier };
  // If downgrading to free, clear subscription data too
  if (tier === 'free') {
    updates.subscription_status = null;
    updates.subscription_tier = null;
    updates.stripe_subscription_id = null;
    updates.subscription_current_period_end = null;
    updates.subscription_cancel_at_period_end = false;
  }
  await supabase.from('profiles').update(updates).eq('id', userId);
  toast(`Tier changed to ${tier}`, 'success');
  loadUsers();
  showUserDetail(userId);
};

// ======================== TASKS ========================
let allTasks = [];
let editingTaskId = null;

async function loadTasks() {
  const { data, error } = await supabase.from('tasks')
    .select('*')
    .order('task_order', { ascending: true });
  if (error) { toast('Failed to load tasks', 'error'); return; }
  allTasks = data || [];
  document.getElementById('tasksBody').innerHTML = (data || []).map(t => `
    <tr>
      <td>${t.task_id || ''}</td>
      <td><strong>${t.task_title || ''}</strong></td>
      <td class="tiny">${t.core_theme || t.theme_id || ''}</td>
      <td class="tiny">${t.stage || ''}</td>
      <td>${t.nectar_reward || 0}</td>
      <td>${t.task_order || 0}</td>
      <td style="text-align:center;">
        <label class="switch">
          <input type="checkbox" ${t.active !== false ? 'checked' : ''} onchange="toggleTaskActive('${t.id}', this.checked)">
          <span class="switch-slider"></span>
        </label>
      </td>
      <td>
        <button class="btn btn-secondary" style="padding:3px 8px;font-size:0.7rem;" onclick="editTask('${t.id}')"><i class="fas fa-edit"></i></button>
        <button class="btn btn-secondary" style="padding:3px 8px;font-size:0.7rem;" onclick="deleteTask('${t.id}')"><i class="fas fa-trash"></i></button>
      </td>
    </tr>`).join('');
}

window.toggleTaskActive = async (id, active) => {
  const { error } = await supabase.from('tasks').update({ active }).eq('id', id);
  if (error) toast('Failed to update', 'error');
};

window.editTask = (id) => {
  const t = allTasks.find(x => x.id === id);
  if (!t) return;
  editingTaskId = id;
  document.getElementById('taskModalTitle').textContent = 'Edit Task';
  document.getElementById('taskTitle').value = t.task_title || '';
  document.getElementById('taskDesc').value = t.task_description || '';
  document.getElementById('taskTheme').value = t.theme_id || 'T01';
  document.getElementById('taskStage').value = t.stage || '🌰 Seeds';
  document.getElementById('taskPoints').value = t.nectar_reward || 10;
  document.getElementById('taskOrder').value = t.task_order || 1;
  document.getElementById('taskCoreTheme').value = t.core_theme || '';
  document.getElementById('taskModal').classList.add('open');
};

window.openTaskModal = () => {
  editingTaskId = null;
  document.getElementById('taskModalTitle').textContent = 'New Task';
  ['taskTitle','taskDesc','taskTheme','taskStage','taskPoints','taskOrder','taskCoreTheme'].forEach(id =>
    document.getElementById(id).value = id === 'taskPoints' ? '10' : id === 'taskOrder' ? '1' : id === 'taskTheme' ? 'T01' : id === 'taskStage' ? '🌰 Seeds' : ''
  );
  document.getElementById('taskModal').classList.add('open');
};

window.closeTaskModal = () => document.getElementById('taskModal').classList.remove('open');

window.saveTask = async () => {
  const data = {
    task_title: document.getElementById('taskTitle').value,
    task_description: document.getElementById('taskDesc').value,
    theme_id: document.getElementById('taskTheme').value,
    stage: document.getElementById('taskStage').value,
    nectar_reward: parseInt(document.getElementById('taskPoints').value) || 10,
    task_order: parseInt(document.getElementById('taskOrder').value) || 1,
    core_theme: document.getElementById('taskCoreTheme').value,
  };
  if (!data.task_title) { toast('Title is required', 'error'); return; }

  if (editingTaskId) {
    await supabase.from('tasks').update(data).eq('id', editingTaskId);
    toast('Task updated', 'success');
  } else {
    data.active = true;
    // Find the highest existing task_id number to avoid duplicates when tasks are deleted
    let maxNum = 0;
    allTasks.forEach(t => {
      const m = (t.task_id || '').match(/TA-(\d+)/);
      if (m) maxNum = Math.max(maxNum, parseInt(m[1]));
    });
    data.task_id = `TA-${String(maxNum + 1).padStart(3, '0')}`;
    await supabase.from('tasks').insert(data);
    toast('Task created', 'success');
  }
  closeTaskModal();
  loadTasks();
};

window.deleteTask = async (id) => {
  if (!confirm('Delete this task?')) return;
  await supabase.from('tasks').delete().eq('id', id);
  toast('Task deleted', 'success');
  loadTasks();
};

// ======================== ACHIEVEMENTS (quick view) ========================
async function loadAchievementsQuick() {
  const [{ data: milestones }, { data: tokens }] = await Promise.all([
    supabase.from('milestones').select('id, name, active').order('category'),
    supabase.from('tokens').select('id, name, active').order('theme_id'),
  ]);
  const mActive = milestones?.filter(m => m.active !== false).length || 0;
  const tActive = tokens?.filter(t => t.active !== false).length || 0;
  document.getElementById('achievementsQuick').innerHTML = `
    <div class="stat-grid" style="grid-template-columns:repeat(3,1fr);">
      <div class="stat-card"><div class="num">${milestones?.length || 0}</div><div class="label">Total Milestones</div></div>
      <div class="stat-card"><div class="num">${tokens?.length || 0}</div><div class="label">Total Tokens</div></div>
      <div class="stat-card"><div class="num">${mActive + tActive}</div><div class="label">Active</div></div>
    </div>
    <p class="tiny" style="margin-top:8px;">Manage active/inactive status at <a href="admin-achievements.html" target="_blank">admin-achievements.html</a></p>`;
}

// ======================== COMMS ========================
async function loadCommHistory() {
  const { data } = await supabase.from('communications')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(20);
  const c = document.getElementById('commHistory');
  if (!data?.length) { c.innerHTML = '<p class="tiny muted">No broadcasts sent yet.</p>'; return; }
  c.innerHTML = data.map(p => `
    <div class="inquiry-card">
      <div class="meta"><span><i class="fas fa-bullhorn"></i> ${p.title || ''}</span><span>${new Date(p.created_at).toLocaleString()}</span></div>
      <div class="msg">${p.content || ''}</div>
    </div>`).join('');
}

window.sendBroadcast = async () => {
  const title = document.getElementById('commTitle').value.trim();
  const content = document.getElementById('commContent').value.trim();
  if (!title || !content) { toast('Title and content required', 'error'); return; }
  const { error } = await supabase.from('communications').insert({
    title, content, author_id: currentUser.id, created_at: new Date().toISOString()
  });
  if (error) { toast('Failed: ' + error.message, 'error'); return; }
  toast('Broadcast sent!', 'success');
  document.getElementById('commTitle').value = '';
  document.getElementById('commContent').value = '';
  loadCommHistory();

  // Send notification email
  getConfig('notify_broadcast').then(enabled => {
    if (enabled !== 'false') {
      getConfig('notification_email').then(notifEmail => {
        getConfig('site_url').then(siteUrl => {
          sendEmail(
            notifEmail || 'follydevs@gmail.com',
            `Broadcast: ${title}`,
            `<div style="font-family:sans-serif;max-width:480px;margin:0 auto;">
              <h2 style="color:#C8A96E;">New Broadcast Published</h2>
              <p style="font-weight:600;font-size:1.1rem;">${title}</p>
              <hr style="border:none;border-top:1px solid #e0d5c0;margin:16px 0;">
              <p>${content}</p>
              <hr style="border:none;border-top:1px solid #e0d5c0;margin:16px 0;">
              <p style="font-size:0.85rem;color:#7A6B5D;">
                <a href="${siteUrl || 'https://hivernectar.earth'}/board.html" style="color:#C8A96E;">View on Board →</a>
              </p>
            </div>`,
          );
        });
      });
    }
  });
};

// ======================== INQUIRIES ========================
async function loadInquiries() {
  const { data, error } = await supabase.from('contact_inquiries')
    .select('*')
    .order('created_at', { ascending: false });
  if (error) { toast('Failed to load inquiries', 'error'); return; }
  const inquiries = data || [];

  // Build category filter pills
  const cats = [...new Set(inquiries.map(i => i.category || 'General'))];
  const filters = document.getElementById('inquiryFilters');
  filters.innerHTML = '<button class="btn btn-secondary" style="padding:4px 12px;font-size:0.75rem;" onclick="filterInquiries(\'all\')">All</button>' +
    cats.map(c => `<button class="btn btn-secondary" style="padding:4px 12px;font-size:0.75rem;" onclick="filterInquiries('${c}')">${c}</button>`).join('');

  window._allInquiries = inquiries;
  renderInquiries(inquiries);
}

window.filterInquiries = (cat) => {
  const all = window._allInquiries || [];
  renderInquiries(cat === 'all' ? all : all.filter(i => (i.category || 'General') === cat));
};

function renderInquiries(list) {
  const c = document.getElementById('inquiryList');
  if (!list.length) { c.innerHTML = '<p class="tiny muted">No inquiries found.</p>'; return; }
  c.innerHTML = list.map(i => `
    <div class="inquiry-card ${i.status === 'unread' || !i.status ? 'unread' : ''}">
      <div class="meta">
        <span><i class="fas fa-user"></i> ${i.user_name || 'Anonymous'}</span>
        <span><i class="fas fa-tag"></i> ${i.category || 'General'}</span>
        <span><i class="fas fa-envelope"></i> ${i.user_email || ''}</span>
        <span>${i.created_at ? new Date(i.created_at).toLocaleString() : ''}</span>
        <span class="pill ${i.status === 'unread' || !i.status ? 'unread' : i.status === 'resolved' ? 'resolved' : ''}">${i.status || 'unread'}</span>
      </div>
      <div class="msg">${i.message || ''}</div>
      <div style="display:flex;gap:8px;">
        ${i.status !== 'resolved' ? `<button class="btn btn-secondary" style="padding:3px 10px;font-size:0.7rem;" onclick="markInquiryResolved('${i.id}')"><i class="fas fa-check"></i> Mark Resolved</button>` : ''}
        <button class="btn btn-secondary" style="padding:3px 10px;font-size:0.7rem;" onclick="deleteInquiry('${i.id}')"><i class="fas fa-trash"></i></button>
      </div>
    </div>`).join('');
}

window.markInquiryResolved = async (id) => {
  const { error } = await supabase.from('contact_inquiries').update({ status: 'resolved' }).eq('id', id);
  if (error) { toast('Failed: ' + error.message, 'error'); return; }
  toast('Marked as resolved', 'success');
  loadInquiries();
};

window.deleteInquiry = async (id) => {
  if (!confirm('Delete this inquiry?')) return;
  const { error } = await supabase.from('contact_inquiries').delete().eq('id', id);
  if (error) { toast('Failed: ' + error.message, 'error'); return; }
  toast('Deleted', 'success');
  loadInquiries();
};

// ======================== SYSTEM ========================
window.runDowngrade = async () => {
  const r = document.getElementById('sysResult');
  r.innerHTML = 'Running...';
  const { data, error } = await supabase.rpc('downgrade_expired_subscriptions');
  if (error) { r.innerHTML = `<span style="color:red;">Error: ${error.message}</span>`; return; }
  const result = typeof data === 'string' ? JSON.parse(data) : data;
  r.innerHTML = `<span style="color:green;">✅ ${result.downgraded_count || 0} subscription(s) downgraded</span>`;
  loadActiveSubs();
};

window.sendRenewalReminders = async () => {
  const r = document.getElementById('reminderResult');
  r.innerHTML = 'Checking...';
  const { data, error } = await supabase.rpc('check_upcoming_renewals', { p_days_ahead: 7 });
  if (error) { r.innerHTML = `<span style="color:red;">Error: ${error.message}</span>`; return; }
  const result = typeof data === 'string' ? JSON.parse(data) : data;

  if (result.reminder_count === 0) {
    r.innerHTML = `<span style="color:#7A6B5D;">ℹ️ ${result.message}</span>`;
    return;
  }

  r.innerHTML = `<span style="color:green;">✅ ${result.message}</span>`;
  if (result.users?.length) {
    const list = result.users.map(u =>
      `<div class="tiny" style="padding:4px 0;">• ${u.email || '?'} — ${u.tier} — ends ${u.period_end ? new Date(u.period_end).toLocaleDateString() : '?'}</div>`
    ).join('');
    document.getElementById('reminderPreview').innerHTML = `
      <p style="font-size:0.85rem;font-weight:600;margin:12px 0 4px;">Users to remind:</p>
      ${list}`;
  }
};

async function loadActiveSubs() {
  const { data, error } = await supabase.from('profiles')
    .select('id, email, tier, subscription_status, subscription_current_period_end')
    .neq('tier', 'free')
    .order('subscription_status');
  const c = document.getElementById('activeSubsList');
  if (!c) return;
  if (error) { c.innerHTML = `<p class="tiny muted">Error loading: ${error.message}</p>`; return; }
  if (!data?.length) { c.innerHTML = '<p class="tiny muted">No active subscribers.</p>'; return; }
  c.innerHTML = `<table class="admin-table"><thead><tr><th>Email</th><th>Tier</th><th>Status</th><th>Period End</th></tr></thead><tbody>
    ${data.map(s => `<tr><td>${s.email || s.id.slice(0,12)}</td><td>${s.tier}</td><td><span class="pill ${s.subscription_status}">${s.subscription_status}</span></td><td class="tiny">${s.subscription_current_period_end ? new Date(s.subscription_current_period_end).toLocaleDateString() : '—'}</td></tr>`).join('')}
  </tbody></table>`;
}

// ======================== ADMINS ========================
async function loadAdmins() {
  const { data, error } = await supabase.from('admin_users').select('*').order('added_at');
  if (error) { toast('Failed to load admins', 'error'); return; }
  document.getElementById('adminsBody').innerHTML = (data || []).map(a => `
    <tr>
      <td>${a.email}</td>
      <td class="tiny">${a.added_at ? new Date(a.added_at).toLocaleDateString() : '—'}</td>
      <td>${a.email !== 'anhishgautam@gmail.com' ? `<button class="btn btn-secondary" style="padding:3px 8px;font-size:0.7rem;" onclick="removeAdmin('${a.email}')"><i class="fas fa-times"></i></button>` : '<span class="tiny muted">Owner</span>'}</td>
    </tr>`).join('');
}

window.addAdmin = async () => {
  const email = document.getElementById('newAdminEmail').value.trim();
  if (!email) { toast('Enter an email', 'error'); return; }
  const { error } = await supabase.rpc('add_admin', { p_email: email });
  if (error) { toast('Failed: ' + error.message, 'error'); return; }
  toast(`${email} added as admin`, 'success');
  document.getElementById('newAdminEmail').value = '';
  loadAdmins();
};

window.removeAdmin = async (email) => {
  if (!confirm(`Remove ${email} from admins?`)) return;
  const { error } = await supabase.rpc('remove_admin', { p_email: email });
  if (error) { toast('Failed: ' + error.message, 'error'); return; }
  toast('Admin removed', 'success');
  loadAdmins();
};

// ======================== INIT ========================
async function initCRM() {
  Loader.show('Loading dashboard...');
  try {
    await Promise.all([
      loadDashboard(),
      loadUsers(),
      loadTasks(),
      loadAchievementsQuick(),
      loadCommHistory(),
      loadInquiries(),
      loadActiveSubs(),
      loadAdmins(),
    ]);
  } catch (e) {
    console.error('initCRM error:', e);
  } finally {
    Loader.hide();
    document.body.classList.remove('data-loading');
  }
}

checkAuth();
