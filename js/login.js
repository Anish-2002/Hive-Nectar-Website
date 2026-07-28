// js/login.js
import { supabase } from './supabase-config.js';
import { showToast, Loader } from './app.js';

export async function handleLogin(e) {
    e.preventDefault();
    
    const emailEl = document.getElementById('loginEmail');
    const passEl = document.getElementById('loginPassword');
    if (!emailEl || !passEl) {
        showToast("Login form not found. Please refresh.", "error");
        return;
    }
    
    const email = emailEl.value;
    const password = passEl.value;
    const submitBtn = e.target.querySelector('button[type="submit"]');

    Loader.show("Verifying your credentials...");
    if (submitBtn) {
        submitBtn.innerText = "Logging in...";
        submitBtn.disabled = true;
    }
    
    try {
        const { data, error } = await supabase.auth.signInWithPassword({
            email, password,
        });

        if (error) {
            showToast(error.message, "error");
            if (submitBtn) {
                submitBtn.innerText = "Login";
                submitBtn.disabled = false;
            }
            return;
        }

        if (data.user) {
            showToast("Welcome to the Meadow!", "success");
            window.location.assign('profile.html'); 
        }
    } catch (err) {
        showToast("An unexpected error occurred.", "error");
        if (submitBtn) {
            submitBtn.innerText = "Login";
            submitBtn.disabled = false;
        }
    } finally {
        Loader.hide();
    }
}
