import { handleLogin } from './login.js';
import { setupAddressAutocomplete, handleSignup } from './signup.js';
import { initProfile } from './profile.js'; 
import { supabase } from './supabase-config.js';

// --- NEW IMPORT ---
import { handleContactSubmit } from './contact.js'; 

document.addEventListener('DOMContentLoaded', () => {
    
    // --- 1. PAGE ROUTING LOGIC ---
    const path = window.location.pathname;
    const page = path.split("/").pop();

    // If on profile.html, initialize the dashboard data
    if (page === 'profile.html' || path.endsWith('profile')) {
        initProfile();
    }

    // --- NEW: CONTACT PAGE LOGIC ---
    // Detects if the user is on contact.html to attach the listener
    if (page === 'contact.html' || path.endsWith('contact')) {
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

    // --- 3. OTP VERIFICATION LOGIC ---
    const verifyBtn = document.getElementById('verifyBtn');
    if (verifyBtn) {
        verifyBtn.addEventListener('click', async () => {
            const phone = document.getElementById('signupPhone').value;
            const otp = document.getElementById('otpCode').value;

            const { error } = await supabase.auth.verifyOtp({
                phone: phone,
                token: otp,
                type: 'sms',
            });

            if (error) {
                alert("Verification Failed: " + error.message);
            } else {
                alert("Verification Successful! Redirecting to profile...");
                window.location.href = 'profile.html';
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