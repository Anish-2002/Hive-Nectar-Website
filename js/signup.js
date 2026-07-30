import { supabase } from './supabase-config.js';
import { showToast, Loader } from './app.js';
import { getConfig, sendEmail } from './config.js';

const DEBUG = false;

async function triggerWelcomeEmail(userId, email, firstName) {
  // Fetch sender name from config (changeable via Supabase without code edit)
  const senderName = await getConfig('sender_name') || 'The Meadow';
  const subject = await getConfig('welcome_email_subject') || 'Welcome to The Meadow! 🌿';
  const siteUrl = await getConfig('site_url') || 'https://hivernectar.earth';

  await sendEmail(
    email,
    subject,
    `<div style="font-family:sans-serif;max-width:480px;margin:0 auto;">
      <h2 style="color:#C8A96E;">Welcome to The Meadow, ${firstName}!</h2>
      <p>Your hive is ready. You've taken the first step toward building meaningful habits, reconnecting with what matters, and tracking your growth.</p>
      <p>Here's what you can do now:</p>
      <ul>
        <li><strong>Explore tasks</strong> across 5 core themes</li>
        <li><strong>Earn Nectar points</strong> by completing daily actions</li>
        <li><strong>Unlock achievements</strong> as you progress</li>
        <li><strong>Decorate your Golden Jar</strong> with earned badges</li>
      </ul>
      <p style="margin-top:20px;"><a href="${siteUrl}/profile.html" style="background:#C8A96E;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600;">Start Your Journey</a></p>
      <hr style="border:none;border-top:1px solid #e0d5c0;margin:24px 0;">
      <p style="font-size:0.85rem;color:#7A6B5D;">${senderName} — ${siteUrl}</p>
    </div>`,
  );
}

export async function handleSignup(e) {
  e.preventDefault();

  const rawEmail = document.getElementById('signupEmail')?.value;
  const email = (rawEmail || '').toLowerCase();
  const password = document.getElementById('signupPass')?.value;
  const firstName = document.getElementById('signupFirst')?.value;
  const lastName = document.getElementById('signupLast')?.value;
  const username = document.getElementById('signupUsername')?.value;

  if (!rawEmail || !password || !firstName || !username) {
    showToast("Please fill in all required fields.", "error");
    return;
  }

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
    const { data: authData, error: authError } = await supabase.auth.signUp({
      email: rawEmail,
      password,
      options: {
        data: { first_name: firstName, last_name: lastName, username }
      }
    });
    if (authError) throw authError;

    const userId = authData.user.id;

    const { error: dbError } = await supabase
      .from('profiles')
      .upsert([{
        id: userId,
        first_name: firstName,
        last_name: lastName,
        username,
        email,
        tier: 'free',
        member_tier: 0,
        user_level: 'Novice',
        engagement_level: 'Seed',
        experience: 0,
        nectar_points: 0,
        total_tasks_completed: 0,
        join_date: new Date().toISOString(),
        updated_at: new Date().toISOString()
      }], { onConflict: 'id' });

    if (dbError && DEBUG) console.warn('Profile upsert:', dbError.message);

    await triggerWelcomeEmail(userId, email, firstName);

    showToast("Account created! Welcome to The Meadow.", "success");
    
    setTimeout(() => {
      window.location.replace('profile.html');
    }, 1500);

  } catch (err) {
    showToast(err.message, "error");
    if (submitBtn) submitBtn.disabled = false;
  } finally {
    Loader.hide();
  }
}
