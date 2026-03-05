import { supabase } from './supabase-config.js';
import { showToast } from './app.js'; 

const form = document.getElementById('forgotPasswordForm');
const btn = document.getElementById('sendLinkBtn');

form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = document.getElementById('resetEmail').value;
    
    // UI Feedback: Start
    btn.innerText = "Checking...";
    btn.disabled = true;

    try {
        // 1. CHECK IF USER EXISTS
        const { data, error: fetchError } = await supabase
            .from('profiles') 
            .select('email')
            .eq('email', email)
            .single();

        if (!data) {
            showToast("This email is not registered with Hive Nectar.", "error");
            // RESET BUTTON so user can fix typo
            btn.innerText = "Send Reset Link";
            btn.disabled = false;
            return;
        }

        // 2. SUCCESS: Email found, now send the link
       const isGitHub = window.location.hostname.includes('github.io');
const repoName = '/Hive-Nectar-Website'; // Your GitHub repository name
const resetPath = '/reset-password.html';

// If on GitHub, use full path with repo name. Otherwise, use standard origin.
const finalRedirectUrl = isGitHub 
    ? `https://${window.location.hostname}${repoName}${resetPath}`
    : window.location.origin + resetPath;

console.log("Redirecting user to:", finalRedirectUrl);

// 2. Send the reset link with the correct URL
const { error: resetError } = await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: finalRedirectUrl,
});

        if (resetError) {
            showToast(resetError.message, "error");
            btn.innerText = "Send Reset Link";
            btn.disabled = false;
        } else {
            showToast("A reset link has flown to your inbox!", "success");
            form.reset();
            btn.innerText = "Send Reset Link";
            btn.disabled = false;
        }
    } catch (err) {
        showToast("An unexpected error occurred.", "error");
        btn.innerText = "Send Reset Link";
        btn.disabled = false;
    }

});

