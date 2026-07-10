import { supabase } from './supabase-config.js';

const Loader = {
    show(message = "Loading...") {
        const loader = document.getElementById('global-loader');
        const text = document.getElementById('loader-text');
        if (loader) {
            if (text) text.innerText = message;
            loader.style.display = 'flex';
        }
    },
    hide() {
        const loader = document.getElementById('global-loader');
        if (loader) loader.style.display = 'none';
    }
};

async function fetchAllPosts() {
    const { data, error } = await supabase
        .from('communications')
        .select('*')
        .order('created_at', { ascending: false });
    if (error) {
        console.error('Supabase Fetch Error:', error);
        return [];
    }
    return data || [];
}

function getIconForPost(post) {
    if (post.icon && post.icon.trim() !== '') return post.icon.trim();
    const type = (post.post_type || '').toLowerCase().trim();
    if (type.includes('announce')) return 'bullhorn';
    if (type.includes('update'))   return 'sync-alt';
    if (type.includes('community')) return 'users';
    if (type.includes('security')) return 'shield-halved';
    return 'bell';
}

function normalizeType(raw) {
    if (!raw) return '';
    return raw.trim().toLowerCase().replace(/\s+/g, ' ');
}

function renderFilterPills(posts) {
    const container = document.getElementById('filterPills');
    if (!container) return;

    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const typeMap = new Map();

    posts.forEach(post => {
        if (new Date(post.created_at) >= cutoff && post.post_type) {
            const normalized = normalizeType(post.post_type);
            if (!normalized) return;
            if (!typeMap.has(normalized)) {
                const display = normalized.charAt(0).toUpperCase() + normalized.slice(1);
                typeMap.set(normalized, { displayName: display, samplePost: post });
            }
        }
    });

    let pillsHtml = `<button class="filter-pill active" data-filter="all">
                        <i class="fas fa-globe"></i> All Posts
                     </button>`;

    for (let [filterKey, { displayName, samplePost }] of typeMap.entries()) {
        const iconName = getIconForPost(samplePost);
        pillsHtml += `<button class="filter-pill" data-filter="${filterKey}">
                        <i class="fas fa-${iconName}"></i> ${displayName}
                      </button>`;
    }

    container.innerHTML = pillsHtml;

    document.querySelectorAll('.filter-pill').forEach(pill => {
        pill.addEventListener('click', () => {
            const filter = pill.dataset.filter;
            document.querySelectorAll('.filter-pill').forEach(p => p.classList.remove('active'));
            pill.classList.add('active');
            let filtered = posts;
            if (filter !== 'all') {
                filtered = posts.filter(p => normalizeType(p.post_type) === filter);
            }
            renderPosts(filtered, filter);
        });
    });
}

function renderPosts(posts, currentFilter) {
    const container = document.getElementById('postsContainer');
    if (!container) return;

    if (posts.length === 0) {
        container.innerHTML = '<p class="muted" style="text-align:center; padding:40px;">No posts found.</p>';
        return;
    }

    container.innerHTML = posts.map(post => `
        <div class="post-card" data-id="${post.id}">
            <div class="post-header" style="display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 12px;">
                <span class="post-category ${post.post_type}" style="font-size: 1.25rem; font-weight: 700; text-transform: uppercase;">
                    ${post.post_type}
                </span>
                <span class="post-date" style="font-weight: 400; color: var(--muted);">${new Date(post.created_at).toLocaleDateString()}</span>
            </div>
            <p>${(post.message || '').substring(0, 150)}${(post.message || '').length > 150 ? '...' : ''}</p>
            <div class="post-footer">
                <span class="read-more">Read More →</span>
            </div>
        </div>
    `).join('');

    container.querySelectorAll('.post-card').forEach(card => {
        card.addEventListener('click', () => {
            const postId = card.dataset.id;
            const post = posts.find(p => p.id === postId);
            if (post) openPostModal(post);
        });
    });
}

function openPostModal(post) {
    const sheet = document.getElementById('postBottomSheet');
    if (!sheet) return;
    
    const titleEl = document.getElementById('postSheetTitle');
    const bodyEl = document.getElementById('postSheetBody');
    const dateEl = document.getElementById('postSheetDate');
    
    if (titleEl) titleEl.textContent = post.title || post.post_type;
    if (bodyEl) bodyEl.textContent = post.message || '';
    if (dateEl) dateEl.textContent = new Date(post.created_at).toLocaleDateString();
    
    sheet.style.visibility = 'visible';
    sheet.style.opacity = '1';
    sheet.classList.add('active');
}

