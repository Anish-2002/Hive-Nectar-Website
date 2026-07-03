// js/login.js
import { supabase } from './supabase-config.js';
import { showToast, Loader } from './app.js';
export async function handleLogin(e) {
    e.preventDefault();
    
    const email = document.getElementById('loginEmail').value;
    const password = document.getElementById('loginPassword').value;
    const submitBtn = e.target.querySelector('button[type="submit"]');

    // 2. Show the Global Buffer Popup
    Loader.show("Verifying your credentials...");
    
    // UI Feedback: Start
    submitBtn.innerText = "Logging in...";
    submitBtn.disabled = true;
    
    try {
        const { data, error } = await supabase.auth.signInWithPassword({
            email: email,
            password: password,
        });

        if (error) {
            // Use the custom notification
            showToast(error.message, "error");
            
            // RESET BUTTON: This allows the user to click it again
            submitBtn.innerText = "Login";
            submitBtn.disabled = false;
            return;
        }

        if (data.user) {
            showToast("Welcome to the Meadow!", "success");
            // Successful login leads to a page change, so no need to reset button
            window.location.assign('profile.html'); 
        }
    } catch (err) {
        console.error("Unexpected Error:", err);
        showToast("An unexpected error occurred.", "error");
        
        // RESET BUTTON: Ensure button is clickable if a crash happens
        submitBtn.innerText = "Login";
        submitBtn.disabled = false;
    }
    finally {
        // 2. THIS IS THE FIX: 
        // This line runs even if an error occurred above.
        // It clears the buffering overlay so the user can see the error toast.
        Loader.hide();
    }
}