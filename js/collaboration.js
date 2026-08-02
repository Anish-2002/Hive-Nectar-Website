// Collaboration — invite partners & track progress

import { supabase } from './supabase-config.js';
import { showToast } from './app.js';

// Global partner progress data
export let partnerCompletedTasks = new Map(); // taskId → completed_at
export let partnerInfo = []; // current partners with profile data
export let hasCollabAccess = false; // only collective tier+

export async function initCollab() {
  // Check tier — only collective (3+) can use collaboration
  const { data: profile } = await supabase
    .from('profiles')
    .select('member_tier')
    .eq('id', (await supabase.auth.getUser()).data?.user?.id)
    .single();

  hasCollabAccess = (profile?.member_tier || 0) >= 3;
  if (!hasCollabAccess) {
    updatePartnerUI([]);
    hideInviteButton();
    return;
  }

  showInviteButton();
  const { data: partners, error } = await supabase.rpc('get_collab_partners');
  if (error) return;

  // Fetch partner profile data (name, avatar)
  if (partners && partners.length > 0) {
    const ids = partners.map(p => p.partner_id);
    console.log('[Collab] Partners found:', ids);
    // Use SECURITY DEFINER RPC to bypass RLS
    let profiles = [];
    try {
      const { data, error } = await supabase
        .rpc('get_partner_profiles', { p_ids: ids });
      console.log('[Collab] get_partner_profiles result:', error, data);
      if (!error && data) profiles = Array.isArray(data) ? data : (data?.data || []);
    } catch (e) {
      console.warn('[Collab] RPC failed, trying direct query:', e);
      // Fallback: direct query (may fail if RLS blocks)
      try {
        const { data, error } = await supabase
          .from('profiles')
          .select('id, username, avatar_url')
          .in('id', ids);
        console.log('[Collab] Direct profiles result:', error, data);
        if (!error && data) profiles = data;
      } catch (e2) {}
    }

    console.log('[Collab] Resolved profiles:', profiles);

    partnerInfo = partners.map(p => {
      const profile = profiles.find(pr => pr.id === p.partner_id);
      // Try every possible name field, fall back to first part of UUID
      const name = profile?.username || profile?.full_name || profile?.display_name || 
                   profile?.email || p.partner_id.slice(0, 8);
      return {
        ...p,
        username: name,
        avatar_url: profile?.avatar_url || null,
      };
    });

    await loadPartnerProgress(partners);
  } else {
    partnerInfo = [];
  }

  updatePartnerUI(partnerInfo);
}

async function loadPartnerProgress(partners) {
  partnerCompletedTasks = new Map();
  for (const p of partners) {
    const { data, error } = await supabase.rpc('get_partner_progress', {
      p_partner_id: p.partner_id
    });
    if (data) {
      data.forEach(row => {
        partnerCompletedTasks.set(row.task_id, row.completed_at);
      });
    }
  }
}

// Check if partner completed a task
export function isPartnerDone(taskId) {
  return partnerCompletedTasks.has(taskId);
}

export function getPartnerDoneDate(taskId) {
  return partnerCompletedTasks.get(taskId) || null;
}

// ── Generate invite link ──────────────────────────────
window.invitePartner = async function () {
  const { data: code, error } = await supabase.rpc('create_collab_invite');
  if (error) return showToast(error.message, 'error');

  const link = `${window.location.origin}${window.location.pathname.replace(/[^/]*$/, '')}collaborate.html?code=${code}`;

  const encodedLink = encodeURIComponent(link);
  const encodedText = encodeURIComponent('Join me on The Meadow to track progress together! 🐝\n' + link);
  const encodedSubject = encodeURIComponent('Join me on The Meadow');

  // Show share dialog
  const existing = document.getElementById('inviteModal');
  if (existing) existing.remove();

  const modal = document.createElement('div');
  modal.id = 'inviteModal';
  modal.style.cssText = 'position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;overflow-y:auto;padding:20px;box-sizing:border-box;';
  modal.innerHTML = `
    <div style="background:#fff;border-radius:16px;padding:24px;max-width:400px;width:90%;text-align:center;box-shadow:0 20px 60px rgba(0,0,0,.3);">
      <h3 style="margin:0 0 8px;font-size:1.3rem;">🤝 Invite a Partner</h3>
      <p style="margin:0 0 16px;color:#666;font-size:.85rem;">Share this link — they'll be paired with you once they accept</p>
      <input id="inviteLinkInput" readonly value="${link}"
        style="width:100%;padding:10px;border:2px solid #e0c080;border-radius:8px;font-size:.85rem;text-align:center;background:#faf6ee;"
        onclick="this.select();navigator.clipboard?.writeText(this.value)">
      <div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:12px;">
        <button onclick="navigator.clipboard.writeText('${link}');showToast('Link copied!','success');this.closest('#inviteModal').remove()" class="btn" style="flex:1;min-width:48px;padding:10px 0;background:#f0e6d3;color:#333;" title="Copy link"><i class="fas fa-link"></i></button>
        <a href="https://wa.me/?text=${encodedText}" target="_blank" rel="noopener" class="btn" style="flex:1;min-width:48px;padding:10px 0;background:#25D366;color:#fff;text-decoration:none;" title="WhatsApp"><i class="fab fa-whatsapp"></i></a>
        <a href="https://t.me/share/url?url=${encodedLink}&text=${encodedText}" target="_blank" rel="noopener" class="btn" style="flex:1;min-width:48px;padding:10px 0;background:#0088cc;color:#fff;text-decoration:none;" title="Telegram"><i class="fab fa-telegram"></i></a>
        <a href="mailto:?subject=${encodedSubject}&body=${encodedText}" target="_blank" class="btn" style="flex:1;min-width:48px;padding:10px 0;background:#ea4335;color:#fff;text-decoration:none;" title="Email"><i class="fas fa-envelope"></i></a>
        <a href="sms:?body=${encodedText}" target="_blank" class="btn" style="flex:1;min-width:48px;padding:10px 0;background:#34b7f1;color:#fff;text-decoration:none;" title="SMS"><i class="fas fa-sms"></i></a>
        <button onclick="shareNative('${link}')" class="btn" style="flex:1;min-width:48px;padding:10px 0;background:#7c3aed;color:#fff;" title="Share"><i class="fas fa-share-nodes"></i></button>
      </div>
      <button onclick="this.closest('#inviteModal').remove()" class="btn btn-secondary" style="width:100%;margin-top:8px;">Close</button>
    </div>`;
  document.body.appendChild(modal);
};

