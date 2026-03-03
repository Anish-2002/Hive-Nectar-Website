import { supabase } from './supabase-config.js';
// 1. ADD THIS IMPORT AT THE TOP
import { sendWelcomeEmail } from './email.js';

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

    // 1. Basic Email Validation
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
        alert("Please enter a valid email address.");
        return;
    }

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

    if (authError) {
        alert("Signup Error: " + authError.message);
        return;
    }

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

    if (dbError) {
        alert("Database Error: " + dbError.message);
        return;
    }

    // 4. TRIGGER WELCOME EMAIL
    // We use a try/catch so that if Brevo fails, the user can still proceed to verify their phone
    try {
        await sendWelcomeEmail(email, firstName);
    } catch (emailErr) {
        console.error("Email failed to send, but proceeding with signup:", emailErr);
    }
    
    // 5. Switch to Verification Section
    document.getElementById('signupForm').classList.add('hide');
    document.getElementById('formTitle').innerText = "Verify Mobile/Email";
    document.getElementById('verificationSection').classList.remove('hide');

    // 6. Trigger OTP via Supabase
    await supabase.auth.signInWithOtp({
        phone: phone,
    });
}