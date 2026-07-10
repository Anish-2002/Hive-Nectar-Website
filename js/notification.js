import { supabase } from './supabase-config.js'; // Added relative path for js folder

async function checkLiveBuzz() {
    try {
        const now = new Date();
        const twentyFourHoursAgo = new Date(now.getTime() - (24 * 60 * 60 * 1000)).toISOString();
        
        // Fetch from Supabase instead of LocalStorage
        const { data: activePosts, error } = await supabase
            .from('communications')
            .select('*')
            .gt('created_at', twentyFourHoursAgo)
            .order('created_at', { ascending: false });

        if (error) throw error;

        if (activePosts && activePosts.length > 0) {
            const oldBadge = document.getElementById('messenger-buzz');
            if(oldBadge) oldBadge.remove();
            
            renderMessengerBadge(activePosts);
        }
    } catch (e) { 
        console.log("Error checking for buzz:", e); 
    }
}

function renderMessengerBadge(posts) {
    const container = document.createElement('div');
    container.id = 'messenger-buzz';
    
    // Logic: Redirect to board.html with the specific postId in the URL
    const postsHtml = posts.map(post => `
        <div class="preview-item">
            <h4>${post.post_type.toUpperCase()}</h4>
            <p>${post.message.substring(0, 60)}...</p>
            <a href="board.html?postId=${post.id}" class="preview-link">Read More →</a>
            <hr class="preview-divider">
        </div>
    `).join('');

    container.innerHTML = `
        <div class="messenger-wrapper">
            <div class="messenger-circle">
                <i class="fas fa-comment-dots"></i>
                <span class="notification-count">${posts.length}</span>
            </div>
            <div class="buzz-preview-card" id="buzzPreview">
                <div class="preview-header">
                    <strong>New Buzz (${posts.length})</strong>
                    <button class="close-buzz" onclick="document.getElementById('buzzPreview').classList.remove('show')">×</button>
                </div>
                <div class="preview-body">
                    ${postsHtml}
                </div>
            </div>
        </div>
    `;
    
    container.querySelector('.messenger-circle').addEventListener('click', (e) => {
        e.stopPropagation();
        document.getElementById('buzzPreview').classList.toggle('show');
    });

    document.body.appendChild(container);
}

setInterval(checkLiveBuzz, 10000); // Check every 10s
document.addEventListener('DOMContentLoaded', checkLiveBuzz);