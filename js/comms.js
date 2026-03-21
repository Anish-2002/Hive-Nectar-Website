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

export const CommsManager = {
    async fetchAllPosts() {
        const { data, error } = await supabase
            .from('communications')
            .select('*')
            .order('created_at', { ascending: false });
        if (error) {
            console.error('Supabase Fetch Error:', error);
            return [];
        }
        return data || [];
    },

    async fetchRecentForHome() {
        const now = new Date();
        const twentyFourHoursAgo = new Date(now.getTime() - (24 * 60 * 60 * 1000)).toISOString();
        const { data, error } = await supabase
            .from('communications')
            .select('*')
            .gt('created_at', twentyFourHoursAgo)
            .order('created_at', { ascending: false });
        if (error) {
            console.error('Supabase Query Error:', error);
            return [];
        }
        return data || [];
    }
};

export async function initCommunicationBoard() {
    const postsContainer = document.getElementById('postsContainer');
    if (!postsContainer) return;

    Loader.show("Fetching hive updates...");

    try {
        const posts = await CommsManager.fetchAllPosts();
        renderFilterCounts(posts);
        renderPosts(posts, 'all');
        setupFilters(posts);

        const urlParams = new URLSearchParams(window.location.search);
        const postId = urlParams.get('postId');
        if (postId) {
            const post = posts.find(p => p.id === postId);
            if (post) openPostModal(post);
        }

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

function renderFilterCounts(posts) {
    const counts = {
        announcement: posts.filter(p => p.post_type === 'announcement').length,
        update: posts.filter(p => p.post_type === 'update').length,
        community: posts.filter(p => p.post_type === 'community').length
    };
    const badgeAnnouncement = document.getElementById('announcementBadge');
    if (badgeAnnouncement) badgeAnnouncement.innerText = counts.announcement;
    // You can add badges for update/community if needed
}

function setupFilters(posts) {
    const filterPills = document.querySelectorAll('.filter-pill');
    filterPills.forEach(pill => {
        pill.addEventListener('click', () => {
            const filter = pill.dataset.filter;
            filterPills.forEach(p => p.classList.remove('active'));
            pill.classList.add('active');
            renderPosts(posts, filter);
        });
    });
}

function renderPosts(posts, filter) {
    const container = document.getElementById('postsContainer');
    if (!container) return;

    let filtered = posts;
    if (filter !== 'all') {
        filtered = posts.filter(p => p.post_type === filter);
    }

    if (filtered.length === 0) {
        container.innerHTML = '<p class="muted" style="text-align:center; padding:40px;">No posts found.</p>';
        return;
    }

    container.innerHTML = filtered.map(post => `
        <div class="post-card" data-id="${post.id}">
            <div class="post-header">
                <span class="post-category ${post.post_type}">${post.post_type}</span>
                <span class="post-date">${new Date(post.created_at).toLocaleDateString()}</span>
            </div>
            <h3>${post.title || post.post_type}</h3>
            <p>${post.message.substring(0, 150)}${post.message.length > 150 ? '...' : ''}</p>
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
    const modal = document.getElementById('postModal');
    if (!modal) return;

    const categorySpan = document.getElementById('modalCategory');
    const titleEl = document.getElementById('modalTitle');
    const bodyEl = document.getElementById('modalBody');
    const dateEl = document.getElementById('modalDate');
    const authorEl = document.getElementById('modalAuthor');

    if (categorySpan) categorySpan.textContent = post.post_type;
    if (titleEl) titleEl.textContent = post.title || post.post_type;
    if (bodyEl) bodyEl.innerHTML = post.message;
    if (dateEl) dateEl.textContent = new Date(post.created_at).toLocaleDateString();
    if (authorEl) authorEl.textContent = 'Hive Team';

    modal.style.display = 'flex';
}

export async function initHomeNotifications() {
    const container = document.getElementById('homeNotifSection');
    if (!container) return;

    const recentPosts = await CommsManager.fetchRecentForHome();
    if (recentPosts && recentPosts.length > 0) {
        container.innerHTML = `
            <div class="notif-banner" style="background: var(--honey-gradient); padding: 12px 24px; border-radius: 12px; display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 24px;">
                <div style="display: flex; align-items: center; gap: 12px;">
                    <i class="fas fa-bell" style="color: white;"></i>
                    <span class="tiny" style="color: white;">${recentPosts[0].message}</span>
                </div>
                <a href="board.html" class="tiny" style="color: white; font-weight: 700;">View Board →</a>
            </div>
        `;
    } else {
        container.innerHTML = ''; // hide if no posts
    }
}