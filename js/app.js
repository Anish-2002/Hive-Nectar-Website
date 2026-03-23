import { handleLogin } from './login.js';
import { handleSignup } from './signup.js';          // only handleSignup now
import { initProfile } from './profile.js';
import { supabase } from './supabase-config.js';
import { handleContactSubmit } from './contact.js';
import { initCommunicationBoard, initHomeNotifications } from './comms.js';

export const Loader = {
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

document.addEventListener('DOMContentLoaded', () => {
    const path = window.location.pathname;

    if (path.includes('profile.html')) {
        console.log("Initializing Profile...");
        initProfile();
    }

    if (path.includes('contact.html')) {
        const contactForm = document.getElementById('contactForm');
        if (contactForm) {
            contactForm.addEventListener('submit', handleContactSubmit);
        }
    }

    // Home Page Notifications
    if (path === '/' || path.includes('index.html')) {
        initHomeNotifications();
    }

    // Communication Board Page
    if (path.includes('board.html')) {
        initCommunicationBoard();
    }

    // Signup form – now we only have the simple form
    const signupForm = document.getElementById('signupForm');
    if (signupForm) {
        signupForm.addEventListener('submit', handleSignup);
    }

    // Password recovery logic
    if (window.location.hash.includes('type=recovery')) {
        supabase.auth.onAuthStateChange(async (event) => {
            if (event === "PASSWORD_RECOVERY") {
                showToast("Verification Successful! Redirecting to reset page...");
                window.location.replace('./reset-password.html');
            }
        });
    }

    // Login form
    const loginForm = document.getElementById('loginForm');
    if (loginForm) {
        loginForm.addEventListener('submit', handleLogin);
    }

    // Mobile menu toggle
    const menuToggle = document.getElementById('menuToggle');
    const navLinks = document.getElementById('navLinks');
    if (menuToggle && navLinks) {
        menuToggle.addEventListener('click', function() {
            navLinks.classList.toggle('show');
        });
    }
});

export function showToast(message, type = 'success') {
    let container = document.getElementById('toast-container');
    if (!container) {
        container = document.createElement('div');
        container.id = 'toast-container';
        document.body.appendChild(container);
    }

    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    const iconClass = type === 'error' ? 'fa-circle-exclamation' : 'fa-check-circle';
    toast.innerHTML = `<i class="fas ${iconClass}"></i><span>${message}</span>`;
    container.appendChild(toast);

    setTimeout(() => {
        toast.style.animation = 'fadeOut 0.5s forwards';
        setTimeout(() => toast.remove(), 500);
    }, 4000);
}