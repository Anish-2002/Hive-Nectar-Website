document.addEventListener('DOMContentLoaded', () => {
    // 1. Mobile Menu Toggle
    const menuToggle = document.getElementById('menuToggle');
    const navLinks = document.getElementById('navLinks');

    if (menuToggle) {
        menuToggle.addEventListener('click', () => {
            navLinks.classList.toggle('active');
        });
    }

    // 2. Phase 1 Form Logic (Static Persistence)
    const forms = ['joinForm', 'contactForm'];
    forms.forEach(id => {
        const f = document.getElementById(id);
        if (f) {
            f.addEventListener('submit', (e) => {
                e.preventDefault();
                // Basic Phase 1 behavior: Hide form, show confirmation placeholder
                f.classList.add('hide');
                const feedback = document.getElementById(id + 'Feedback');
                if (feedback) feedback.classList.remove('hide');
            });
        }
    });
});

// Add this to your existing DOMContentLoaded listener in app.js
document.addEventListener('DOMContentLoaded', () => {
    
    // Existing code for menu and contact forms...

    // 3. Login Validation Logic
    const loginForm = document.getElementById('loginForm');
    const loginError = document.getElementById('loginError');

    // Simulated JSON data
    const users = [
        { email: "bee@hivenectar.com", password: "password123", name: "Busy Bee" },
        { email: "test@user.com", password: "hivepassword", name: "Test User" }
    ];

    if (loginForm) {
        loginForm.addEventListener('submit', (e) => {
            e.preventDefault();
            const email = document.getElementById('loginEmail').value;
            const pass = document.getElementById('loginPassword').value;

            // Find user
            const user = users.find(u => u.email === email);

            if (!user) {
                loginError.textContent = "User does not exist, please sign up.";
                loginError.style.display = "block";
            } else if (user.password !== pass) {
                loginError.textContent = "Incorrect password.";
                loginError.style.display = "block";
            } else {
                // Success: Save user session to localStorage and redirect
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

// Simple route guard for the Profile page
if (window.location.pathname.includes('profile.html')) {
    const session = JSON.parse(localStorage.getItem('hive_user_session'));
    if (!session || !session.loggedIn) {
        window.location.href = 'login.html'; // Redirect to login if not authenticated
    }
}