import { supabase } from './supabase-config.js';

/**
 * Internal Loader Helper
 */
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

/**
 * Board UI Logic
 */
export async function initCommunicationBoard() {
    const boardContainer = document.getElementById('dynamicBoard');
    if (!boardContainer) return;

    Loader.show("Fetching hive updates...");

    try {
        const posts = await CommsManager.fetchAllPosts();
        renderFilters(posts);
        renderPosts(posts, 'all'); 
        // --- To link to comms pop up ---
        const urlParams = new URLSearchParams(window.location.search);
        const postId = urlParams.get('postId');
        if (postId) openPost(postId, posts);
        
        const modal = document.getElementById('commsModal');
        const closeBtn = document.querySelector('.close-modal');

        if (closeBtn && modal) {
            closeBtn.onclick = () => modal.classList.remove('active');
            window.onclick = (e) => { if (e.target === modal) modal.classList.remove('active'); };
        }
    } catch (err) {
        console.error("Critical Board Error:", err);
    } finally {
        Loader.hide();
    }
}

function renderFilters(posts) {
    const recentContainer = document.getElementById('recent-pill-container');
    const dropdown = document.getElementById('categoryDropdown');
    const globalBadge = document.getElementById('dropdown-global-badge');
    
    if (!recentContainer || !dropdown) return;

    const now = new Date();
    const cutoff = new Date(now.getTime() - (24 * 60 * 60 * 1000));

    // 1. Render the Pinned "Recent" Pill
    const recentCount = posts.filter(p => new Date(p.created_at) > cutoff).length;
    recentContainer.innerHTML = `
        <button class="pill active" data-type="recent" id="recentBtn">
            Recent
            ${recentCount > 0 ? `<span class="notif-badge">${recentCount}</span>` : ''}
        </button>
    `;

    // 2. DYNAMICALLY Identify All Categories
    const allUniqueTags = [...new Set(posts.map(p => p.post_type))].sort();
    let totalNewInDropdown = 0;

    dropdown.innerHTML = `
        <option value="" disabled selected hidden>Select Categories</option>
        <option value="all">All Categories</option>
    `;
    
    
    allUniqueTags.forEach(type => {
    const newCount = posts.filter(p => p.post_type === type && new Date(p.created_at) > cutoff).length;
    if (newCount > 0) totalNewInDropdown += newCount;

    const option = document.createElement('option');
    option.value = type;
    
    const label = type.charAt(0).toUpperCase() + type.slice(1);
    
    if (newCount > 0) {
        // If there are new updates, make the text red and add the count
        option.textContent = `${label} (${newCount})`;
        option.style.color = "var(--error)"; // Uses your existing red color
        option.style.fontWeight = "bold";
    } else {
        option.textContent = label;
    }
    
    dropdown.appendChild(option);
});

    // 3. Global Notification Dot (Kept as a dot for the closed dropdown UI)
    if (globalBadge) {
    if (totalNewInDropdown > 0) {
        globalBadge.innerText = totalNewInDropdown; // Set the actual number
        globalBadge.classList.remove('hidden');
    } else {
        globalBadge.classList.add('hidden');
    }
}

    // 4. Interaction Logic
    const recentBtn = document.getElementById('recentBtn');
    recentBtn.onclick = () => {
    recentBtn.classList.add('active');
    // We set this to an empty string so that selecting "all" 
    // later will ALWAYS trigger the onchange event
    dropdown.value = ""; 
    renderPosts(posts, 'recent');
};

    dropdown.onchange = (e) => {
    const selectedValue = e.target.value;
    
    // Fix: If user selects "All Categories" from the dropdown, 
    // we treat it as an 'all' filter and deactivate the Recent button.
    if (selectedValue === "all") {
        recentBtn.classList.remove('active');
        renderPosts(posts, 'all');
    } else {
        recentBtn.classList.remove('active');
        renderPosts(posts, selectedValue);
    }
};
}

function renderPosts(posts, filter) {
    const board = document.getElementById('dynamicBoard');
    if (!board) return;

    const now = new Date();
    const cutoff = new Date(now.getTime() - (24 * 60 * 60 * 1000));

    let filtered;
    if (filter === 'all') {
        filtered = posts;
    } else if (filter === 'recent') {
        filtered = posts.filter(p => new Date(p.created_at) > cutoff);
    } else {
        filtered = posts.filter(p => p.post_type === filter);
    }
    
    if (filtered.length === 0) {
        board.innerHTML = `<p style="text-align:center; color:var(--muted); margin-top:20px;">No updates found for this category.</p>`;
        return;
    }

    board.innerHTML = filtered.map((post) => `
        <section class="card glass-card clickable-post" data-id="${post.id}">
            <div class="update-header-row">
                <span class="type-tag ${getDotColor(post.post_type)}">${post.post_type}</span>
                <span class="post-date">${new Date(post.created_at).toLocaleDateString()}</span>
            </div>
            <p class="post-preview">${post.message.substring(0, 100)}${post.message.length > 100 ? '...' : ''}</p>
            <span class="read-more">Read More →</span>
        </section>
    `).join('');

    board.querySelectorAll('.clickable-post').forEach(card => {
        card.onclick = () => openPost(card.dataset.id, posts);
    });
}

function openPost(id, posts) {
    const post = posts.find(p => p.id === id);
    if (!post) return;

    const modal = document.getElementById('commsModal');
    const content = document.getElementById('modalData');
    
    content.innerHTML = `
        <h2 style="color: var(--fg); margin-bottom: 5px;">${post.post_type.toUpperCase()}</h2>
        <p style="color: var(--muted); font-size: 0.8rem; margin-bottom: 15px;">
            ${new Date(post.created_at).toLocaleString()}
        </p>
        <hr style="border:0; border-top:1px solid var(--border); margin-bottom:15px;">
        <p style="line-height:1.6; color:var(--fg); white-space:pre-wrap;">${post.message}</p>
    `;
    modal.classList.add('active');
}

function getDotColor(type) {
    const colors = { 'announcements': 'red', 'system updates': 'orange', 'community': 'green' };
    return colors[type] || 'blue';
}

export async function initHomeNotifications() {
    const homeNotifContainer = document.getElementById('homeNotifSection');
    if (!homeNotifContainer) return;

    const recentPosts = await CommsManager.fetchRecentForHome();
    
    if (recentPosts && recentPosts.length > 0) {
        homeNotifContainer.innerHTML = `
            <div class="notif-banner">
                <i class="fas fa-bell"></i>
                <span class="notif-text">${recentPosts[0].message}</span>
                <a href="board.html" class="notif-link">View Board</a>
            </div>
        `;
    } else {
        homeNotifContainer.innerHTML = ''; 
    }
}