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
        // 1. CHECK IF USER EXISTS IN DATABASE
        const { data, error: fetchError } = await supabase
            .from('profiles') 
            .select('email')
            .eq('email', email)
            .maybeSingle();

        if (fetchError) throw fetchError;

        if (!data) {
            showToast("This email is not registered with Hive Nectar.", "error");
            return;
        }

        // 2. CONSTRUCT THE RESET PATH
        const isGitHub = window.location.hostname.includes('github.io');
        const repoName = '/Hive-Nectar-Website'; 
        const resetPath = '/reset-password.html';

        const finalRedirectUrl = isGitHub 
            ? `https://${window.location.hostname}${repoName}${resetPath}`
            : window.location.origin + resetPath;

        // 3. GENERATE SECURE LINK (Requires Service Role Key in supabase-config.js)
        const { data: linkData, error: linkError } = await supabase.auth.admin.generateLink({
            type: 'recovery',
            email: email,
            options: { redirectTo: finalRedirectUrl }
        });

        if (linkError) {
            console.error("Link Generation Error:", linkError.message);
            throw new Error("Permission denied. Ensure you are using the Service Role Key.");
        }

        const secureLink = linkData.properties.action_link;

        // 4. CALL RENDER BACKEND TO SEND BREVO EMAIL
        const response = await fetch('https://hive-nectar-backend.onrender.com/send-reset-email', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                userEmail: email,
                resetLink: secureLink // This now contains the required token
            })
        });

        const result = await response.json();

        if (result.success) {
            showToast("A reset link has flown to your inbox!", "success");
            form.reset();
        } else {
            showToast("Failed to send reset email. Please try again.", "error");
        }

    } catch (err) {
        console.error("Forgot Password Error:", err);
        // This shows the specific error instead of just "unexpected error"
        showToast(err.message || "An unexpected error occurred.", "error");
    } finally {
        btn.innerText = "Send Reset Link";
        btn.disabled = false;
    }
});
