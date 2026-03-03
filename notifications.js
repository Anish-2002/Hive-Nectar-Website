async function checkLiveBuzz() {
    try {
        // Pull data from LocalStorage instead of a physical file
        const storedData = localStorage.getItem('admin_comms');
        if (!storedData) return;

        const data = JSON.parse(storedData);
        const now = new Date();
        
        // Filter posts from the last 24 hours
        const activePosts = data.posts.filter(post => {
            const postDate = new Date(post.created_at);
            return (now - postDate) / (1000 * 60 * 60) <= 24;
        });

        if (activePosts.length > 0) {
            // Remove old one if it exists before re-rendering
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
    
    const postsHtml = posts.map(post => `
        <div class="preview-item">
            <h4>${post.title}</h4>
            <p>${post.short_desc}</p>
            <a href="board.html" class="preview-link">Read More →</a>
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
    
    // Toggle the preview card when clicking the circle
    container.querySelector('.messenger-circle').addEventListener('click', (e) => {
        e.stopPropagation();
        document.getElementById('buzzPreview').classList.toggle('show');
    });

    document.body.appendChild(container);
}

// Check every 5 seconds for new posts (simulating real-time)
setInterval(checkLiveBuzz, 5000);
document.addEventListener('DOMContentLoaded', checkLiveBuzz);