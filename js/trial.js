import { supabase } from './supabase-config.js';
import { showToast, Loader } from './app.js';

// --------------------------------------------------------------
// BOTTOM SHEET HELPER
// --------------------------------------------------------------
function showBottomSheet(title, contentHtml, onClose) {
  const existing = document.querySelector('.bottom-sheet-overlay');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.className = 'bottom-sheet-overlay';
  overlay.innerHTML = `
    <div class="bottom-sheet">
      <div class="bottom-sheet-header">
        <h3>${title}</h3>
        <button class="bottom-sheet-close">&times;</button>
      </div>
      <div class="bottom-sheet-content">${contentHtml}</div>
    </div>
  `;
  document.body.appendChild(overlay);

  const closeBtn = overlay.querySelector('.bottom-sheet-close');
  const close = () => {
    overlay.classList.remove('active');
    setTimeout(() => overlay.remove(), 300);
    if (onClose) onClose();
  };
  closeBtn.addEventListener('click', close);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });

  overlay.offsetHeight;
  overlay.classList.add('active');
  return overlay;
}

// --------------------------------------------------------------
// GLOBAL STATE
// --------------------------------------------------------------
let currentUser = null;

// --------------------------------------------------------------
// AUTH & HEADER
// --------------------------------------------------------------
async function checkAuth() {
  const { data: { user } } = await supabase.auth.getUser();
  if (user) {
    currentUser = user;
    document.getElementById('loginOverlay').style.display = 'none';
    document.getElementById('dashboard').style.display = 'block';
    await loadUserProfile();
    await loadSidebarAndSetActive();
  } else {
    document.getElementById('loginOverlay').style.display = 'flex';
    document.getElementById('dashboard').style.display = 'none';
  }
}

async function loadUserProfile() {
  try {
    // Try to fetch from profiles table
    const { data, error } = await supabase
      .from('profiles')
      .select('first_name, last_name, avatar_url')
      .eq('id', currentUser.id)
      .single();
    
    let displayName = currentUser.email;
    let avatarUrl = `https://api.dicebear.com/9.x/fun-emoji/svg?seed=${currentUser.id}`;
    
    if (!error && data) {
      if (data.first_name || data.last_name) {
        displayName = `${data.first_name || ''} ${data.last_name || ''}`.trim();
      }
      if (data.avatar_url) avatarUrl = data.avatar_url;
    } else {
      console.warn('Profile not found, using email as display name');
    }
    
    renderUserHeader(displayName, avatarUrl);
  } catch (err) {
    console.error('Error loading profile:', err);
    renderUserHeader(currentUser.email, `https://api.dicebear.com/9.x/fun-emoji/svg?seed=${currentUser.id}`);
  }
}

function renderUserHeader(displayName, avatarUrl) {
  const authSection = document.getElementById('authSection');
  if (!authSection) return;
  
  const firstName = displayName.split(' ')[0] || displayName.split('@')[0];
  
  authSection.innerHTML = `
    <div class="user-area" id="userMenu">
      <img src="${avatarUrl}" class="user-avatar" onerror="this.src='https://api.dicebear.com/9.x/fun-emoji/svg?seed=${currentUser.id}'">
      <span class="user-name">Hi, ${firstName}</span>
      <i class="fas fa-chevron-down"></i>
      <div class="dropdown" id="userDropdown">
        <a href="#" id="logoutBtn">Logout</a>
      </div>
    </div>
  `;
  
  const userMenu = document.getElementById('userMenu');
  const dropdown = document.getElementById('userDropdown');
  userMenu.addEventListener('click', (e) => {
    e.stopPropagation();
    dropdown.style.display = dropdown.style.display === 'block' ? 'none' : 'block';
  });
  document.addEventListener('click', () => dropdown.style.display = 'none');
  document.getElementById('logoutBtn').addEventListener('click', async () => {
    await supabase.auth.signOut();
    window.location.reload();
  });
}

// --------------------------------------------------------------
// SIDEBAR (dynamic from navigation_menu)
// --------------------------------------------------------------
async function loadSidebar() {
  const { data, error } = await supabase
    .from('navigation_menu')
    .select('*')
    .eq('is_active', true)
    .order('order_index');
  if (error) return [];
  return data;
}

