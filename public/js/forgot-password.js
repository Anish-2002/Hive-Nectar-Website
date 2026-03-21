import { supabase } from './supabase-config.js';
import { showToast } from './app.js'; 

const form = document.getElementById('forgotPasswordForm');
const btn = document.getElementById('sendLinkBtn');

form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const emailInput = document.getElementById('resetEmail').value.trim();
    
    btn.innerText = "Processing...";
    btn.disabled = true;

    try {
        console.log("Attempting to find user:", emailInput);

        // 1. Try to fetch user from 'profiles' table
        const { data: profile, error: profileError } = await supabase
            .from('profiles') 
            .select('email, first_name') 
            .eq('email', emailInput)
            .maybeSingle();

        if (profileError) {
            console.error("Supabase RLS/Query Error:", profileError.message);
        }

        // 2. Fallback logic: If profile query fails or is empty, 
        // we still want to try sending the email using the input email
        const finalEmail = profile ? profile.email : emailInput;
        const finalName = profile ? profile.first_name : "Valued Member";

        // 3. Determine redirect URL for GitHub vs Localhost
        const isGitHub = window.location.hostname.includes('github.io');
        const finalRedirectUrl = isGitHub 
            ? `https://${window.location.hostname}/Hive-Nectar-Website/reset-password.html`
            : window.location.origin + '/reset-password.html';

        console.log("Sending request to backend for:", finalEmail);

        // 4. Send to Render Backend
        const response = await fetch('https://hive-nectar-backend.onrender.com/send-reset-email', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                userEmail: finalEmail,
                userName: finalName,
                redirectUrl: finalRedirectUrl
            })
        });

        const result = await response.json();

        if (response.ok && result.success) {
            showToast("A reset link has flown to your inbox!", "success");
            form.reset();
        } else {
            // This captures the 400 error message from your server
            const errorMsg = result.error || "Server rejected the request";
            console.error("Backend 400/500 Error:", errorMsg);
            
            if (errorMsg.includes("User not found")) {
                showToast("No account found with that email.", "error");
            } else {
                showToast(`Error: ${errorMsg}`, "error");
            }
        }

    } catch (err) {
        console.error("Frontend Reset Error:", err);
        showToast("Connection error. Is the backend awake?", "error");
    } finally {
        btn.innerText = "Send Reset Link";
        btn.disabled = false;
    }
});


