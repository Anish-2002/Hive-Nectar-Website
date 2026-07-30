// Shareable progress card — stats, card generation, sharing
import { supabase } from './supabase-config.js';
import { showToast } from './app.js';

const SHARE_CARD_KEY = 'share_card_cache';

// ── Fetch user stats ──────────────────────────────
async function getShareStats() {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;

  // Get profile
  const { data: profile, error: profileErr } = await supabase
    .from('profiles')
    .select('first_name, last_name, avatar_url, nectar_points, tier, member_tier, updated_at')
    .eq('id', user.id)
    .single();
  if (profileErr) console.warn('[ShareCard] Profile error:', profileErr);
  console.log('[ShareCard] Profile data:', profile);

  // Nectar = floor(nectar_points / 100) — matches profile.js calculation
  const nectar = Math.floor((profile?.nectar_points || 0) / 100);

  // Count completed tasks
  const { count: tasksDone } = await supabase
    .from('user_tasks')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', user.id)
    .not('completed_at', 'is', null);

  // Count achievements
  const { count: achievements } = await supabase
    .from('user_milestones')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', user.id);

  return {
    name: [profile?.first_name, profile?.last_name].filter(Boolean).join(' ') || 'Meadow Member',
    avatar: profile?.avatar_url || null,
    points: nectar,
    rank: 'Meadow Level ' + (profile?.member_tier || 0),
    tier: profile?.tier || 'Free',
    tasksDone: tasksDone || 0,
    achievements: achievements || 0,
    memberSince: profile?.updated_at || user.created_at,
    userId: user.id,
  };
}

// ── Generate card HTML ─────────────────────────────
function generateCardHTML(stats) {
  const initial = stats.name[0].toUpperCase();
  const avatarHtml = stats.avatar
    ? `<img src="${stats.avatar}" alt="" style="width:60px;height:60px;border-radius:50%;object-fit:cover;border:3px solid #e0c080;">`
    : `<div style="width:60px;height:60px;border-radius:50%;background:linear-gradient(135deg,#ffd700,#b8860b);display:flex;align-items:center;justify-content:center;font-size:1.8rem;font-weight:800;color:#fff;border:3px solid #e0c080;">${initial}</div>`;

  return `<div id="shareCard" style="width:340px;background:linear-gradient(145deg,#fefcf5,#f8f0e0);border-radius:20px;padding:24px;box-shadow:0 8px 32px rgba(180,120,0,0.15);font-family:'Nunito',sans-serif;text-align:center;">
    <div style="font-size:0.7rem;letter-spacing:2px;color:#b8860b;text-transform:uppercase;margin-bottom:12px;">🌿 THE MEADOW</div>
    <div style="margin-bottom:16px;">${avatarHtml}</div>
    <div style="font-size:1.4rem;font-weight:800;color:#5a3e00;margin-bottom:4px;">${stats.name}</div>
    <div style="font-size:0.8rem;color:#b8860b;font-weight:600;margin-bottom:16px;">${stats.rank}</div>
    <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-bottom:16px;">
      <div style="background:rgba(255,215,0,0.1);border-radius:12px;padding:12px 8px;">
        <div style="font-size:1.5rem;font-weight:800;color:#5a3e00;">${stats.tasksDone}</div>
        <div style="font-size:0.65rem;color:#888;">Tasks Done</div>
      </div>
      <div style="background:rgba(255,215,0,0.1);border-radius:12px;padding:12px 8px;">
        <div style="font-size:1.5rem;font-weight:800;color:#5a3e00;">${stats.points}</div>
        <div style="font-size:0.65rem;color:#888;">Nectar</div>
      </div>
      <div style="background:rgba(255,215,0,0.1);border-radius:12px;padding:12px 8px;">
        <div style="font-size:1.5rem;font-weight:800;color:#5a3e00;">${stats.achievements}</div>
        <div style="font-size:0.65rem;color:#888;">Achievements</div>
      </div>
    </div>
    <div style="font-size:0.7rem;color:#aaa;border-top:1px solid rgba(200,160,80,0.2);padding-top:12px;">
      Member since ${new Date(stats.memberSince).toLocaleDateString()} · ${stats.tier} Tier
      <div style="margin-top:4px;">🐝 Join the hive at hivenectar.earth</div>
    </div>
  </div>`;
}

