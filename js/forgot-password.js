import { supabase } from './supabase-config.js';
import { showToast } from './app.js'; 

const form = document.getElementById('forgotPasswordForm');
const btn = document.getElementById('sendLinkBtn');

form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = document.getElementById('resetEmail').value;
    
    btn.innerText = "Processing...";
    btn.disabled = true;

    try {
        // 1. Fetch both email and display_name from the profiles table
        const { data } = await supabase
            .from('profiles') 
            .select('email, display_name') // Added display_name to the selection
            .eq('email', email)
            .maybeSingle();

        if (!data) {
            showToast("This email is not registered.", "error");
            return;
        }

        const isGitHub = window.location.hostname.includes('github.io');
        const finalRedirectUrl = isGitHub 
            ? `https://${window.location.hostname}/Hive-Nectar-Website/reset-password.html`
            : window.location.origin + '/reset-password.html';

        // 2. Send the userEmail, redirectUrl, and the retrieved userName to your backend
        const response = await fetch('https://hive-nectar-backend.onrender.com/send-reset-email', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                userEmail: email,
                userName: data.display_name, // Pass the name fetched from Supabase
                redirectUrl: finalRedirectUrl
            })
        });

        const result = await response.json();

        if (result.success) {
            showToast("Check your inbox for the secure link!", "success");
            form.reset();
        } else {
            throw new Error(result.error || "Failed to send email");
        }

    } catch (err) {
        console.error("Reset Error:", err);
        showToast("An error occurred. Please try again.", "error");
    } finally {
        btn.innerText = "Send Reset Link";
        btn.disabled = false;
    }
});
