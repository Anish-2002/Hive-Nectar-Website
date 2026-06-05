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
        <h3>${escapeHtml(title)}</h3>
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
// HELPER: Extract video IDs
// --------------------------------------------------------------
function extractYouTubeId(url) {
  const match = url.match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|embed\/))([^&\?\/]+)/);
  return match ? match[1] : null;
}

function extractTikTokVideoId(url) {
  const patterns = [
    /tiktok\.com\/@[\w.-]+\/video\/(\d+)/,
    /tiktok\.com\/t\/([\w-]+)/,
    /vm\.tiktok\.com\/([\w-]+)/
  ];
  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) return match[1];
  }
  return null;
}

// --------------------------------------------------------------
// HELPER: Call confirmation bottom sheet for tel: links
// --------------------------------------------------------------
function showCallConfirmation(phoneNumber) {
  const cleanNumber = phoneNumber.replace(/^tel:/, '');
  const contentHtml = `
    <div style="text-align: center; padding: 8px 0;">
      <i class="fas fa-phone-alt" style="font-size: 2.5rem; color: var(--primary, #2d6a4f); margin-bottom: 16px;"></i>
      <p style="margin-bottom: 24px; font-size: 1.1rem;">Call <strong>${escapeHtml(cleanNumber)}</strong>?</p>
      <div style="display: flex; gap: 12px; justify-content: center;">
        <button id="confirmCallBtn" class="btn btn-success">Call Now</button>
        <button id="cancelCallBtn" class="btn btn-secondary">Cancel</button>
      </div>
    </div>
  `;
  
  const sheet = showBottomSheet('📞 Contact', contentHtml);
  
  setTimeout(() => {
    const confirmBtn = document.querySelector('#confirmCallBtn');
    const cancelBtn = document.querySelector('#cancelCallBtn');
    if (confirmBtn) {
      confirmBtn.addEventListener('click', () => {
        window.location.href = phoneNumber;
        const overlay = document.querySelector('.bottom-sheet-overlay');
        if (overlay) overlay.remove();
      });
    }
    if (cancelBtn) {
      cancelBtn.addEventListener('click', () => {
        const overlay = document.querySelector('.bottom-sheet-overlay');
        if (overlay) overlay.remove();
      });
    }
  }, 50);
}

