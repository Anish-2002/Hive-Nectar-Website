import { supabase } from './supabase-config.js';
import { showToast } from './app.js'; 

const form = document.getElementById('forgotPasswordForm');
const btn = document.getElementById('sendLinkBtn');
const emailInput = document.getElementById('resetEmail');

if (!form || !btn || !emailInput) {
    console.warn('Password reset form elements not found');
} else {
    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const email = emailInput.value.trim().toLowerCase();

        btn.innerText = "Processing...";
        btn.disabled = true;

        // Dynamic redirect URL — works on localhost AND GitHub Pages
        const currentPath = window.location.pathname;
        const basePath = currentPath.substring(0, currentPath.lastIndexOf('/') + 1);
        const redirectUrl = `${window.location.origin}${basePath}reset-password.html`;

        const { error } = await supabase.auth.resetPasswordForEmail(email, {
            redirectTo: redirectUrl,
        });

        if (error) {
            showToast(error.message, "error");
        } else {
            showToast("A reset link has flown to your inbox!", "success");
        }

        form.reset();
        btn.innerText = "Send Reset Link";
        btn.disabled = false;
    });
}