function renderSidebar(menuItems) {
  const container = document.getElementById('dynamicSidebar');
  if (!container) return;
  let html = '';
  for (const item of menuItems) {
    const iconClass = item.icon ? `fa-${item.icon}` : 'fa-folder';
    html += `
      <div class="nav-item" data-path="${item.path}">
        <i class="fas ${iconClass}"></i> ${item.label}
      </div>
    `;
  }
  container.innerHTML = html;

  document.querySelectorAll('.nav-item').forEach(el => {
    el.addEventListener('click', async () => {
      const path = el.dataset.path;
      await openCategoryBottomSheet(path);
    });
  });
}

async function loadSidebarAndSetActive() {
  const menu = await loadSidebar();
  renderSidebar(menu);
}

// --------------------------------------------------------------
// CONTENT: Policy Briefs
// --------------------------------------------------------------
async function loadBriefs() {
  const { data, error } = await supabase
    .from('policy_briefs')
    .select('*')
    .order('created_at', { ascending: false });
  if (error) return [];
  return data;
}

function renderBriefsTable(briefs) {
  if (!briefs.length) return '<p class="tiny muted">No policy briefs yet.</p>';
  let html = `<table class="briefs-table"><thead><tr><th>ID</th><th>Name</th><th>Description</th><th>Status</th><th>Actions</th></tr></thead><tbody>`;
  for (const b of briefs) {
    const statusClass = b.status === 'published' ? 'status-published' : 'status-draft';
    html += `
      <tr>
        <td>${b.doc_id || b.id.slice(0,8)}</td>
        <td>${b.name}</td>
        <td>${b.short_description || ''}</td>
        <td><span class="status-badge ${statusClass}">${b.status}</span></td>
        <td>
          ${b.file_url ? `<a href="${b.file_url}" target="_blank" class="btn-sm">View</a>` : ''}
          ${b.source_url ? `<a href="${b.source_url}" target="_blank" class="btn-sm">Preview</a>` : ''}
        </td>
      </tr>
    `;
  }
  html += `</tbody></table>`;
  return html;
}

// --------------------------------------------------------------
// CONTENT: Media (TikTok, YouTube, Etsy, PDF)
// --------------------------------------------------------------
async function loadHubContent(categorySlug) {
  let query = supabase.from('hub_content').select('*').order('order_index');
  if (categorySlug && categorySlug !== 'briefs') {
    query = query.eq('category_slug', categorySlug);
  }
  const { data, error } = await query;
  if (error) return [];
  return data;
}

function renderMediaCards(items) {
  if (!items.length) return '<p class="tiny muted">No content in this category.</p>';
  let html = '<div class="media-grid">';
  for (const item of items) {
    let content = '';
    switch (item.media_type) {
      case 'tiktok_url':
        content = `<a href="${item.source_url}" target="_blank" class="btn-sm">Watch on TikTok</a>`;
        break;
      case 'youtube':
        const vid = item.source_url.match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|embed\/))([^&\?\/]+)/)?.[1];
        content = `<iframe width="100%" height="180" src="https://www.youtube.com/embed/${vid}" frameborder="0"></iframe>`;
        break;
      case 'etsy_link':
        content = `<a href="${item.source_url}" target="_blank" class="btn-sm">Buy on Etsy →</a>`;
        break;
      default:
        content = `<a href="${item.source_url}" target="_blank" class="btn-sm">Open</a>`;
    }
    html += `
      <div class="media-card">
        <h4>${item.title}</h4>
        <p class="tiny">${item.description || ''}</p>
        ${content}
      </div>
    `;
  }
  html += '</div>';
  return html;
}

async function getMediaHtml(categorySlug) {
  const items = await loadHubContent(categorySlug);
  const mediaTypes = [...new Set(items.map(i => i.media_type).filter(Boolean))];
  let filterHtml = `<div class="filter-pills"><div class="pill active" data-filter="all">All</div>`;
  for (const type of mediaTypes) {
    filterHtml += `<div class="pill" data-filter="${type}">${type.replace('_', ' ').toUpperCase()}</div>`;
  }
  filterHtml += `</div>`;
  const mainHtml = renderMediaCards(items);
  return { filterHtml, mainHtml, items };
}

