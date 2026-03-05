import { supabase } from './supabase-config.js';
import { showToast } from './app.js'; 

const form = document.getElementById('forgotPasswordForm');
const btn = document.getElementById('sendLinkBtn');

form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = document.getElementById('resetEmail').value.trim(); // Added trim() to prevent space errors
    
    btn.innerText = "Processing...";
    btn.disabled = true;

    try {
        // 1. Fetch user data
        // Double check if your column is 'display_name' or 'full_name' in Supabase
        const { data, error: supabaseError } = await supabase
            .from('profiles') 
            .select('email, display_name') 
            .eq('email', email)
            .maybeSingle();

        // Log exactly what is happening to solve the "user not found" mystery
        console.log("Input Email:", email);
        console.log("Supabase Data:", data);
        if (supabaseError) console.error("Supabase Query Error:", supabaseError);

        if (!data) {
            showToast("This email is not registered.", "error");
            return;
        }

        const isGitHub = window.location.hostname.includes('github.io');
        const finalRedirectUrl = isGitHub 
            ? `https://${window.location.hostname}/Hive-Nectar-Website/reset-password.html`
            : window.location.origin + '/reset-password.html';

        // 2. Send to Backend
        const response = await fetch('https://hive-nectar-backend.onrender.com/send-reset-email', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                userEmail: data.email, // Use the email from the database
                userName: data.display_name || "Valued Member", // Fallback if name is empty
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
