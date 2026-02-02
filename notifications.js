async function checkLiveBuzz() {
    try {
        const response = await fetch('admin_comms.json');
        const data = await response.json();
        const now = new Date();
        
        // Filter posts from the last 24 hours
        const activePosts = data.posts.filter(post => {
            const postDate = new Date(post.created_at);
            return (now - postDate) / (1000 * 60 * 60) <= 24;
        });

        if (activePosts.length > 0) {
            renderMessengerBadge(activePosts);
        }
    } catch (e) { 
        console.log("Waiting for admin_comms.json..."); 
    }
}

function renderMessengerBadge(posts) {
    const container = document.createElement('div');
    container.id = 'messenger-buzz';
    
    // Generate the HTML for each post inside the preview card
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
                    <button onclick="document.getElementById('buzzPreview').classList.remove('show')">×</button>
                </div>
                <div class="preview-body">
                    ${postsHtml}
                </div>
            </div>
        </div>
    `;
    
    container.querySelector('.messenger-circle').addEventListener('click', () => {
        document.getElementById('buzzPreview').classList.toggle('show');
    });

    document.body.appendChild(container);
}

document.addEventListener('DOMContentLoaded', checkLiveBuzz);