// --------------------------------------------------------------
// HELPER: Get proper Font Awesome class from icon string
// --------------------------------------------------------------
function getIconClass(icon) {
  if (!icon) return 'fas fa-link';
  
  // If already contains 'fa-' (full class), use as is
  if (icon.includes('fa-')) {
    return icon;
  }
  
  // List of brand icons (use fab prefix)
  const brandIcons = [
    'tiktok', 'instagram', 'facebook', 'twitter', 'x-twitter', 'youtube', 
    'linkedin', 'github', 'pinterest', 'snapchat', 'whatsapp', 'telegram', 
    'discord', 'reddit', 'medium', 'twitch', 'spotify', 'apple', 'google', 
    'microsoft', 'android', 'amazon', 'paypal', 'stripe', 'etsy'
  ];
  
  const lowerIcon = icon.toLowerCase();
  if (brandIcons.includes(lowerIcon)) {
    return `fab fa-${lowerIcon}`;
  }
  
  // Map common non‑brand icons to the correct solid names
  const iconMap = {
    'mobile': 'fas fa-mobile-alt',
    'phone': 'fas fa-phone-alt',
    'call': 'fas fa-phone-alt',
    'email': 'fas fa-envelope',
    'map': 'fas fa-map-marker-alt',
    'location': 'fas fa-location-dot',
    'calendar': 'fas fa-calendar',
    'clock': 'fas fa-clock',
    'user': 'fas fa-user',
    'users': 'fas fa-users',
    'heart': 'fas fa-heart',
    'star': 'fas fa-star',
    'download': 'fas fa-download',
    'upload': 'fas fa-upload',
    'file': 'fas fa-file',
    'pdf': 'fas fa-file-pdf',
    'link': 'fas fa-link',
    'globe': 'fas fa-globe',
    'shop': 'fas fa-store',
    'cart': 'fas fa-shopping-cart',
    'tag': 'fas fa-tag',
    'search': 'fas fa-search',
    'settings': 'fas fa-cog',
    'home': 'fas fa-home',
    'info': 'fas fa-info-circle',
    'warning': 'fas fa-exclamation-triangle'
  };
  
  if (iconMap[lowerIcon]) {
    return iconMap[lowerIcon];
  }
  
  // Default: solid icon with given name
  return `fas fa-${lowerIcon}`;
}

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
        <i class="fas ${iconClass}"></i> ${escapeHtml(item.label)}
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
        <td>${escapeHtml(b.doc_id || b.id.slice(0,8))}</td>
        <td>${escapeHtml(b.name)}</td>
        <td>${escapeHtml(b.short_description || '')}</td>
        <td><span class="status-badge ${statusClass}">${escapeHtml(b.status)}</span></td>
        <td>
          ${b.source_url ? `<a href="${escapeHtml(b.source_url)}" target="_blank" class="btn-sm">Preview</a>` : ''}
        </td>
      </tr>
    `;
  }
  html += `</tbody></table>`;
  return html;
}

// --------------------------------------------------------------
// CONTENT: Media Hub (YouTube, TikTok, Etsy, PDF)
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
    let previewHtml = '';
    let actionHtml = '';
    const thumb = item.thumbnail_url || 'https://placehold.co/400x225?text=No+Image';
    
    if (item.media_type === 'youtube') {
      const vid = extractYouTubeId(item.source_url);
      if (vid) {
        previewHtml = `<iframe class="media-embed" src="https://www.youtube.com/embed/${vid}" frameborder="0" allowfullscreen></iframe>`;
      } else {
        previewHtml = `<img src="${thumb}" class="media-thumbnail" alt="${escapeHtml(item.title)}">`;
      }
      actionHtml = `<a href="${escapeHtml(item.source_url)}" target="_blank" class="btn-sm">Open on YouTube</a>`;
    }
    else if (item.media_type === 'tiktok_url') {
      const videoId = extractTikTokVideoId(item.source_url);
      if (videoId) {
        previewHtml = `<iframe class="media-embed" src="https://www.tiktok.com/embed/v2/${videoId}" frameborder="0" allowfullscreen></iframe>`;
      } else {
        previewHtml = `<img src="${thumb}" class="media-thumbnail" alt="${escapeHtml(item.title)}">`;
      }
      actionHtml = `<a href="${escapeHtml(item.source_url)}" target="_blank" class="btn-sm">Open on TikTok</a>`;
    }
    else if (item.media_type === 'etsy_link') {
      previewHtml = `<img src="${thumb}" class="media-thumbnail" alt="${escapeHtml(item.title)}">`;
      actionHtml = `<a href="${escapeHtml(item.source_url)}" target="_blank" class="btn-sm">View on Etsy →</a>`;
    }
    else if (item.media_type === 'drive_pdf') {
      previewHtml = `<img src="${thumb}" class="media-thumbnail" alt="${escapeHtml(item.title)}">`;
      actionHtml = `<a href="${escapeHtml(item.source_url)}" target="_blank" class="btn-sm">Open PDF</a>`;
    }
    else {
      previewHtml = `<img src="${thumb}" class="media-thumbnail" alt="${escapeHtml(item.title)}">`;
      actionHtml = `<a href="${escapeHtml(item.source_url)}" target="_blank" class="btn-sm">Open</a>`;
    }
    
    html += `
      <div class="media-card">
        <div class="media-preview">
          ${previewHtml}
        </div>
        <div class="media-card-body">
          <h4>${escapeHtml(item.title)}</h4>
          <p class="tiny">${escapeHtml(item.description || '')}</p>
          ${actionHtml}
        </div>
      </div>
    `;
  }
  html += '</div>';
  return html;
}

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/[&<>]/g, function(m) {
    if (m === '&') return '&amp;';
    if (m === '<') return '&lt;';
    if (m === '>') return '&gt;';
    return m;
  });
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
// DYNAMIC SOCIAL HUB with proper icon handling
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
  if (!links || links.length === 0) {
    socialHtml = '<p class="tiny muted">No journey links available yet. Check back soon!</p>';
  } else {
    for (const link of links) {
      const iconClass = getIconClass(link.icon);
      const isTel = link.url && link.url.startsWith('tel:');
      const linkClass = isTel ? 'social-link tel-link' : 'social-link';
      socialHtml += `
        <div class="social-card">
          <div class="social-icon"><i class="${iconClass}"></i></div>
          <div class="social-info">
            <a href="${escapeHtml(link.url)}" class="${linkClass}" ${!isTel ? 'target="_blank" rel="noopener noreferrer"' : ''}>${escapeHtml(link.name)}</a>
            ${link.description ? `<p>${escapeHtml(link.description)}</p>` : ''}
          </div>
        </div>
      `;
    }
  }
  socialHtml += '</div>';
  
  const sheet = showBottomSheet('Explore My Journey', socialHtml);
  
  setTimeout(() => {
    const telLinks = document.querySelectorAll('.social-card a.tel-link');
    telLinks.forEach(link => {
      link.addEventListener('click', (e) => {
        e.preventDefault();
        const phoneUrl = link.getAttribute('href');
        if (phoneUrl && phoneUrl.startsWith('tel:')) {
          showCallConfirmation(phoneUrl);
        } else {
          window.open(phoneUrl, '_blank');
        }
      });
    });
  }, 100);
  
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
    showToast('Welcome to the Meadow!', 'success');
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