// ── Show share modal ───────────────────────────────
window.shareStats = async function () {
  const stats = await getShareStats();
  if (!stats) return showToast('Could not load stats', 'error');

  const url = `${window.location.origin}${window.location.pathname.replace(/[^/]*$/, '')}profile.html?shared=${stats.userId}`;
  const text = encodeURIComponent('Check out my progress on The Meadow! 🐝\n' + url);
  const subject = encodeURIComponent('My Meadow Progress');

  const existing = document.getElementById('shareStatsModal');
  if (existing) existing.remove();

  const modal = document.createElement('div');
  modal.id = 'shareStatsModal';
  modal.style.cssText = 'position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;overflow-y:auto;padding:20px;';

  modal.innerHTML = `
    <div style="background:#fff;border-radius:20px;padding:24px;max-width:400px;width:100%;text-align:center;box-shadow:0 20px 60px rgba(0,0,0,.3);">
      <div id="cardContainer">${generateCardHTML(stats)}</div>
      <div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:16px;justify-content:center;">
        <button onclick="downloadCard()" class="btn" style="flex:1;min-width:48px;padding:10px 0;background:#5a3e00;color:#fff;" title="Download"><i class="fas fa-download"></i></button>
        <a href="https://wa.me/?text=${text}" target="_blank" rel="noopener" class="btn" style="flex:1;min-width:48px;padding:10px 0;background:#25D366;color:#fff;text-decoration:none;" title="WhatsApp"><i class="fab fa-whatsapp"></i></a>
        <a href="https://t.me/share/url?url=${encodeURIComponent(url)}&text=${text}" target="_blank" rel="noopener" class="btn" style="flex:1;min-width:48px;padding:10px 0;background:#0088cc;color:#fff;text-decoration:none;" title="Telegram"><i class="fab fa-telegram"></i></a>
        <a href="mailto:?subject=${subject}&body=${text}" target="_blank" class="btn" style="flex:1;min-width:48px;padding:10px 0;background:#ea4335;color:#fff;text-decoration:none;" title="Email"><i class="fas fa-envelope"></i></a>
        <a href="sms:?body=${text}" target="_blank" class="btn" style="flex:1;min-width:48px;padding:10px 0;background:#34b7f1;color:#fff;text-decoration:none;" title="SMS"><i class="fas fa-sms"></i></a>
        <button onclick="if(navigator.share)navigator.share({title:'Meadow Progress',text:'Check out my Meadow progress!',url:'${url}'}).catch(()=>{});else{navigator.clipboard.writeText('${url}');showToast('Link copied!','success');}" class="btn" style="flex:1;min-width:48px;padding:10px 0;background:#7c3aed;color:#fff;" title="Share"><i class="fas fa-share-nodes"></i></button>
      </div>
      <div style="margin-top:8px;">
        <input readonly value="${url}" style="width:100%;padding:8px;border:1px solid #e0c080;border-radius:8px;font-size:.75rem;text-align:center;background:#faf6ee;" onclick="this.select();navigator.clipboard.writeText(this.value);showToast('Link copied!','success');">
      </div>
      <button onclick="this.closest('#shareStatsModal').remove()" class="btn btn-secondary" style="width:100%;margin-top:8px;">Close</button>
    </div>`;
  document.body.appendChild(modal);
};

// ── Download card as image ─────────────────────────
window.downloadCard = async function () {
  const card = document.getElementById('shareCard');
  if (!card) return;

  // Use html2canvas if available, otherwise fallback to screenshot via canvas
  if (typeof html2canvas === 'undefined') {
    // Load html2canvas dynamically
    const script = document.createElement('script');
    script.src = 'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js';
    script.onload = () => doCapture(card);
    document.head.appendChild(script);
  } else {
    doCapture(card);
  }
};

async function doCapture(card) {
  try {
    const canvas = await html2canvas(card, {
      scale: 2,
      backgroundColor: '#fefcf5',
      useCORS: true,
    });
    const link = document.createElement('a');
    link.download = 'meadow-progress.png';
    link.href = canvas.toDataURL();
    link.click();
  } catch (e) {
    showToast('Could not download — try screenshot instead', 'info');
  }
}