function attachFilterListeners(container) {
  const pills = container.querySelectorAll('.pill');
  pills.forEach(pill => {
    pill.removeEventListener('click', handleFilterClick);
    pill.addEventListener('click', (e) => handleFilterClick(e, container));
  });
}

async function handleFilterClick(e, container) {
  const pill = e.currentTarget;
  const filter = pill.dataset.filter;
  const items = container._mediaItems || [];
  container.querySelectorAll('.pill').forEach(p => p.classList.remove('active'));
  pill.classList.add('active');
  let filtered = items;
  if (filter !== 'all') filtered = items.filter(i => i.media_type === filter);
  const mainContainer = container.querySelector('#hubMainContent');
  if (mainContainer) mainContainer.innerHTML = renderMediaCards(filtered);
}

// --------------------------------------------------------------
// OPEN BOTTOM SHEET FOR A CATEGORY (sidebar click)
// --------------------------------------------------------------
async function openCategoryBottomSheet(categorySlug) {
  Loader.show("Loading content...");
  let contentHtml;
  let title;
  if (categorySlug === 'briefs') {
    const briefs = await loadBriefs();
    title = '📄 Policy Briefs';
    contentHtml = `<div id="hubMainContent">${renderBriefsTable(briefs)}</div>`;
  } else {
    const { filterHtml, mainHtml, items } = await getMediaHtml(categorySlug);
    title = `📂 ${categorySlug.replace('-', ' ').toUpperCase()}`;
    contentHtml = `
      <div id="hubFilterPills">${filterHtml}</div>
      <div id="hubMainContent">${mainHtml}</div>
    `;
    setTimeout(() => {
      const sheetContent = document.querySelector('.bottom-sheet-overlay.active .bottom-sheet-content');
      if (sheetContent) {
        const filterDiv = sheetContent.querySelector('#hubFilterPills');
        if (filterDiv) {
          filterDiv._mediaItems = items;
          attachFilterListeners(filterDiv);
        }
      }
    }, 100);
  }
  showBottomSheet(title, contentHtml);
  Loader.hide();
}

// --------------------------------------------------------------
// OPEN SOCIAL LINKS BOTTOM SHEET (Explore My Journey)
// --------------------------------------------------------------
async function openSocialHub() {
  Loader.show("Loading social hub...");
  const { data: links, error } = await supabase
    .from('social_links')
    .select('*')
    .eq('is_active', true)
    .order('order_index');
  if (error) {
    showToast('Error loading social links', 'error');
    Loader.hide();
    return;
  }
  let socialHtml = '<div class="social-grid">';
  for (const link of links) {
    const icon = link.icon ? `fab fa-${link.icon}` : 'fas fa-link';
    socialHtml += `
      <div class="social-card">
        <div class="social-icon"><i class="${icon}"></i></div>
        <div class="social-info">
          <a href="${link.url}" target="_blank" rel="noopener noreferrer">${link.name}</a>
          ${link.description ? `<p>${link.description}</p>` : ''}
        </div>
      </div>
    `;
  }
  socialHtml += '</div>';
  showBottomSheet('Explore My Journey', socialHtml);
  Loader.hide();
}

// --------------------------------------------------------------
// EVENT LISTENERS
// --------------------------------------------------------------
document.getElementById('trialLoginForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = document.getElementById('loginEmail').value;
  const password = document.getElementById('loginPassword').value;
  Loader.show('Logging in...');
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  Loader.hide();
  if (error) showToast(error.message, 'error');
  else {
    showToast('Welcome to the Hive!', 'success');
    await checkAuth();
  }
});

document.getElementById('exploreMainBtn')?.addEventListener('click', () => {
  openSocialHub();
});

// --------------------------------------------------------------
// INIT
// --------------------------------------------------------------
document.addEventListener('DOMContentLoaded', () => {
  checkAuth();
});