// js/login.js
import { supabase } from './supabase-config.js';

export async function handleLogin(e) {
    e.preventDefault();
    console.log("Login attempt started..."); // Debug log

    const email = document.getElementById('loginEmail').value;
    const password = document.getElementById('loginPassword').value;
    const errorElement = document.getElementById('loginError');
    const submitBtn = e.target.querySelector('button[type="submit"]');

    // UI Feedback
    errorElement.style.display = 'none';
    submitBtn.innerText = "Logging in...";
    submitBtn.disabled = true;

    try {
        const { data, error } = await supabase.auth.signInWithPassword({
            email: email,
            password: password,
        });

        if (error) {
            console.error("Supabase Error:", error.message);
            errorElement.innerText = error.message;
            errorElement.style.display = 'block';
            submitBtn.innerText = "Login";
            submitBtn.disabled = false;
            return;
        }

        if (data.user) {
            console.log("Login successful!", data.user);
            alert("Login successful! Redirecting...");
            window.location.assign('profile.html'); // Use assign for cleaner redirection
        }
    } catch (err) {
        console.error("Unexpected Error:", err);
        errorElement.innerText = "An unexpected error occurred.";
        errorElement.style.display = 'block';
        submitBtn.disabled = false;
    }
}