function shareVia(platform, link) {
  const text = encodeURIComponent('Join me on The Meadow to track progress together! 🐝\n' + link);
  const subject = encodeURIComponent('Join me on The Meadow');
  const urls = {
    whatsapp: `https://wa.me/?text=${text}`,
    telegram: `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${text}`,
    email: `mailto:?subject=${subject}&body=${text}`,
    sms: `sms:?body=${text}`,
  };
  const url = urls[platform];
  if (url) window.open(url, '_blank');
}

function shareNative(link) {
  if (navigator.share) {
    navigator.share({ title: 'The Meadow Invite', text: 'Join me on The Meadow!', url: link })
      .catch(() => {});
  } else {
    navigator.clipboard.writeText(link).then(() => {
      showToast('Link copied — share it anywhere!', 'success');
    });
  }
}

// ── Accept invite (called from collaborate.html) ──────
window.acceptInvite = async function (code) {
  const { data, error } = await supabase.rpc('accept_collab_invite', { p_code: code });
  if (error) return { success: false, error: error.message };
  return data;
};

// ── Update UI with partner info ───────────────────────
function updatePartnerUI(partners) {
  const container = document.getElementById('partnerSection');
  if (!container) return;

  if (!partners || partners.length === 0) {
    container.style.display = 'none';
    return;
  }

  container.style.display = 'block';
  container.innerHTML = `<h4 style="margin:0 0 8px;font-size:.85rem;color:var(--primary);">🤝 Collaborators</h4>
    <div style="display:flex;flex-direction:column;gap:6px;">
      ${partners.map(p => {
        const initial = (p.username || '?')[0].toUpperCase();
        const avatarHtml = p.avatar_url
          ? `<img src="${p.avatar_url}" alt="" style="width:28px;height:28px;border-radius:50%;object-fit:cover;">`
          : `<span style="width:28px;height:28px;border-radius:50%;background:var(--honey-gradient);display:flex;align-items:center;justify-content:center;color:#fff;font-weight:700;font-size:.8rem;">${initial}</span>`;
        return `<div style="display:flex;align-items:center;gap:8px;padding:8px;background:var(--bg-card);border-radius:8px;font-size:.8rem;">
          ${avatarHtml}
          <span style="flex:1;font-weight:600;">${p.username}</span>
          <span style="color:var(--fg-muted);font-size:.7rem;">since ${new Date(p.since).toLocaleDateString()}</span>
        </div>`;
      }).join('')}
    </div>`;
}

// ── Show/hide invite button based on tier ────────────
function hideInviteButton() {
  const btn = document.querySelector('[onclick="invitePartner()"]');
  if (btn) btn.style.display = 'none';
}
function showInviteButton() {
  const btn = document.querySelector('[onclick="invitePartner()"]');
  if (btn) btn.style.display = '';
}

// ── Check URL for invite code on page load ────────────
export function checkInviteOnLoad() {
  const params = new URLSearchParams(window.location.search);
  const code = params.get('code');
  if (!code) return;

  // Clean the URL
  window.history.replaceState({}, '', window.location.pathname);

  // Check if user is logged in
  supabase.auth.getSession().then(({ data: { session } }) => {
    if (!session) {
      // Redirect to login with return URL
      window.location.href = `login.html?redirect=${encodeURIComponent(`collaborate.html?code=${code}`)}`;
      return;
    }
    // Show accept dialog
    showAcceptDialog(code);
  });
}

function showAcceptDialog(code) {
  const existing = document.getElementById('acceptModal');
  if (existing) existing.remove();

  const modal = document.createElement('div');
  modal.id = 'acceptModal';
  modal.style.cssText = 'position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;overflow-y:auto;padding:20px;box-sizing:border-box;';
  modal.innerHTML = `
    <div style="background:#fff;border-radius:16px;padding:24px;max-width:380px;width:90%;text-align:center;box-shadow:0 20px 60px rgba(0,0,0,.3);">
      <div style="font-size:3rem;margin-bottom:8px;">🤝</div>
      <h3 style="margin:0 0 4px;">Collaboration Invite</h3>
      <p style="margin:0 0 20px;color:#666;font-size:.85rem;">Someone has invited you to track progress together!</p>
      <div style="display:flex;gap:8px;">
        <button id="acceptBtn" class="btn btn-success" style="flex:2;">Accept</button>
        <button id="declineBtn" class="btn btn-secondary" style="flex:1;">Decline</button>
      </div>
    </div>`;
  document.body.appendChild(modal);

  document.getElementById('acceptBtn').onclick = async () => {
    document.getElementById('acceptBtn').textContent = 'Processing...';
    const result = await acceptInvite(code);
    modal.remove();
    if (result.success) {
      showToast('Connected! You can now see each other\'s progress 🎉', 'success');
      window.location.reload();
    } else {
      showToast(result.error || 'Failed to accept invite', 'error');
    }
  };

  document.getElementById('declineBtn').onclick = () => modal.remove();
}
