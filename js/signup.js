import { supabase } from './supabase-config.js';
import { showToast, Loader } from './app.js';

async function triggerWelcomeEmail(userId, email, firstName) {
  const functionUrl = 'https://gxboojbfmpejbjolfmjq.supabase.co/functions/v1/send-welcome-email';
  
  const { data: { session } } = await supabase.auth.getSession();
  const accessToken = session?.access_token;
  
  if (!accessToken) {
    console.error('No access token available – email function may fail');
  }
  
  try {
    const response = await fetch(functionUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(accessToken && { 'Authorization': `Bearer ${accessToken}` })
      },
      body: JSON.stringify({
        record: {
          id: userId,
          email: email,
          raw_user_meta_data: { first_name: firstName }
        }
      })
    });
    
    const text = await response.text();
    console.log('📧 Response status:', response.status);
    console.log('📧 Response body:', text);
    
    if (!response.ok) {
      console.error('❌ Email function error:', text);
    } else {
      console.log('✅ Welcome email processed');
    }
  } catch (err) {
    console.error('❌ Failed to call email function:', err);
  }
}

export async function handleSignup(e) {
  e.preventDefault();

  const rawEmail = document.getElementById('signupEmail').value;
  const email = rawEmail.toLowerCase();               // 👈 convert to lowercase
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

  Loader.show("Creating your Meadow profile...");
  const submitBtn = e.target.querySelector('button[type="submit"]');
  if (submitBtn) submitBtn.disabled = true;

  try {
    // 1. Sign up with Supabase Auth (note: Auth will store original case; we only change profiles)
    console.log('🔐 Signing up with Supabase...');
    const { data: authData, error: authError } = await supabase.auth.signUp({
      email: rawEmail,   // keep original for authentication
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

    const userId = authData.user.id;
    console.log('✅ Auth success, userId:', userId);

    // 2. Upsert profile with lowercase email (to avoid case‑sensitive lookup issues)
    console.log('📝 Upserting profile...');
    const { error: dbError } = await supabase
      .from('profiles')
      .upsert(
        [{
          id: userId,
          first_name: firstName,
          last_name: lastName,
          username: username,
          email: email,                      // 👈 stored in lowercase
          tier: 'free',
          member_tier: 0,
          user_level: 'Novice',
          engagement_level: 'Seed',
          experience: 0,
          nectar_points: 0,
          total_tasks_completed: 0,
          join_date: new Date().toISOString(),
          updated_at: new Date().toISOString()
        }],
        { onConflict: 'id' }
      );

    if (dbError) {
      console.error('⚠️ Profile upsert error (non-critical):', dbError.message);
    } else {
      console.log('✅ Profile upserted successfully');
    }

    // 3. Send welcome email (use the lowercase email – it will be used in the Edge Function)
    console.log('📧 Triggering welcome email...');
    await triggerWelcomeEmail(userId, email, firstName);

    showToast("Account created! Please log in.", "success");
    
    setTimeout(() => {
      window.location.replace('profile.html');
    }, 1500);

  } catch (err) {
    console.error("❌ Signup error:", err);
    console.error("Error stack:", err.stack);
    showToast(err.message, "error");
    if (submitBtn) submitBtn.disabled = false;
  } finally {
    Loader.hide();
  }
}