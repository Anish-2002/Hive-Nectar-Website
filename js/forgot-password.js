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

        if (!data) {
            showToast("This email is not registered with Hive Nectar.", "error");
            btn.innerText = "Send Reset Link";
            btn.disabled = false;
            return;
        }

        // 2. GENERATE THE SECURE RECOVERY LINK VIA SUPABASE
        const isGitHub = window.location.hostname.includes('github.io');
        const repoName = '/Hive-Nectar-Website'; 
        const resetPath = '/reset-password.html';

        const finalRedirectUrl = isGitHub 
            ? `https://${window.location.hostname}${repoName}${resetPath}`
            : window.location.origin + resetPath;

        // We ask Supabase to create the "Secret" link that Brevo will send
        const { data: linkData, error: linkError } = await supabase.auth.admin.generateLink({
            type: 'recovery',
            email: email,
            options: { redirectTo: finalRedirectUrl }
        });

        if (linkError) throw linkError;

        // This link now contains the #access_token needed to actually update the password
        const secureLink = linkData.properties.action_link;

        // 3. CALL RENDER BACKEND TO SEND BREVO EMAIL
        const response = await fetch('https://hive-nectar-backend.onrender.com/send-reset-email', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                userEmail: email,
                resetLink: secureLink // Passing the SECURE link instead of the plain one
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
        showToast("An unexpected error occurred.", "error");
    } finally {
        btn.innerText = "Send Reset Link";
        btn.disabled = false;
    }
});
