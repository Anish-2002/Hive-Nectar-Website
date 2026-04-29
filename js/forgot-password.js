import { supabase } from './supabase-config.js';
import { showToast } from './app.js'; 

const form = document.getElementById('forgotPasswordForm');
const btn = document.getElementById('sendLinkBtn');

form.addEventListener('submit', async (e) => {
    e.preventDefault();
    let emailInput = document.getElementById('resetEmail').value.trim();
    emailInput = emailInput.toLowerCase();               // 👈 convert to lowercase

    btn.innerText = "Processing...";
    btn.disabled = true;

    const isGitHub = window.location.hostname.includes('github.io');
    const redirectUrl = isGitHub 
        ? `https://${window.location.hostname}/Hive-Nectar-Website/reset-password.html`
        : window.location.origin + '/reset-password.html';

    try {
        console.log("Requesting password reset for:", emailInput);

        const response = await fetch('https://gxboojbfmpejbjolfmjq.supabase.co/functions/v1/send-reset-email', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                userEmail: emailInput,   // now lowercase
                redirectUrl: redirectUrl
            })
        });

        const result = await response.json();

        if (response.ok && result.success) {
            showToast("A reset link has flown to your inbox!", "success");
            form.reset();
        } else {
            // For security, don't reveal that the email doesn't exist
            showToast("If an account exists, a reset link will be sent.", "success");
            form.reset();
        }
    } catch (err) {
        console.error("Frontend Reset Error:", err);
        showToast("Connection error. Please try again later.", "error");
    } finally {
        btn.innerText = "Send Reset Link";
        btn.disabled = false;
    }
});