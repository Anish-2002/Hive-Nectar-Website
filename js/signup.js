import { supabase } from './supabase-config.js';
import { sendWelcomeEmail } from './email.js';
import { showToast, Loader } from './app.js';

export async function handleSignup(e) {
    e.preventDefault();

    const email = document.getElementById('signupEmail').value;
    const password = document.getElementById('signupPass').value;
    const firstName = document.getElementById('signupFirst').value;
    const lastName = document.getElementById('signupLast').value;
    const username = document.getElementById('signupUsername').value;

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
        showToast("Please enter a valid email address.", "error");
        return;
    }
    if (!username.trim()) {
        showToast("Please choose a username.", "error");
        return;
    }

    Loader.show("Creating your Hive profile...");
    const submitBtn = e.target.querySelector('button[type="submit"]');
    if (submitBtn) submitBtn.disabled = true;

    try {
        const { data: authData, error: authError } = await supabase.auth.signUp({
            email,
            password,
            options: {
                data: {
                    first_name: firstName,
                    last_name: lastName,
                    username: username
                }
            }
        });
        if (authError) throw authError;

        const { error: dbError } = await supabase
            .from('profiles')
            .insert([
                {
                    id: authData.user.id,
                    first_name: firstName,
                    last_name: lastName,
                    username: username,
                    email: email,
                    tier: 'Tier 0',
                    member_tier: 0,
                    user_level: 'Novice',
                    engagement_level: 'Seed',
                    experience: 0,
                    nectar_points: 0,
                    total_tasks_completed: 0,
                    join_date: new Date().toISOString()
                }
            ]);
        if (dbError) throw dbError;

        try {
            await sendWelcomeEmail(email, firstName);
        } catch (emailErr) {
            console.error("Welcome email failed:", emailErr);
        }

        showToast("Account created! Please log in.", "success");
        setTimeout(() => {
            window.location.replace('login.html');
        }, 1500);

    } catch (err) {
        console.error("Signup error:", err);
        showToast(err.message, "error");
        if (submitBtn) submitBtn.disabled = false;
    } finally {
        Loader.hide();
    }
}