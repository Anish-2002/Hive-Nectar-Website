document.addEventListener('DOMContentLoaded', () => {
    
    // 1. MOBILE MENU LOGIC (Unified)
    const menuToggle = document.getElementById('menuToggle');
    const navLinks = document.getElementById('navLinks');

    if (menuToggle && navLinks) {
        menuToggle.addEventListener('click', (e) => {
            e.preventDefault();
            navLinks.classList.toggle('active');
            
            // Toggle the Icon between Hamburger (fa-bars) and X (fa-xmark)
            const icon = menuToggle.querySelector('i');
            if (icon) {
                if (navLinks.classList.contains('active')) {
                    icon.classList.remove('fa-bars');
                    icon.classList.add('fa-xmark');
                } else {
                    icon.classList.remove('fa-xmark');
                    icon.classList.add('fa-bars');
                }
            }
        });

        // Close menu if user clicks a link (important for single-page jumps)
        navLinks.querySelectorAll('a').forEach(link => {
            link.addEventListener('click', () => {
                navLinks.classList.remove('active');
                const icon = menuToggle.querySelector('i');
                if (icon) {
                    icon.classList.replace('fa-xmark', 'fa-bars');
                }
            });
        });
    }

    // 2. FORM PERSISTENCE LOGIC
    const forms = ['joinForm', 'contactForm'];
    forms.forEach(id => {
        const f = document.getElementById(id);
        if (f) {
            f.addEventListener('submit', (e) => {
                e.preventDefault();
                f.classList.add('hide');
                const feedback = document.getElementById(id + 'Feedback');
                if (feedback) feedback.classList.remove('hide');
            });
        }
    });

    // 3. LOGIN VALIDATION LOGIC
    const loginForm = document.getElementById('loginForm');
    const loginError = document.getElementById('loginError');
    const users = [
        { email: "bee@hivenectar.com", password: "password123", name: "Busy Bee" },
        { email: "test@user.com", password: "hivepassword", name: "Test User" }
    ];

    if (loginForm) {
        loginForm.addEventListener('submit', (e) => {
            e.preventDefault();
            const email = document.getElementById('loginEmail').value;
            const pass = document.getElementById('loginPassword').value;
            const user = users.find(u => u.email === email);

            if (!user) {
                loginError.textContent = "User does not exist, please sign up.";
                loginError.style.display = "block";
            } else if (user.password !== pass) {
                loginError.textContent = "Incorrect password.";
                loginError.style.display = "block";
            } else {
                localStorage.setItem('hive_user_session', JSON.stringify({
                    email: user.email,
                    name: user.name,
                    loggedIn: true
                }));
                window.location.href = 'profile.html';
            }
        });
    }
});

// 4. ROUTE GUARD & POPUPS
if (window.location.pathname.includes('profile.html')) {
    const session = JSON.parse(localStorage.getItem('hive_user_session'));
    if (!session || !session.loggedIn) {
        window.location.href = 'login.html';
    }
}

function openSharePopup() {
    const modal = document.getElementById('shareModal');
    if(modal) modal.style.display = 'grid';
}

function closeSharePopup() {
    const modal = document.getElementById('shareModal');
    if(modal) modal.style.display = 'none';
}