import { handleLogin } from './login.js';
import { setupAddressAutocomplete, handleSignup } from './signup.js';
import { initProfile } from './profile.js'; 
import { supabase } from './supabase-config.js';
import { handleContactSubmit } from './contact.js'; 

document.addEventListener('DOMContentLoaded', () => {
    
    // --- 1. IMPROVED ROUTING LOGIC ---
    // Works on both Localhost and GitHub Pages Subdirectories
    const path = window.location.pathname;

    // Profile Page
    if (path.includes('profile.html')) {
        console.log("Initializing Profile...");
        initProfile();
    }

    // Contact Page
    if (path.includes('contact.html')) {
        const contactForm = document.getElementById('contactForm');
        if (contactForm) {
            contactForm.addEventListener('submit', handleContactSubmit);
        }
    }

    // --- 2. SIGNUP PAGE LOGIC ---
    const signupAddressInput = document.getElementById('signupAddress');
    if (signupAddressInput) {
        setupAddressAutocomplete();
    }

    const signupForm = document.getElementById('signupForm');
    if (signupForm) {
        signupForm.addEventListener('submit', handleSignup);
    }

    // --- 3. PASSWORD RECOVERY LOGIC ---
    // This handles the redirect from the email link
    if (window.location.hash.includes('type=recovery')) {
        supabase.auth.onAuthStateChange(async (event) => {
            if (event === "PASSWORD_RECOVERY") {
                showToast("Verification Successful! Redirecting to reset page...");
                // Using a relative redirect for portability
                window.location.replace('./reset-password.html');
            }
        });
    }

    // --- 4. LOGIN PAGE LOGIC ---
    const loginForm = document.getElementById('loginForm');
    if (loginForm) {
        loginForm.addEventListener('submit', handleLogin);
    }

    // --- 5. GLOBAL UI LOGIC ---
    const menuToggle = document.getElementById('menuToggle');
    const navLinks = document.getElementById('navLinks');
    if (menuToggle && navLinks) {
        menuToggle.addEventListener('click', () => {
            navLinks.classList.toggle('active');
        });
    }
});

/**
 * Global notification function
 */
export function showToast(message, type = 'success') {
    let container = document.getElementById('toast-container');
    if (!container) {
        container = document.createElement('div');
        container.id = 'toast-container';
        document.body.appendChild(container);
    }

    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    
    // Choose icon
    const iconClass = type === 'error' ? 'fa-circle-exclamation' : 'fa-check-circle';
    
    toast.innerHTML = `
        <i class=\"fas ${iconClass}\"></i>
        <span>${message}</span>
    `;

    container.appendChild(toast);

    // Auto-remove after 4 seconds
    setTimeout(() => {
        toast.style.animation = 'fadeOut 0.5s forwards';
        setTimeout(() => toast.remove(), 500);
    }, 4000);
}