async function updateRecentActivity() {
    const container = document.getElementById('recentActivityList');
    if (!container) return;

    const allPosts = await fetchAllPosts();
    const latest = allPosts.slice(0, 3);

    if (latest.length === 0) {
        container.innerHTML = '<div class="recent-item">No recent activity</div>';
        return;
    }

    const timeAgo = (date) => {
        const seconds = Math.floor((new Date() - new Date(date)) / 1000);
        if (seconds < 60) return `${seconds} seconds ago`;
        const minutes = Math.floor(seconds / 60);
        if (minutes < 60) return `${minutes} minute${minutes > 1 ? 's' : ''} ago`;
        const hours = Math.floor(minutes / 60);
        if (hours < 24) return `${hours} hour${hours > 1 ? 's' : ''} ago`;
        const days = Math.floor(hours / 24);
        return `${days} day${days > 1 ? 's' : ''} ago`;
    };

    container.innerHTML = latest.map(post => {
        const icon = getIconForPost(post);
        return `
            <div class="recent-item" data-id="${post.id}" style="cursor:pointer;">
                <div class="icon"><i class="fas fa-${icon}"></i></div>
                <div>
                    <h5>${post.title || post.post_type}</h5>
                    <p class="muted">${timeAgo(post.created_at)}</p>
                </div>
            </div>
        `;
    }).join('');

    container.querySelectorAll('.recent-item').forEach(item => {
        item.addEventListener('click', () => {
            const postId = item.dataset.id;
            const post = allPosts.find(p => p.id === postId);
            if (post) openPostModal(post);
        });
    });
}

// Update the floating messenger badge (red number + pulse)
export async function updateMessengerBadge() {
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const allPosts = await fetchAllPosts();
    const recentCount = allPosts.filter(p => new Date(p.created_at) >= cutoff).length;
    const badge = document.getElementById('messengerBadge');
    const messengerCircle = document.querySelector('.messenger-circle');
    if (badge) {
        if (recentCount > 0) {
            badge.textContent = recentCount;
            badge.style.display = 'inline-flex';
            messengerCircle?.classList.add('has-notifications');
        } else {
            badge.style.display = 'none';
            messengerCircle?.classList.remove('has-notifications');
        }
    }
}

// Update the preview card content (latest 3 posts)
async function updateBuzzPreview() {
    const container = document.getElementById('buzzPreviewBody');
    if (!container) return;
    
    const allPosts = await fetchAllPosts();
    const latest = allPosts.slice(0, 3);
    
    if (latest.length === 0) {
        container.innerHTML = '<p class="muted" style="text-align:center;">No recent buzz</p>';
        return;
    }
    
    const timeAgo = (date) => {
        const seconds = Math.floor((new Date() - new Date(date)) / 1000);
        if (seconds < 60) return `${seconds} seconds ago`;
        const minutes = Math.floor(seconds / 60);
        if (minutes < 60) return `${minutes} minute${minutes > 1 ? 's' : ''} ago`;
        const hours = Math.floor(minutes / 60);
        if (hours < 24) return `${hours} hour${hours > 1 ? 's' : ''} ago`;
        const days = Math.floor(hours / 24);
        return `${days} day${days > 1 ? 's' : ''} ago`;
    };
    
    container.innerHTML = latest.map(post => {
        const icon = getIconForPost(post);
        return `
            <div class="preview-item" data-id="${post.id}" style="cursor:pointer; padding: 8px 0; border-bottom: 1px solid var(--border);">
                <div style="display: flex; align-items: center; gap: 8px;">
                    <i class="fas fa-${icon}" style="color: var(--primary); width: 20px;"></i>
                    <strong>${post.post_type}</strong>
                    <span class="tiny muted" style="margin-left: auto;">${timeAgo(post.created_at)}</span>
                </div>
                <p class="tiny" style="margin: 4px 0 0 28px; color: var(--fg-muted);">${(post.message || '').substring(0, 60)}...</p>
            </div>
        `;
    }).join('');
    
    container.querySelectorAll('.preview-item').forEach(item => {
        item.addEventListener('click', () => {
            const postId = item.dataset.id;
            const post = allPosts.find(p => p.id === postId);
            if (post) openPostModal(post);
        });
    });
}

let boardSubscription = null;

