import { supabase } from './supabase-config.js';
import { sendWelcomeEmail } from './email.js';
import { showToast, Loader } from './app.js'; // Ensure Loader is imported

// --- Address Auto-populate Logic (No changes here) ---
export function setupAddressAutocomplete() {
    const addressInput = document.getElementById('signupAddress');
    const suggestionsContainer = document.getElementById('addressSuggestions');

    addressInput.addEventListener('input', async (e) => {
        const query = e.target.value;
        if (query.length < 3) {
            suggestionsContainer.style.display = 'none';
            return;
        }

        try {
            const response = await fetch(`https://nominatim.openstreetmap.org/search?format=json&countrycodes=au&q=${encodeURIComponent(query)}`);
            const data = await response.json();

            suggestionsContainer.innerHTML = '';
            if (data.length > 0) {
                data.slice(0, 5).forEach(place => {
                    const div = document.createElement('div');
                    div.innerText = place.display_name;
                    div.onclick = () => {
                        addressInput.value = place.display_name;
                        suggestionsContainer.style.display = 'none';
                    };
                    suggestionsContainer.appendChild(div);
                });
                suggestionsContainer.style.display = 'block';
            } else {
                suggestionsContainer.style.display = 'none';
            }
        } catch (error) {
            console.error("Address API Error", error);
        }
    });
}

// --- Signup Logic ---
export async function handleSignup(e) {
    e.preventDefault();

    const email = document.getElementById('signupEmail').value;
    const password = document.getElementById('signupPass').value;
    const firstName = document.getElementById('signupFirst').value;
    const lastName = document.getElementById('signupLast').value;
    const phone = document.getElementById('signupPhone').value;
    const address = document.getElementById('signupAddress').value;
    const submitBtn = e.target.querySelector('button[type="submit"]');

    // 1. Basic Email Validation (Client-side check before showing loader)
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
        showToast("Please enter a valid email address.", "error");
        return;
    }

    // START LOADING
    Loader.show("Creating your Hive profile...");
    if (submitBtn) submitBtn.disabled = true;

    try {
        // 2. Signup in Supabase Auth
        const { data: authData, error: authError } = await supabase.auth.signUp({
            email,
            password,
            options: {
                data: {
                    first_name: firstName,
                    last_name: lastName,
                },
            },
        });

        if (authError) throw authError;

        // 3. Insert into Profiles Table
        const { error: dbError } = await supabase
            .from('profiles')
            .insert([
                { 
                    id: authData.user.id, 
                    first_name: firstName,
                    last_name: lastName,
                    email: email,
                    phone_number: phone,
                    address: address,
                    nectar_points: 0
                },
            ]);

        if (dbError) throw dbError;

        // 4. TRIGGER WELCOME EMAIL
        try {
            await sendWelcomeEmail(email, firstName);
        } catch (emailErr) {
            console.error("Email failed to send, but proceeding with signup:", emailErr);
        }
        
        // 5. Trigger OTP via Supabase
        const { error: otpError } = await supabase.auth.signInWithOtp({
            phone: phone,
        });
        
        if (otpError) throw otpError;

        // 6. UI Transition (Success)
        showToast("Account created! Check your phone for the code.", "success");
        document.getElementById('signupForm').classList.add('hide');
        document.getElementById('formTitle').innerText = "Verify Mobile/Email";
        document.getElementById('verificationSection').classList.remove('hide');

    } catch (err) {
        // Handle all errors here
        console.error("Signup Process Error:", err);
        showToast(err.message, "error");
        if (submitBtn) submitBtn.disabled = false;
    } finally {
        // ALWAYS HIDE LOADER
        Loader.hide();
    }
}