export async function initCommunicationBoard() {
    const postsContainer = document.getElementById('postsContainer');
    if (!postsContainer) return;

    Loader.show("Fetching meadow updates...");

    try {
        const posts = await fetchAllPosts();
        renderFilterPills(posts);
        renderPosts(posts, 'all');
        await updateRecentActivity();
        await updateMessengerBadge();

        if (boardSubscription) supabase.removeChannel(boardSubscription);
        boardSubscription = supabase
            .channel('comm-board-changes')
            .on('postgres_changes', { event: '*', schema: 'public', table: 'communications' }, async () => {
                const freshPosts = await fetchAllPosts();
                renderFilterPills(freshPosts);
                const currentActive = document.querySelector('.filter-pill.active')?.dataset.filter || 'all';
                let filtered = freshPosts;
                if (currentActive !== 'all') {
                    filtered = freshPosts.filter(p => normalizeType(p.post_type) === currentActive);
                }
                renderPosts(filtered, currentActive);
                await updateRecentActivity();
                await updateMessengerBadge();
            })
            .subscribe();

        const modal = document.getElementById('postModal');
        const closeBtn = modal?.querySelector('.close-modal');
        if (closeBtn && modal) {
            closeBtn.onclick = () => modal.style.display = 'none';
            window.onclick = (e) => { if (e.target === modal) modal.style.display = 'none'; };
        }
    } catch (err) {
        console.error("Critical Board Error:", err);
    } finally {
        Loader.hide();
    }
}

export async function initHomeFeed() {
    const container = document.getElementById('homeBuzzContainer');
    if (!container) return;

    const allPosts = await fetchAllPosts();
    const latest = allPosts.slice(0, 3);

    if (latest.length === 0) {
        container.innerHTML = '<p class="muted" style="text-align:center; padding:20px;">No buzz yet. Check back soon!</p>';
        return;
    }

    container.innerHTML = latest.map(post => `
        <div class="post-card" data-id="${post.id}" style="margin-bottom: 16px; cursor: pointer;">
            <div class="post-header" style="display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 12px;">
                <span class="post-category ${post.post_type}" style="font-size: 1.25rem; font-weight: 700; text-transform: uppercase;">
                    ${post.post_type}
                </span>
                <span class="post-date" style="font-weight: 400; color: var(--muted);">${new Date(post.created_at).toLocaleDateString()}</span>
            </div>
            <p>${(post.message || '').substring(0, 100)}${(post.message || '').length > 100 ? '...' : ''}</p>
            <div class="post-footer">
                <span class="read-more">Read More →</span>
            </div>
        </div>
    `).join('');

    container.querySelectorAll('.post-card').forEach(card => {
        card.addEventListener('click', () => {
            const postId = card.dataset.id;
            const post = allPosts.find(p => p.id === postId);
            if (post) openPostModal(post);
        });
    });
}

// Homepage initialisation: updates badge, preview card, and feed
export async function initHomeNotifications() {
    const container = document.getElementById('homeNotifSection');
    if (container) {
        const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
        const recentPosts = (await fetchAllPosts()).filter(p => new Date(p.created_at) >= cutoff);
        await updateMessengerBadge();
        await updateBuzzPreview();   // 👈 fill the preview card
        await initHomeFeed();

        if (recentPosts.length > 0) {
            const latest = recentPosts[0];
            container.innerHTML = `
                <div class="notif-banner" style="background: var(--honey-gradient); padding: 12px 24px; border-radius: 12px; display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 24px;">
                    <div style="display: flex; align-items: center; gap: 12px;">
                        <i class="fas fa-bell" style="color: white;"></i>
                        <span class="tiny" style="color: white;">${latest.message || latest.title}</span>
                    </div>
                    <a href="board.html" class="tiny" style="color: white; font-weight: 700;">View Board →</a>
                </div>
            `;
        } else {
            container.innerHTML = '';
        }
    } else {
        // If no banner container, still update the messenger and preview
        await updateMessengerBadge();
        await updateBuzzPreview();
        await initHomeFeed();
    }

    // Real-time updates for homepage
    const homeSubscription = supabase
        .channel('comm-home-changes')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'communications' }, async () => {
            await initHomeFeed();
            await updateBuzzPreview();
            const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
            const freshRecent = (await fetchAllPosts()).filter(p => new Date(p.created_at) >= cutoff);
            if (container && freshRecent.length > 0) {
                const latest = freshRecent[0];
                container.innerHTML = `
                    <div class="notif-banner" style="background: var(--honey-gradient); padding: 12px 24px; border-radius: 12px; display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 24px;">
                        <div style="display: flex; align-items: center; gap: 12px;">
                            <i class="fas fa-bell" style="color: white;"></i>
                            <span class="tiny" style="color: white;">${latest.message || latest.title}</span>
                        </div>
                        <a href="board.html" class="tiny" style="color: white; font-weight: 700;">View Board →</a>
                    </div>
                `;
            } else if (container && freshRecent.length === 0) {
                container.innerHTML = '';
            }
            await updateMessengerBadge();
        })
        .subscribe();
}