import { supabase } from './supabase-config.js';
import { showToast, Loader } from './app.js';
import { getAchievementSubtext, getMilestoneDisplayDescription } from './theme-tokens.js';
import { isPartnerDone, partnerInfo, partnerCompletedTasks, hasCollabAccess } from './collaboration.js';

// ======================== HELPER FUNCTIONS ========================
// Module-scope XSS guard. profile.html does NOT load js/trial.js, and trial.js is an
// ES module (it uses `import`), so its `function escapeHtml` never becomes a global.
// Without this definition the call sites below throw "escapeHtml is not defined"
// while rendering a task card.
function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str).replace(/[&<>"']/g, m => {
        if (m === '&') return '&amp;';
        if (m === '<') return '&lt;';
        if (m === '>') return '&gt;';
        if (m === '"') return '&quot;';
        return '&#39;';
    });
}

function hexToRgba(hex, alpha) {
    if (!hex || typeof hex !== 'string') hex = '#F59E0B';
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function adjustBrightness(hex, magnitude) {
    hex = hex.replace('#', '');
    if (hex.length === 3) hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
    let r = parseInt(hex.substring(0, 2), 16);
    let g = parseInt(hex.substring(2, 4), 16);
    let b = parseInt(hex.substring(4, 6), 16);
    r = Math.max(0, Math.min(255, r + magnitude));
    g = Math.max(0, Math.min(255, g + magnitude));
    b = Math.max(0, Math.min(255, b + magnitude));
    return `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`;
}

// ======================== GLOBAL VARIABLES ========================
let allTasks = [];
let allTasksWithCompleted = [];
let baseTasks = [];
let completedNovice = new Set();
let completedExperienced = new Set();
let completedAtMap = {};
let loggedSigmaTasks = new Set();
let userProfile = null;
let userReactions = {};
let userComments = [];
let themeStageProgress = {};
let adminThemes = [];
let stageGuardrails = {};

let activeFilters = {
    core_theme: [],
    stage: [],
    subcategory: []
};

let showingExperienced = false;
let noviceModalShown = false;
let deadEndModalShown = false;
let upgradeModalShown = false;
let totalVisibleTasks = 0;
let completedVisibleTasks = 0;
let selectedThemes = [];

const getBaseURL = () => {
    const { origin, pathname } = window.location;
    if (origin.includes('github.io')) {
        return `${origin}/Hive-Nectar-Website/`;
    }
    return `${origin}/`;
};

const tierToNumber = { free: 0, plus: 1, steward: 2, collective: 3 };
const numberToTier = { 0: 'free', 1: 'plus', 2: 'steward', 3: 'collective' };

// Stage gating compares on letters only, so a legacy stage label that still carries a
// pictograph prefix and a current clean label both resolve to the same key.
const stageKey = (s) => String(s == null ? '' : s).replace(/[^A-Za-z]+/g, '').toLowerCase();

// Keys must be lowercase: every comparison is allowedStages.includes(stageKey(task.stage)),
// and stageKey lowercases. A capitalized 'Seeds' here would never match and would drop every task.
const stagesForTier = {
    0: ['seeds'],
    1: ['seeds', 'sprout'],
    2: ['seeds', 'sprout', 'bloom'],
    3: ['seeds', 'sprout', 'bloom', 'harvest']
};

// ======================== MILESTONE HANDLING ========================
async function checkAndAwardMilestones() {
    if (!userProfile || !userProfile.id) return;

    try {
        const { data: milestones, error } = await supabase.rpc('check_and_award_milestones', {
            p_user_id: userProfile.id
        });

        if (error) {
            console.error('Error awarding milestones:', error);
            return;
        }

        if (milestones && milestones.length) {
            milestones.forEach(m => {
                showToast(`${m.name} milestone unlocked!`, 'success');
            });
            await updateAchievementsBadge();
        }
    } catch (err) {
        console.error('Failed to check milestones:', err);
    }
}

// ======================== ACHIEVEMENTS HELPERS ========================
async function updateAchievementsBadge() {
    if (!userProfile) return;
    let count = 0;
    const { count: mCount, error: mError } = await supabase
        .from('user_milestones')
        .select('*', { count: 'exact', head: true })
        .eq('user_id', userProfile.id)
        .eq('viewed', false);
    if (!mError) count += (mCount || 0);

    // Only count tokens that are VISIBLE for this user's tier AND not yet
    // revealed. Reveal-only design: user_tokens rows are created with
    // viewed=true at reveal time, so "viewed=false" rows never exist —
    // the notification is driven by tokens the user CAN reveal but hasn't.
    const tierNum = tierToNumber[userProfile.tier] || 0;
    const allowedStages = stagesForTier[tierNum] || [];
    const { data: tierThemes } = await supabase
        .from('themes')
        .select('theme_id')
        .lte('min_tier', tierNum);
    const visibleThemeIds = new Set((tierThemes || []).map(t => t.theme_id));

    // Token ids the user has already revealed (any state — they're in user_tokens)
    const { data: revealedRows, error: rError } = await supabase
        .from('user_tokens')
        .select('token_id')
        .eq('user_id', userProfile.id);
    if (!rError) {
        const revealedIds = new Set((revealedRows || []).map(r => r.token_id));
        const { data: tokenDefs } = await supabase
            .from('tokens')
            .select('id, theme_id, stage')
            .eq('active', true);
        const revealable = (tokenDefs || []).filter(t => {
            if (revealedIds.has(t.id)) return false;
            if (visibleThemeIds.size && !visibleThemeIds.has(t.theme_id)) return false;
            if (allowedStages.length && !allowedStages.includes(stageKey(t.stage))) return false;
            return true;
        });
        count += revealable.length;
    }

    const badgeElements = document.querySelectorAll('.achievements-badge');
    badgeElements.forEach(el => {
        if (count > 0) {
            el.textContent = count;
            el.style.display = 'inline-flex';
        } else {
            el.style.display = 'none';
        }
    });
    window.unviewedMilestoneCount = count;
}

const TOKEN_THEME_NAMES = {
    T01: 'Connecting / Belonging',
    T02: 'Creating / Circularity',
    T03: 'Innovation / Shift',
    T04: 'Acting / Motivating',
    T05: 'Reflecting / Learning',
};

let revealedTokens = new Set();

function getUnlockCondition(milestone) {
    const val = milestone.requirement_value;
    switch (milestone.category) {
        case 'nectar': return `Earn ${val} Nectar points`;
        case 'tasks': return `Complete ${val} tasks`;
        case 'membership': return `Be a member for ${val} days`;
        case 'sigma': return `Complete ${val} improvement logs`;
        case 'referrals': return `Refer ${val} friends`;
        case 'theme_token': {
            try {
                const meta = JSON.parse(milestone.description);
                const theme = meta.core_theme || '';
                return `Complete ${val} tasks in ${theme || 'this theme'}`;
            } catch { return `Complete ${val} tasks in this theme`; }
        }
        default: return `Reach milestone`;
    }
}

async function generateAchievementsHtml() {
    // 1. Fetch ALL milestones
    const { data: allMilestones, error: mError } = await supabase
        .from('milestones')
        .select('*')
        .eq('active', true)
        .order('category', { ascending: true })
        .order('requirement_value', { ascending: true });

    if (mError) {
        return '<p class="tiny muted">No achievements available yet.</p>';
    }

    // 2. Fetch user's earned milestones
    const { data: userM, error: uError } = await supabase
        .from('user_milestones')
        .select('milestone_id, achieved_at, viewed')
        .eq('user_id', userProfile.id);

    // 3. Build earned milestone map
    const earnedMap = new Map();
    (userM || []).forEach(um => {
        earnedMap.set(um.milestone_id, { viewed: um.viewed });
    });

    // 3b. Tier → theme + stage access: themes where min_tier <= user tier,
    //     stages allowed per tier (stagesForTier)
    const tierNum = tierToNumber[userProfile.tier] || 0;
    const allowedStages = stagesForTier[tierNum] || [];
    let accessibleThemeIds = null; // null = no filter (all themes)
    const { data: tierThemes } = await supabase
        .from('themes')
        .select('theme_id')
        .lte('min_tier', tierNum);
    if (tierThemes && tierThemes.length) {
        accessibleThemeIds = new Set(tierThemes.map(t => t.theme_id));
    }

    // 4. Fetch ALL active token definitions
    const { data: allTokens } = await supabase
        .from('tokens')
        .select('*')
        .eq('active', true)
        .order('theme_id')
        .order('stage');

    // 4b. Filter tokens by tier-accessible themes AND tier-accessible stages
    const visibleTokens = (allTokens || []).filter(t =>
        (!accessibleThemeIds || accessibleThemeIds.has(t.theme_id)) &&
        allowedStages.includes(stageKey(t.stage))
    );

    // 5. Fetch user's revealed tokens
    const { data: userTokens } = await supabase
        .from('user_tokens')
        .select('token_id, awarded_at, viewed')
        .eq('user_id', userProfile.id);

    // 6. Build revealed token map
    const revealedTokenMap = new Map();
    (userTokens || []).forEach(ut => {
        revealedTokenMap.set(ut.token_id, { viewed: ut.viewed, awarded_at: ut.awarded_at });
    });

    // 7. Build milestone items (earn-to-unlock, unchanged)
    const milestoneItems = [];
    allMilestones.forEach(m => {
        const earned = earnedMap.has(m.id);
        milestoneItems.push({
            displayId: m.id,
            name: m.name,
            category: m.category,
            requirement_value: m.requirement_value,
            icon_url: m.icon_url || '',
            description: m.description,
            earned,
            viewed: earned ? (earnedMap.get(m.id).viewed ?? false) : false,
        });
    });

    // Sort: earned first, then by requirement_value ascending within each group
    milestoneItems.sort((a, b) => {
        if (a.earned !== b.earned) return a.earned ? -1 : 1;
        return (a.requirement_value || 0) - (b.requirement_value || 0);
    });

    // 7b. Build token items (reveal-only, tier-filtered)
    const tokenItems = (visibleTokens || []).map(t => {
        const revealed = revealedTokenMap.has(t.id);
        return {
            displayId: t.id,
            name: t.name,
            category: 'theme_token',
            requirement_value: t.tasks_required,
            icon_url: t.icon_url || '',
            description: t.description,
            stage: t.stage,
            theme_id: t.theme_id,
            revealed,
            viewed: revealed ? (revealedTokenMap.get(t.id)?.viewed ?? false) || revealedTokens.has(t.id) : false,
        };
    });

    // Sort: revealed first, then by theme then stage (keeps grid grouped)
    tokenItems.sort((a, b) => {
        if (a.revealed !== b.revealed) return a.revealed ? -1 : 1;
        if ((a.theme_id || '') !== (b.theme_id || '')) return (a.theme_id || '').localeCompare(b.theme_id || '');
        return (a.stage || '').localeCompare(b.stage || '');
    });

    // 8. Render milestone cards
    let milestoneCards = '';
    for (const item of milestoneItems) {
        const icon = item.icon_url || '';
        const safeIcon = icon.replace(/"/g, '%22');
        const safeName = item.name.replace(/"/g, '&quot;');

        if (item.earned) {
            const safeDesc = getMilestoneDisplayDescription(item).replace(/"/g, '&quot;');
            const safeSub = getAchievementSubtext(item).replace(/"/g, '&quot;');
            const imgTag = icon
                ? `<img src="${icon}" class="achievement-badge-img" alt="${safeName}">`
                : `<div class="no-icon-placeholder earned-placeholder"><i class="fas fa-trophy"></i></div>`;
            milestoneCards += `
                <div class="achievement-container earned"
                     data-milestone-id="${item.displayId}"
                     data-type="milestone"
                     data-icon="${safeIcon}"
                     data-name="${safeName}"
                     data-sub="${safeSub}"
                     data-desc="${safeDesc}"
                     onclick="viewMilestone(this)">
                    <div class="achievement-card">
                        ${!item.viewed ? `
                            <div class="mystery-overlay">
                                <div class="reveal-msg">Click To Reveal</div>
                            </div>
                        ` : ''}
                        <div class="badge-icon-wrap">
                            ${imgTag}
                        </div>
                        <div class="achievement-card-text">
                            <h3 class="font-bold text-gray-800 text-xl italic">${item.name}</h3>
                            <p class="text-[10px] text-amber-600 font-black uppercase tracking-[0.2em] mt-2 bg-amber-50 inline-block px-3 py-1 rounded-full border border-amber-100">${safeSub}</p>
                        </div>
                    </div>
                </div>`;
        } else {
            const safeUnlock = getUnlockCondition(item).replace(/"/g, '&quot;');
            const imgTag = icon
                ? `<img src="${icon}" class="achievement-badge-img locked-img" alt="${safeName}">`
                : `<div class="no-icon-placeholder locked-placeholder"><i class="fas fa-trophy"></i></div>`;
            milestoneCards += `
                <div class="achievement-container locked">
                    <div class="achievement-card locked-card">
                        <div class="badge-icon-wrap">
                            ${imgTag}
                        </div>
                        <div class="achievement-card-text">
                            <h3 class="font-bold achievement-name-locked">${item.name}</h3>
                        </div>
                        <div class="lock-blur-overlay">
                            <div class="lock-icon-circle"><i class="fas fa-lock"></i></div>
                            <div class="unlock-message">${safeUnlock}</div>
                        </div>
                    </div>
                </div>`;
        }
    }

    // 8b. Render token cards (reveal-only, always visible if tier allows)
    let tokenCards = '';
    for (const item of tokenItems) {
        const icon = item.icon_url || '';
        const safeIcon = icon.replace(/"/g, '%22');
        const safeName = item.name.replace(/"/g, '&quot;');
        const themeName = TOKEN_THEME_NAMES[item.theme_id] || item.theme_id || 'Theme Token';
        const safeTheme = themeName.replace(/"/g, '&quot;');
        let meta = {};
        try { meta = JSON.parse(item.description); } catch {}
        const safeDesc = (meta.copy || 'A free token from The Meadow.').replace(/"/g, '&quot;');

        const imgTag = icon
            ? `<img src="${icon}" class="achievement-badge-img token-badge-img" alt="${safeName}">`
            : `<div class="no-icon-placeholder earned-placeholder"><i class="fas fa-award"></i></div>`;

        tokenCards += `
            <div class="achievement-container ${item.revealed ? 'earned' : 'token-unrevealed'}"
                 data-token-id="${item.displayId}"
                 data-icon="${safeIcon}"
                 data-name="${safeName}"
                 data-theme="${safeTheme}"
                 data-desc="${safeDesc}"
                 onclick="revealToken(this)">
                <div class="achievement-card ${item.revealed ? '' : 'token-card'}">
                    ${!item.revealed ? `
                        <div class="mystery-overlay">
                            <div class="reveal-msg">Click To Reveal</div>
                        </div>
                    ` : ''}
                    <div class="badge-icon-wrap">
                        ${imgTag}
                    </div>
                    <div class="achievement-card-text">
                        <h3 class="font-bold text-gray-800 text-xl italic">${item.name}</h3>
                        <p class="text-[10px] text-amber-600 font-black uppercase tracking-[0.2em] mt-2 bg-amber-50 inline-block px-3 py-1 rounded-full border border-amber-100">${item.stage} · ${safeTheme}</p>
                    </div>
                </div>
            </div>`;
    }

    if (milestoneCards === '' && tokenCards === '') {
        return '<p class="tiny muted">No achievements available yet.</p>';
    }

    return `
        <style>
            :root {
                --honey-gradient: linear-gradient(135deg, #FCD34D 0%, #F59E0B 100%);
                --honey-soft: rgba(251, 191, 36, 0.1);
                --honey-border: rgba(245, 158, 11, 0.2);
                --honey-amber: #d97706;
            }
            .profile-hero-mini {
                background: var(--honey-gradient);
                padding: 50px 20px;
                border-radius: 0 0 50px 50px;
                text-align: center;
                color: white;
                box-shadow: 0 15px 40px rgba(245, 158, 11, 0.2);
                margin-bottom: 48px;
            }
            .achievement-container { perspective: 1200px; margin-bottom: 24px; min-height: clamp(280px, 60vw, 380px); }
            .achievement-container.earned { cursor: pointer; }
            .achievement-card {
                position: relative;
                background: white;
                border: 1px solid var(--honey-border);
                border-radius: 32px;
                padding: 30px 20px;
                transition: all 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275);
                overflow: hidden;
                transform-style: preserve-3d;
                height: 100%;
                display: flex;
                flex-direction: column;
                align-items: center;
                justify-content: flex-start;
                gap: 20px;
            }
            .badge-icon-wrap { width: 100%; display: flex; justify-content: center; align-items: center; flex-shrink: 0; margin-top: 10px; }
            .achievement-card-text { width: 100%; text-align: center; margin-top: auto; padding-bottom: 4px; }
            .achievement-container.earned .achievement-card:hover {
                transform: translateY(-12px) rotateX(4deg) rotateY(4deg);
                box-shadow: 0 25px 50px -12px rgba(245, 158, 11, 0.2);
            }
            .mystery-overlay {
                position: absolute; inset: 0; z-index: 20;
                background: rgba(255, 255, 255, 0.1);
                backdrop-filter: blur(12px) saturate(180%);
                display: flex; align-items: center; justify-content: center;
                transition: all 0.5s ease; border-radius: 32px;
            }
            .reveal-msg {
                background: white; color: var(--honey-amber);
                padding: 8px 16px; border-radius: 100px;
                font-size: 0.7rem; font-weight: 800; text-transform: uppercase;
                letter-spacing: 1.5px; box-shadow: 0 4px 12px rgba(0,0,0,0.1);
            }
            .achievement-badge-img { width: min(140px, 42vw); height: min(140px, 42vw); aspect-ratio: 1; margin: 0 auto; transform: translateZ(30px); border-radius: 50%; border: 4px solid white; box-shadow: 0 10px 25px rgba(245, 158, 11, 0.3), 0 0 15px rgba(251, 191, 36, 0.2); object-fit: cover; }
            .achievement-badge-img.token-badge-img { width: min(140px, 42vw); height: min(140px, 42vw); border-radius: 50%; object-fit: contain; background: #fff; padding: 8px; border: 4px solid white; box-shadow: 0 10px 25px rgba(245, 158, 11, 0.3), 0 0 15px rgba(251, 191, 36, 0.2); flex-shrink: 0; display: block; }
            .grid-achievements { display: grid; grid-template-columns: repeat(1, 1fr); gap: 32px; max-width: 1280px; margin: 0 auto; padding: 0 clamp(8px, 3vw, 32px); }
            @media (min-width: 640px) { .grid-achievements { grid-template-columns: repeat(2, 1fr); } }
            @media (min-width: 1024px) { .grid-achievements { grid-template-columns: repeat(3, 1fr); } }
            .achievement-container.locked { cursor: default; opacity: 0.85; }
            .achievement-card.locked-card { background: #f5f5f4; border-color: #e5e5e4; position: relative; overflow: hidden; }
            .achievement-card.locked-card .badge-icon-wrap { filter: blur(5px) brightness(0.75); }
            .achievement-badge-img.locked-img { box-shadow: none; border-color: #d4d4d4; }
            .achievement-card.locked-card .achievement-card-text { filter: blur(3px); pointer-events: none; }
            .lock-blur-overlay { position: absolute; inset: 0; z-index: 10; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; pointer-events: none; }
            .lock-blur-overlay .lock-icon-circle { background: rgba(255,255,255,0.85); backdrop-filter: blur(6px); width: 48px; height: 48px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 1.2rem; color: #a3a3a3; box-shadow: 0 4px 12px rgba(0,0,0,0.08); }
            .lock-blur-overlay .unlock-message { background: rgba(255,255,255,0.9); backdrop-filter: blur(6px); padding: 8px 16px; border-radius: 100px; font-size: 0.65rem; font-weight: 800; text-transform: uppercase; letter-spacing: 1.5px; color: #78716c; text-align: center; }
            .achievement-name-locked { color: #a3a3a3 !important; font-size: 1.25rem; font-style: italic; }
            .no-icon-placeholder { width: 140px; height: 140px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 3rem; background: #fef3c7; border: 4px solid white; }
            .no-icon-placeholder.locked-placeholder { background: #e5e5e4; filter: grayscale(1); opacity: 0.5; }
            .achievement-tabs { display: flex; justify-content: center; gap: 12px; margin: -20px 0 32px; flex-wrap: wrap; }
            .achievement-tab {
                background: white; border: 2px solid var(--honey-border); border-radius: 100px; padding: 10px 22px;
                font-size: 0.85rem; font-weight: 800; color: #78716c; cursor: pointer; transition: all 0.3s;
                display: inline-flex; align-items: center; gap: 8px;
            }
            .achievement-tab:hover { border-color: #f59e0b; color: var(--honey-amber); }
            .achievement-tab.active { background: var(--honey-gradient); color: white; border-color: transparent; box-shadow: 0 6px 16px rgba(245,158,11,0.3); }
            .tab-count { background: rgba(0,0,0,0.08); border-radius: 100px; padding: 2px 10px; font-size: 0.7rem; font-weight: 800; }
            .achievement-tab.active .tab-count { background: rgba(255,255,255,0.25); }
            .achievement-container.token-unrevealed { cursor: pointer; }
            .achievement-container.token-unrevealed .achievement-card { background: linear-gradient(160deg, #fffdf6, #f8f0dd); border-style: dashed; }
        </style>
        <div class="profile-hero-mini">
            <h1 class="text-4xl font-black uppercase tracking-tighter italic">Nectar Artefacts</h1>
            <p class="opacity-90 font-medium text-sm tracking-widest mt-2 uppercase">Earn milestones, reveal tokens</p>
        </div>
        <div class="achievement-tabs">
            <button class="achievement-tab active" id="tabMilestones" onclick="switchAchievementTab('milestones')">
                <i class="fas fa-trophy"></i> Milestones ${milestoneItems.length ? `<span class="tab-count">${milestoneItems.filter(i => i.earned).length}/${milestoneItems.length}</span>` : ''}
            </button>
            <button class="achievement-tab" id="tabTokens" onclick="switchAchievementTab('tokens')">
                <i class="fas fa-award"></i> Tokens ${tokenItems.length ? `<span class="tab-count">${tokenItems.filter(i => i.revealed).length}/${tokenItems.length}</span>` : ''}
            </button>
        </div>
        <div id="achievementsGrid">
            <div id="milestoneSection">
                ${milestoneCards ? `<div class="grid-achievements">${milestoneCards}</div>` : '<p class="tiny muted" style="text-align:center;padding:30px;">No milestones yet.</p>'}
            </div>
            <div id="tokenSection" style="display:none;">
                ${tokenCards ? `<div class="grid-achievements">${tokenCards}</div>` : '<p class="tiny muted" style="text-align:center;padding:30px;">No tokens available for your tier yet.</p>'}
            </div>
        </div>
    `;
}

window.switchAchievementTab = (tab) => {
    const tabM = document.getElementById('tabMilestones');
    const tabT = document.getElementById('tabTokens');
    const secM = document.getElementById('milestoneSection');
    const secT = document.getElementById('tokenSection');
    if (!tabM || !tabT || !secM || !secT) return;
    if (tab === 'tokens') {
        tabT.classList.add('active');
        tabM.classList.remove('active');
        secT.style.display = 'block';
        secM.style.display = 'none';
    } else {
        tabM.classList.add('active');
        tabT.classList.remove('active');
        secM.style.display = 'block';
        secT.style.display = 'none';
    }
};

window.revealToken = async (containerEl) => {
    const tokenId = containerEl.dataset.tokenId;
    const name = containerEl.dataset.name || '';
    const theme = containerEl.dataset.theme || '';
    const desc = containerEl.dataset.desc || '';
    const icon = containerEl.dataset.icon || '';

    // Already-revealed token: just show the detail popup, no reveal flow
    if (containerEl.classList.contains('earned')) {
        openAchievementDetail(icon, name, `${theme} · Token`, desc);
        return;
    }

    const overlay = containerEl.querySelector('.mystery-overlay');
    if (overlay) overlay.remove();
    containerEl.classList.remove('token-unrevealed');
    containerEl.classList.add('earned');
    const card = containerEl.querySelector('.achievement-card');
    if (card) card.classList.remove('token-card');

    try {
        const { data, error } = await supabase.rpc('reveal_token', {
            p_user_id: userProfile.id,
            p_token_id: tokenId
        });
        if (error) throw error;
        if (data && data.success === false) throw new Error(data.error || 'Reveal failed');
        revealedTokens.add(tokenId);
        showToast(`${name} revealed!`, 'success');
        await updateAchievementsBadge();
        // Show the same detail popup as milestones
        openAchievementDetail(icon, name, `${theme} · Token`, desc);
    } catch (err) {
        console.error('Error revealing token:', err);
        showToast('Failed to reveal token. Please try again.', 'error');
        // Revert UI on failure
        containerEl.classList.add('token-unrevealed');
        containerEl.classList.remove('earned');
        if (card) card.classList.add('token-card');
        if (!containerEl.querySelector('.mystery-overlay')) {
            const ov = document.createElement('div');
            ov.className = 'mystery-overlay';
            ov.innerHTML = '<div class="reveal-msg">Click To Reveal</div>';
            containerEl.querySelector('.achievement-card').prepend(ov);
        }
    }
};

function attachAchievement3DEffects(container) {
    if (!container) return;
    const fine = window.matchMedia('(hover: hover) and (pointer: fine)').matches;
    const cards = container.querySelectorAll('.achievement-card');
    cards.forEach(card => {
        if (fine) {
            // Desktop mouse: live 3D tilt
            card.addEventListener('mousemove', (e) => {
                const rect = card.getBoundingClientRect();
                const x = e.clientX - rect.left;
                const y = e.clientY - rect.top;
                const xc = rect.width / 2;
                const yc = rect.height / 2;
                const rotateX = (yc - y) / 10;
                const rotateY = (x - xc) / 10;
                card.style.transform = `rotateY(${rotateY}deg) rotateX(${rotateX}deg) translateY(-10px)`;
            });
            card.addEventListener('mouseleave', () => {
                card.style.transform = 'rotateY(0deg) rotateX(0deg) translateY(0)';
            });
        } else {
            // Touch: reset any transform after the tap so cards never stay tilted
            card.addEventListener('pointerup', () => {
                card.style.transform = 'rotateY(0deg) rotateX(0deg) translateY(0)';
            });
            card.addEventListener('pointercancel', () => {
                card.style.transform = 'rotateY(0deg) rotateX(0deg) translateY(0)';
            });
        }
    });
}

window.viewMilestone = async (containerEl) => {
    const milestoneId = containerEl.dataset.milestoneId;
    const name  = containerEl.dataset.name  || '';
    const icon  = containerEl.dataset.icon  || '';
    const sub   = containerEl.dataset.sub   || '';
    const desc  = containerEl.dataset.desc  || '';

    const overlay = containerEl.querySelector('.mystery-overlay');
    if (overlay) overlay.remove();
    containerEl.dataset.viewed = 'true';

    supabase.rpc('mark_milestone_viewed', {
        p_user_id: userProfile.id,
        p_milestone_id: milestoneId
    }).then(async ({ error }) => {
        if (error) {
            await supabase
                .from('user_milestones')
                .update({ viewed: true })
                .eq('user_id', userProfile.id)
                .eq('milestone_id', milestoneId);
        }
        await updateAchievementsBadge();
    }).catch(err => console.error('Error marking milestone as viewed:', err));

    openAchievementDetail(icon, name, sub, desc);
};

// Shared detail popup used by both milestones and tokens
function openAchievementDetail(icon, name, sub, desc) {
    const modal = document.getElementById('achievementModal');
    if (!modal) return;
    const imgEl   = modal.querySelector('#achievementModalImg');
    const titleEl = modal.querySelector('#achievementModalTitle');
    const subEl   = modal.querySelector('#achievementModalSub');
    const descEl  = modal.querySelector('#achievementModalDesc');

    if (imgEl)   { imgEl.src = icon; imgEl.alt = name; }
    if (titleEl)  titleEl.innerText = name;
    if (subEl)    subEl.innerText   = sub;
    if (descEl)   descEl.innerText  = desc;

    modal.style.display = 'flex';
    setTimeout(() => modal.classList.add('active'), 10);
};

window.closeAchievementModal = () => {
    const modal = document.getElementById('achievementModal');
    if (!modal) return;
    modal.classList.remove('active');
    modal.style.opacity = '0';
    setTimeout(() => {
        modal.style.display = 'none';
        modal.style.opacity = '';
    }, 350);
};

// ======================== FETCH BASE TASKS ========================
async function fetchBaseTasksForTier(tierNum) {
    const allowedStages = stagesForTier[tierNum];
    if (!allowedStages) return [];

    const { data: themes, error: themesError } = await supabase
        .from('themes')
        .select('theme_id, theme_name, primary_color, secondary_color')
        .lte('min_tier', tierNum);

    if (themesError) {
        console.error('Error fetching themes:', themesError);
        return [];
    }

    if (!themes.length) return [];

    const themeIds = themes.map(t => t.theme_id);

    const { data: tasks, error: tasksError } = await supabase
        .from('tasks')
        .select('*')
        .in('theme_id', themeIds);

    if (tasksError) {
        console.error('Error fetching tasks:', tasksError);
        return [];
    }

    const filteredTasks = tasks.filter(task => allowedStages.includes(stageKey(task.stage)));

    const themeColorMap = {};
    themes.forEach(t => { themeColorMap[t.theme_id] = t.primary_color || '#F59E0B'; });

    return filteredTasks.map(task => ({
        ...task,
        // tasks.subcategory does not exist in the live schema - the value lives in
        // tasks.category (rendered as the "Subcategory" pill). Normalise it once here
        // so every filter/dropdown that reads t.subcategory works.
        subcategory: task.subcategory ?? task.category ?? null,
        primary_color: themeColorMap[task.theme_id] || '#F59E0B'
    }));
}

// ======================== BOTTOM SHEET ========================
/* Sheets are a STACK, not a single slot.
   2026-10-14: showBottomSheet() used to delete the open sheet before building the
   next one. Opening the eye on a Tasks Reflection row ("Your Reflection") or on a
   Completed Tasks row (that task's full card) therefore destroyed the list the
   member opened it from, and closing the detail dropped them back on the page.
   Now every sheet is pushed ON TOP of its parent and closes innermost-first. */
const bottomSheetStack = [];

function topBottomSheet() {
    for (let i = bottomSheetStack.length - 1; i >= 0; i--) {
        if (bottomSheetStack[i].isConnected) return bottomSheetStack[i];
    }
    // a sheet created by another module (e.g. trial.js) is not in this stack
    const others = document.querySelectorAll('.bottom-sheet-overlay.active:not([data-static])');
    return others.length ? others[others.length - 1] : null;
}

/* Only the innermost sheet is live. The ones underneath stay on screen (that is
   the step the member came from) but take no clicks and no scroll. */
function syncBottomSheetStack() {
    const top = topBottomSheet();
    bottomSheetStack.forEach(sheet => {
        if (!sheet.isConnected) return;
        sheet.classList.toggle('sheet-top', sheet === top);
        sheet.classList.toggle('sheet-behind', sheet !== top);
    });
    document.body.style.overflow = top ? 'hidden' : '';
}

/* Closes one sheet. Defaults to the innermost one; the sheet underneath, if any,
   becomes the live sheet again the moment this one is popped. */
function closeBottomSheet(target) {
    const overlay = target || topBottomSheet();
    if (!overlay) return null;
    const idx = bottomSheetStack.indexOf(overlay);
    if (idx !== -1) bottomSheetStack.splice(idx, 1);
    overlay.classList.remove('active');
    syncBottomSheetStack();
    setTimeout(() => overlay.remove(), 300);
    return overlay;
}

function showBottomSheet(title, contentHtml, onClose) {
    // Static sheets (Edit Profile, Upgrade Tier) are page markup — never touched here.
    const overlay = document.createElement('div');
    overlay.className = 'bottom-sheet-overlay';
    overlay.innerHTML = `
        <div class="bottom-sheet">
            <div class="bottom-sheet-header">
                <h3>${title}</h3>
                <button class="bottom-sheet-close">&times;</button>
            </div>
            <div class="bottom-sheet-content">
                ${contentHtml}
            </div>
        </div>
    `;
    document.body.appendChild(overlay);
    bottomSheetStack.push(overlay);
    // every nested sheet paints above its parent, and above the static sheets
    overlay.style.zIndex = String(10000 + bottomSheetStack.length * 10);
    document.body.style.overflow = 'hidden';

    const closeBtn = overlay.querySelector('.bottom-sheet-close');
    const close = () => {
        if (!overlay.classList.contains('active')) return; // already closing
        closeBottomSheet(overlay);
        if (onClose) onClose();
    };
    closeBtn.addEventListener('click', close);
    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) close();
    });

    overlay.offsetHeight;
    overlay.classList.add('active');
    syncBottomSheetStack();
    return overlay;
}

/* Escape closes the innermost sheet only — never the one that opened it. */
document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const top = topBottomSheet();
    const closeBtn = top ? top.querySelector('.bottom-sheet-close') : null;
    if (closeBtn) closeBtn.click();
});

function closeAllBottomSheets() {
  bottomSheetStack.length = 0;
  const sheets = document.querySelectorAll('.bottom-sheet-overlay');
  sheets.forEach(sheet => {
    sheet.classList.remove('active', 'sheet-top', 'sheet-behind');
    if (sheet.dataset.static) {
      sheet.style.visibility = 'hidden';
      sheet.style.opacity = '0';
    } else {
      sheet.remove();
    }
  });
  document.body.style.overflow = '';
}
// ======================== TASK HELPER ========================
function attachTaskEventListeners(container) {
    container.querySelectorAll('.task-check:not([disabled])').forEach(el => {
        el.onchange = (e) => handleDone(e.target);
    });
    container.querySelectorAll('.react-btn:not([disabled])').forEach(el => {
        el.onclick = (e) => handleReact(e.target);
    });
    container.querySelectorAll('.comment-btn:not([disabled])').forEach(el => {
        // 2026-10-13: e.target is the <i class="fa-paper-plane"> icon (no data-id) -> comments
        // silently did nothing. Bind the BUTTON itself via currentTarget.
        el.onclick = (e) => handleComment(e.currentTarget || el);
    });
    container.querySelectorAll('.go-task-btn').forEach(el => {
        el.onclick = (e) => { e.preventDefault(); e.stopPropagation(); goToBlockerTask(el.dataset.blocker, el); };
    });
}

// Jump to the task that must be completed first (locked card -> "Go to task").
function goToBlockerTask(blockerId, btn) {
    if (blockerId === null || blockerId === undefined || blockerId === '') return;
    const cardId = `post-${String(blockerId)}`;
    const scope = (btn && btn.closest && btn.closest('#tasks, .bottom-sheet-content')) || document;
    let target = scope.querySelector('#' + CSS.escape(cardId)) || document.getElementById(cardId);
    if (!target && !locksExpanded) {
        locksExpanded = true;
        renderTaskList(lastRenderedTasks);
        target = document.getElementById(cardId);
    }
    if (!target) {
        showToast('That task is hidden by the current filters. Reset filters to see it.', 'error');
        return;
    }
    if (target.closest('.bottom-sheet-content')) closeAllBottomSheets();
    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    target.classList.add('flash');
    setTimeout(() => target.classList.remove('flash'), 2200);
}

// ======================== TASK RENDERING ========================
async function refreshTasks() {
    const now = new Date();

    // Group tasks by theme and sort by order within each theme
    const themeGroups = {};
    baseTasks.forEach(task => {
        if (!themeGroups[task.theme_id]) themeGroups[task.theme_id] = [];
        themeGroups[task.theme_id].push(task);
    });
    Object.values(themeGroups).forEach(group => group.sort((a, b) => a.task_order - b.task_order));

    // Determine unlock status per task: sequential per-theme with 24h cooldown
    const tasksWithUnlock = baseTasks.map(task => {
        const group = themeGroups[task.theme_id] || [];
        const idx = group.indexOf(task);
        const completedSet = showingExperienced ? completedExperienced : completedNovice;

        // First task in a theme is always unlocked if not completed
        if (idx === 0) {
            return { ...task, is_unlocked: !completedSet.has(task.id), unlock_message: '', blocker_id: null, blocker_title: null, unlock_at: null };
        }

        // Check if the immediately previous task in this theme is completed
        const prevTask = group[idx - 1];
        const prevCompleted = completedSet.has(prevTask.id);
        const prevCompletedAt = prevCompleted ? completedAtMap[prevTask.id] : null;

        if (!prevCompleted) {
            return { ...task, is_unlocked: false, unlock_message: `Complete "${prevTask.task_title}" to unlock`, blocker_id: prevTask.id, blocker_title: prevTask.task_title, unlock_at: null };
        }

        // Previous task completed — check 24h cooldown
        const hoursSincePrev = prevCompletedAt
            ? (now - new Date(prevCompletedAt)) / (1000 * 60 * 60)
            : 999;
        const cooldownHours = 24;
        const hoursLeft = Math.ceil(cooldownHours - hoursSincePrev);

        if (hoursSincePrev >= cooldownHours) {
            // Check if this task itself is already completed
            return { ...task, is_unlocked: !completedSet.has(task.id), unlock_message: '', blocker_id: null, blocker_title: null, unlock_at: null };
        } else {
            const lockMsg = hoursLeft > 1
                ? `"${prevTask.task_title}" completed — ${hoursLeft}h until unlocked`
                : `"${prevTask.task_title}" completed — ${Math.ceil(hoursLeft * 60)}m until unlocked`;
            return { ...task, is_unlocked: false, unlock_message: lockMsg, blocker_id: null, blocker_title: null, unlock_at: prevCompletedAt ? new Date(prevCompletedAt).getTime() + cooldownHours * 60 * 60 * 1000 : null };
        }
    });

    let filteredTasks = tasksWithUnlock;
    if (selectedThemes.length > 0) {
        filteredTasks = tasksWithUnlock.filter(task => selectedThemes.includes(task.theme_id));
    }

    allTasksWithCompleted = filteredTasks;

    if (showingExperienced) {
        allTasks = filteredTasks.filter(task => !completedExperienced.has(task.id));
    } else {
        allTasks = filteredTasks.filter(task => !completedNovice.has(task.id));
    }

    await applyFiltersAndRender();
}

async function applyFiltersAndRender() {
    let filtered = [...allTasks];
    if (activeFilters.core_theme.length > 0) {
        filtered = filtered.filter(t => activeFilters.core_theme.includes(t.core_theme));
    }
    if (activeFilters.stage.length > 0) {
        filtered = filtered.filter(t => activeFilters.stage.includes(t.stage));
    }
    if (activeFilters.subcategory.length > 0) {
        filtered = filtered.filter(t => activeFilters.subcategory.includes(t.subcategory));
    }

    let filteredWithCompleted = [...allTasksWithCompleted];
    if (activeFilters.core_theme.length > 0) {
        filteredWithCompleted = filteredWithCompleted.filter(t => activeFilters.core_theme.includes(t.core_theme));
    }
    if (activeFilters.stage.length > 0) {
        filteredWithCompleted = filteredWithCompleted.filter(t => activeFilters.stage.includes(t.stage));
    }
    if (activeFilters.subcategory.length > 0) {
        filteredWithCompleted = filteredWithCompleted.filter(t => activeFilters.subcategory.includes(t.subcategory));
    }

    const completedSet = showingExperienced ? completedExperienced : completedNovice;
    // Nectar-bar denominator = the visible scope (completed tasks included) - never shrinks.
    let visible = filteredWithCompleted.slice();
    if (storyFilter === 'mine') {
        visible = visible.filter(t => completedSet.has(t.id));
    } else if (storyFilter === 'partner') {
        visible = visible.filter(t => typeof isPartnerDone === 'function' && isPartnerDone(t.id));
    } else if (storyFilter && storyFilter !== 'All') {
        visible = visible.filter(t => t.core_theme === storyFilter);
    }
    // A completed task is stored with is_unlocked = false, so it is part of the
    // visible head - never the locked tail.
    // 2026-10-13: a DONE task must never be rendered in the Daily Tasks list — it is
    // still counted below (progress bar reads `visible`), just not shown as a card.
    // Exception: the explicit "mine" story chip is a completed-only view, so keep it working.
    const completedOnlyView = (storyFilter === 'mine');
    const headTasks = completedOnlyView
        ? visible.filter(t => completedSet.has(t.id))
        : visible.filter(t => t.is_unlocked && !completedSet.has(t.id));
    const lockedTasks = visible.filter(t => !t.is_unlocked && !completedSet.has(t.id));

    totalVisibleTasks = visible.length;
    completedVisibleTasks = visible.filter(t => completedSet.has(t.id)).length;

    // 2026-10-13: locked cards are ordered by TIME TO UNLOCK (soonest first: 3h -> 6h -> 12h),
    // chain-locked cards (no clock, "complete X first") go last; task_order breaks ties.
    const unlockTs = (t) => {
        if (!t.unlock_at) return Infinity;
        const ms = new Date(t.unlock_at).getTime();
        return isNaN(ms) ? Infinity : ms;
    };
    const soonestFirst = (a, b) => {
        const ua = unlockTs(a), ub = unlockTs(b);
        if (ua !== ub) return ua - ub;
        if (String(a.theme_id) !== String(b.theme_id)) return String(a.theme_id).localeCompare(String(b.theme_id));
        return a.task_order - b.task_order;
    };
    const tasksToShow = [
        ...headTasks.slice().sort((a, b) => a.task_order - b.task_order),
        ...lockedTasks.slice().sort(soonestFirst)
    ];
    renderTaskList(tasksToShow);
    renderStories();
    updateFilterBadge();

    const pct = totalVisibleTasks ? Math.min(Math.round((completedVisibleTasks / totalVisibleTasks) * 100), 100) : 0;

    const progressBar = document.getElementById('progressBar');
    const progressPct = document.getElementById('progressPct');
    if (progressBar) progressBar.value = pct;
    if (progressPct) progressPct.innerText = `${pct}% (${completedVisibleTasks}/${totalVisibleTasks})`;

    const mobileProgressBar = document.getElementById('mobileProgressBar');
    const mobileProgressPct = document.getElementById('mobileProgressPct');
    if (mobileProgressBar) mobileProgressBar.value = pct;
    if (mobileProgressPct) mobileProgressPct.innerText = `${pct}% (${completedVisibleTasks}/${totalVisibleTasks})`;

    const mobileProgressBarCopy = document.getElementById('mobileProgressBarCopy');
    const mobileProgressPctCopy = document.getElementById('mobileProgressPctCopy');
    if (mobileProgressBarCopy) mobileProgressBarCopy.value = pct;
    if (mobileProgressPctCopy) mobileProgressPctCopy.innerText = `${pct}% (${completedVisibleTasks}/${totalVisibleTasks})`;

    updateProfileUI();
    updateCompletedBadge();
    updatePendingSigmaBadge();
    updateTabCounts();
    updatePartnerCompare();
}

function renderTaskList(tasks) {
    const container = document.getElementById('tasks');
    if (!container) return;

    const completedNow = showingExperienced ? completedExperienced : completedNovice;

    if (!tasks.length) {
        container.innerHTML = `
            <div class="card empty">
                <h3>Nothing here yet</h3>
                <p class="muted">No tasks match the current filters.</p>
                <button type="button" class="btn pri" id="emptyResetBtn">Reset filters</button>
            </div>`;
        const resetBtn = document.getElementById('emptyResetBtn');
        if (resetBtn) resetBtn.addEventListener('click', resetFilters);
        return;
    }

    const inScope = t => t.is_unlocked || completedNow.has(t.id);
    const headTasks = tasks.filter(inScope);
    const tailTasks = tasks.filter(t => !inScope(t));
    // Locked tasks: soonest-to-unlock first (3h -> 6h -> 12h -> chain-locked), then natural order.
    const unlockKey = t => (typeof t.unlock_at === 'number' && isFinite(t.unlock_at)) ? t.unlock_at : Infinity;
    tailTasks.sort((a, b) => {
        const av = unlockKey(a), bv = unlockKey(b);
        if (av !== bv) return av - bv;
        if (a.theme_id !== b.theme_id) return String(a.theme_id).localeCompare(String(b.theme_id));
        return (a.task_order || 0) - (b.task_order || 0);
    });
    lastRenderedTasks = tasks;
    const HIDDEN_LIMIT = 3;
    const showTail = locksExpanded ? tailTasks : tailTasks.slice(0, HIDDEN_LIMIT);

    container.innerHTML = '';
    [...headTasks, ...showTail].forEach(task => {
        const card = createTaskCard(task);
        if (justCompletedId && String(task.id) === String(justCompletedId)) card.classList.add('pop');
        container.appendChild(card);
    });

    if (tailTasks.length > HIDDEN_LIMIT) {
        const rest = tailTasks.length - HIDDEN_LIMIT;
        const moreBtn = document.createElement('button');
        moreBtn.type = 'button';
        moreBtn.className = 'more';
        moreBtn.innerText = locksExpanded ? 'Show fewer locked tasks' : `Show ${rest} more locked task${rest === 1 ? '' : 's'}`;
        moreBtn.addEventListener('click', () => { locksExpanded = !locksExpanded; renderTaskList(tasks); });
        container.appendChild(moreBtn);
    }

    justCompletedId = null;
    attachTaskEventListeners(container);
}

function createTaskCard(task) {
    const completedSet = showingExperienced ? completedExperienced : completedNovice;
    const isCompleted = completedSet.has(task.id);
    // A completed task is persisted with is_unlocked = false (completion locks it), so a
    // done card must never be styled as locked: lock icon + empty lockbox + disabled controls.
    // NOTE: isLocked must stay AFTER isCompleted - referencing it earlier is a TDZ crash.
    const isLocked = !task.is_unlocked && !isCompleted;
    const currentReaction = userReactions[task.id];
    const taskComments = userComments.filter(c => c.task_id === task.id);

    const description = showingExperienced ? (task.experienced_description || task.task_description) : (task.novice_description || task.task_description);

    // Partner context (collective tier and above)
    const partnerName = hasCollabAccess && partnerInfo.length > 0 ? partnerInfo[0].username : 'Partner';
    const partnerHasAnyCompleted = hasCollabAccess && partnerCompletedTasks.size > 0;
    const partnerDoneThis = hasCollabAccess && typeof isPartnerDone === 'function' && isPartnerDone(task.id);

    // Card state drives the design's 5 looks (business logic unchanged)
    const state = (isCompleted && partnerDoneThis) ? 'both'
        : isCompleted ? 'done'
        : isLocked ? 'locked'
        : partnerHasAnyCompleted ? 'due'
        : 'available';

    // Per-task partner line (design)
    const partnerLine = partnerDoneThis
        ? (isCompleted
            ? `<div class="pst good"><span class="av sg">${escapeHtml((partnerName || 'P')[0].toUpperCase())}</span><span class="tx"><b>You and ${escapeHtml(partnerName)}</b> both completed this</span></div>`
            : isLocked
                ? `<div class="pst turn"><span class="av sg">${escapeHtml((partnerName || 'P')[0].toUpperCase())}</span><span class="tx"><b>${escapeHtml(partnerName)}</b> completed &mdash; you have not reached this yet</span></div>`
                : `<div class="pst good"><span class="av sg">${escapeHtml((partnerName || 'P')[0].toUpperCase())}</span><span class="tx"><b>${escapeHtml(partnerName)}</b> completed this</span></div>`)
        : (partnerHasAnyCompleted && !isCompleted && !isLocked
            ? `<div class="pst turn"><span class="av sg">${escapeHtml((partnerName || 'P')[0].toUpperCase())}</span><span class="tx">Due for you &mdash; <b>${escapeHtml(partnerName)}</b> completed other tasks</span></div>`
            : '');

    const mark = isLocked
        ? `<span class="nd locked"><i class="fas fa-lock"></i></span>`
        : isCompleted
            ? `<span class="nd done"><i class="fas fa-check"></i></span>`
            : `<input type="checkbox" class="task-check" data-id="${task.id}" data-version="${showingExperienced ? 'experienced' : 'novice'}" aria-label="Mark complete">`;

    const pills = `<div class="filters">
                    <span class="pill core">${task.core_theme || 'Theme'}</span>
                    <span class="pill stage">${task.stage || 'Stage'}</span>
                    <span class="pill aud">${task.audience || 'All'}</span>
                    <span class="pill sub">${task.category || 'Subcategory'}</span>
                </div>`;

    const taskDiv = document.createElement('div');
    taskDiv.className = `post card task-item ${state}`;
    taskDiv.dataset.id = task.id;
    taskDiv.id = `post-${task.id}`;

    const blockerId = (task.blocker_id === null || task.blocker_id === undefined) ? null : String(task.blocker_id);
    const blockerDone = blockerId !== null && completedSet.has(blockerId) === true;
    const showGo = isLocked && blockerId !== null && !blockerDone;

    const cardHtml = `
        <div class="phd">
            ${mark}
            <div class="pw">
                <b>${task.core_theme || 'Theme'}</b>
                <small>${[task.stage, task.category, state === 'both' ? 'You + ' + partnerName : state === 'done' ? 'Completed' : state === 'locked' ? 'Locked' : state === 'due' ? 'Due for you' : 'Ready now'].filter(Boolean).join(' \u00b7 ')}</small>
            </div>
        </div>
        <div class="pbody">
            <h3>${task.task_title || 'Task'}</h3>
            <p>${description}</p>
            ${pills}
            <div class="imp"><b>Impact:</b> ${task.impact_value || 'N/A'}</div>
            ${isLocked && (task.unlock_message || showGo) ? `<div class="lockbox"><span>${task.unlock_message || ''}${showGo ? '<br><small class="tiny">Complete this task first</small>' : ''}</span>${showGo ? `<button type="button" class="btn pri go-task-btn" data-blocker="${escapeHtml(blockerId)}">Go to task</button>` : ''}</div>` : ''}
        </div>
        <div class="abar">
            <button class="ab react-btn${currentReaction === 'like' ? ' on' : ''}" data-id="${task.id}" data-type="like" ${isLocked ? 'disabled' : ''}><i class="fas fa-thumbs-up"></i> Like</button>
            <button class="ab react-btn clay${currentReaction === 'dislike' ? ' on' : ''}" data-id="${task.id}" data-type="dislike" ${isLocked ? 'disabled' : ''}><i class="fas fa-thumbs-down"></i> Dislike</button>
        </div>
        ${partnerLine}
        ${(hasCollabAccess && partnerHasAnyCompleted && !partnerDoneThis && !isCompleted && !isLocked) ? `<button type="button" class="mini" data-nudge="${task.id}"><i class="fas fa-bell ic"></i> Nudge ${escapeHtml(partnerName)}</button>` : ''}
        <div class="reacts">
            <span class="rc">${currentReaction ? `<span class="stack"><span class="av">${escapeHtml((userProfile.first_name || 'Y')[0].toUpperCase())}</span></span>` : ''}${currentReaction === 'like' ? 'You liked this' : currentReaction === 'dislike' ? 'You disliked this' : isCompleted ? 'You completed this' : 'No reaction yet'}</span>
            <span class="rc">${taskComments.length} comment${taskComments.length === 1 ? '' : 's'}</span>
        </div>
        <div class="thread">
            ${taskComments.map(c => `
                <div id="comment-box-${c.id}" class="cmt">
                    <div class="bub"><div>${escapeHtml(c.comment_text)}</div></div>
                </div>
                <div class="cact"><button onclick="window.startEditComment('${c.id}', '${escapeHtml(c.comment_text).replace(/'/g, "\\'")}')">Edit</button>
                <button onclick="window.deleteComment('${c.id}')">Delete</button></div>
            `).join('')}
            <div class="ci">
                <input type="text" class="comment-input" data-id="${task.id}" placeholder="Write a comment..." ${isLocked ? 'disabled' : ''}>
                <button class="comment-btn ci-send" data-id="${task.id}" aria-label="Post comment" ${isLocked ? 'disabled' : ''}><i class="fas fa-paper-plane"></i></button>
            </div>
        </div>
    `;

    taskDiv.innerHTML = cardHtml;

    return taskDiv;
}

// ======================== TASK ACTIONS ========================
async function handleDone(checkbox) {
    if (!checkbox.checked) return;
    const taskId = checkbox.dataset.id;
    const version = checkbox.dataset.version;

    Loader.show("Completing task...");
    checkbox.disabled = true;

    try {
        const { data: result, error } = await supabase.rpc('complete_task', {
            p_user_id: userProfile.id,
            p_task_id: taskId,
            p_version: version
        });

        if (error) throw error;

        if (version === 'novice') {
            completedNovice.add(taskId);
            completedAtMap[taskId] = new Date().toISOString();
        } else {
            completedExperienced.add(taskId);
            completedAtMap[taskId] = new Date().toISOString();
        }

        justCompletedId = taskId;

        const pointsEarned = result.points_earned;
        userProfile.total_points = (userProfile.total_points || 0) + pointsEarned;
        userProfile.nectar_points = userProfile.total_points;
        userProfile.experience = userProfile.total_points % 100;
        userProfile.user_level = result.new_user_level;
        userProfile.engagement_level = result.new_engagement_level;

        if (result.awarded_milestones && result.awarded_milestones.length) {
            result.awarded_milestones.forEach(m => {
                showToast(`${m.name} milestone unlocked!`, 'success');
            });
        }
        if (result.awarded_tokens && result.awarded_tokens.length) {
            result.awarded_tokens.forEach(t => {
                showToast(`New token: ${t.token_name} (${t.stage})`, 'success');
            });
        }
        // Refresh achievement badge count after any awards
        await updateAchievementsBadge();

        // Find next locked task in same theme and show unlock ETA
        const completedTask = baseTasks.find(t => t.id === taskId);
        if (completedTask) {
            const nextInTheme = baseTasks
                .filter(t => t.theme_id === completedTask.theme_id && t.task_order > completedTask.task_order)
                .sort((a, b) => a.task_order - b.task_order)[0];
            if (nextInTheme) {
                const completedSet = showingExperienced ? completedExperienced : completedNovice;
                showToast(`"${completedTask.task_title}" done! "${nextInTheme.task_title}" unlocks in 24h`, 'success');
            }
        }

        const { data: progressData, error: progressError } = await supabase
            .from('user_theme_progress')
            .select('theme_id, stage, novice_days_count, experienced_days_count')
            .eq('user_id', userProfile.id);
        if (!progressError && progressData) {
            themeStageProgress = {};
            progressData.forEach(p => {
                if (!themeStageProgress[p.theme_id]) themeStageProgress[p.theme_id] = {};
                themeStageProgress[p.theme_id][p.stage] = {
                    novice: p.novice_days_count,
                    experienced: p.experienced_days_count
                };
            });
        }

        await refreshTasks();

        const openBottomSheet = topBottomSheet();
        if (openBottomSheet) {
            const title = openBottomSheet.querySelector('.bottom-sheet-header h3')?.innerText;
            if (title === 'Daily Tasks') {
                const tasksContainer = document.getElementById('mobileTasksContainerCopy');
                if (tasksContainer) {
                    tasksContainer.innerHTML = '';
                    allTasks.forEach(task => {
                        const taskDiv = createTaskCard(task);
                        tasksContainer.appendChild(taskDiv);
                    });
                    attachTaskEventListeners(tasksContainer);
                }
                const completedSet = showingExperienced ? completedExperienced : completedNovice;
                const scopeAll = allTasksWithCompleted;
                const completedVisible = scopeAll.filter(t => completedSet.has(t.id)).length;
                const totalVisible = scopeAll.length;
                const pct = totalVisible ? Math.min(Math.round((completedVisible / totalVisible) * 100), 100) : 0;
                const progressBar = document.getElementById('mobileProgressBarCopy');
                const progressPct = document.getElementById('mobileProgressPctCopy');
                if (progressBar) progressBar.value = pct;
                if (progressPct) progressPct.innerText = `${pct}% (${completedVisible}/${totalVisible})`;
            }
        }

        updateProfileUI();
        await checkAndAwardMilestones();
        
        if (result.new_user_level !== userProfile.user_level) {
            showCustomLevelModal(result.new_user_level);
        }

        autoSwitchToExperiencedIfReady();

        // Refresh mobile bottom sheet if open
        if (window._mobileSheetOpen && window.refreshMobileSheet) {
            window.refreshMobileSheet();
        }

    } catch (err) {
        console.error("Completion error:", err);
        showToast(err.message, "error");
        checkbox.checked = false;
    } finally {
        Loader.hide();
        checkbox.disabled = false;
    }
}

async function handleReact(btn) {
    const taskId = btn.dataset.id;
    const reactionType = btn.dataset.type;

    const { error } = await supabase
        .from('task_feedback')
        .upsert({
            user_id: userProfile.id,
            task_id: taskId,
            reaction: reactionType
        }, { onConflict: 'user_id, task_id' });

    if (error) {
        console.error('Reaction error:', error);
        showToast('Failed to save reaction', 'error');
        return;
    }

    userReactions[taskId] = reactionType;

    const taskCard = btn.closest('.task-item');
    if (taskCard) {
        const likeBtn = taskCard.querySelector(`.react-btn[data-id="${taskId}"][data-type="like"]`);
        const dislikeBtn = taskCard.querySelector(`.react-btn[data-id="${taskId}"][data-type="dislike"]`);
        if (likeBtn) {
            likeBtn.classList.toggle('on', reactionType === 'like');
            likeBtn.style.background = reactionType === 'like' ? '#22c55e' : '#ffcc00';
            likeBtn.style.color = reactionType === 'like' ? 'white' : '#1e293b';
        }
        if (dislikeBtn) {
            dislikeBtn.classList.toggle('on', reactionType === 'dislike');
            dislikeBtn.style.background = reactionType === 'dislike' ? '#ef4444' : '#ffcc00';
            dislikeBtn.style.color = reactionType === 'dislike' ? 'white' : '#1e293b';
        }
    }
}

async function handleComment(btn) {
    // 2026-10-13: resolve the real button + task id no matter what was clicked inside it,
    // and surface failures instead of dying silently on a null input.
    const el = (btn && btn.closest && btn.closest('.comment-btn')) || btn;
    const taskId = el && el.dataset ? el.dataset.id : null;
    if (!taskId) { console.warn('[comment] no task id on', btn); return; }
    // 2026-10-13: the same task can be on screen twice (feed card + detail sheet), so
    // resolve the composer inside the caller's own container before falling back.
    const scope = (el && el.closest && el.closest('.bottom-sheet-content, #tasks')) || null;
    const input = (scope && scope.querySelector(`.comment-input[data-id="${taskId}"]`))
        || document.querySelector(`.comment-input[data-id="${taskId}"]`);
    if (!input) { console.warn('[comment] composer missing for task', taskId); return; }
    const text = (input.value || '').trim();
    if (!text) return;
    const { data, error } = await supabase.from('task_comments').insert([{
        user_id: userProfile.id,
        task_id: taskId,
        comment_text: text
    }]).select();
    if (error) {
        console.error('[comment] insert failed', error);
        if (typeof showToast === 'function') showToast('Could not post that comment.', 'error');
        return;
    }
    input.value = '';
    // 2026-10-13: refreshTasks() renders from the in-memory userComments list, so a posted
    // comment only appeared after a full page reload. Add it locally so it shows instantly.
    const row = (data && data[0]) || { id: 'local-' + Date.now(), user_id: userProfile.id, task_id: taskId, comment_text: text };
    userComments.push(row);
    refreshTasks();
}

// ======================== UI UPDATES ========================

/* Meadow rank = the member's position on the public leaderboard, computed by
 * get_public_profile() with the same RANK() OVER (ORDER BY nectar_points DESC,
 * join_date ASC) that get_leaderboard() uses, so the badge and the leaderboard
 * can never disagree. It is NOT member_tier: that is the subscription tier, and
 * using it printed "#3" for a tier-3 member who is actually ranked #1.
 */
let meadowRank = null; // null = not fetched yet

function paintMeadowRank() {
    const text = meadowRank > 0 ? `#${meadowRank}` : '#--';
    const desktop = document.getElementById('rankLevel');
    if (desktop) desktop.innerText = text;
    const mobile = document.getElementById('mobileRankLevel');
    if (mobile) mobile.innerText = text;
}

async function refreshMeadowRank(userId) {
    try {
        const { data } = await supabase.rpc('get_public_profile', { p_id: userId });
        meadowRank = data && data.ok ? (Number(data.rank) || 0) : 0;
    } catch (_) {
        meadowRank = 0;
    }
    paintMeadowRank();
}

function updateProfileUI() {
    const totalPoints = userProfile.total_points || 0;
    const nectarEarned = Math.floor(totalPoints / 100);
    const progressToNext = totalPoints % 100;
    const percent = progressToNext;
    const tier = userProfile.tier || 'free';

    const userNameShort = document.getElementById('userNameDisplayShort');
    if (userNameShort) userNameShort.innerText = `${userProfile.first_name} ${userProfile.last_name}`;

    const heroName = document.getElementById('heroName');
    if (heroName) heroName.innerText = (userProfile.first_name || userProfile.username || 'Your meadow');

    const rankCompact = document.getElementById('rankNameDisplayCompact');
    if (rankCompact) rankCompact.innerText = `Meadow Level ${userProfile.member_tier || 0}`;

    const tierCompact = document.getElementById('userTierBadgeCompact');
    if (tierCompact) tierCompact.innerText = tier === 'free' ? 'Free' : tier === 'plus' ? 'Meadow+' : tier === 'steward' ? 'Steward' : 'Collective';

    const pointsVal = document.getElementById('pointsVal');
    if (pointsVal) pointsVal.innerText = nectarEarned;

    if (meadowRank === null) refreshMeadowRank(userProfile.id);
    paintMeadowRank();

    paintMeadowRank();

    const mobileExpBar = document.getElementById('mobileExperienceBar');
    const mobileExpText = document.getElementById('mobileExpText');
    if (mobileExpBar && mobileExpText) {
        mobileExpBar.value = progressToNext;
        mobileExpText.innerText = `${progressToNext}/100`;
    }

    const mobileRankDisplay = document.getElementById('mobileRankDisplay');
    if (mobileRankDisplay) mobileRankDisplay.innerText = `Meadow Level ${userProfile.member_tier || 0}`;

    const mobileTierBadge = document.querySelector('.mobile-hero .tier-badge');
    if (mobileTierBadge) mobileTierBadge.innerText = tier === 'free' ? 'Free' : tier === 'plus' ? 'Meadow+' : tier === 'steward' ? 'Steward' : 'Collective';

    const avatarImg = document.getElementById('profileAvatar');
    if (avatarImg && userProfile.avatar_url) {
        avatarImg.src = userProfile.avatar_url;
    }
    // Profile design layer: mirror the avatar into the topbar + composer discs
    const avatarUrl = (userProfile && userProfile.avatar_url) || (avatarImg ? avatarImg.src : '');
    if (avatarUrl) {
        ['topbarAvatar', 'composerAvatar'].forEach(id => {
            const el = document.getElementById(id);
            if (el) {
                el.style.backgroundImage = `url("${avatarUrl}")`;
                el.style.backgroundSize = 'cover';
                el.style.backgroundPosition = 'center';
            }
        });
    }
}
function showCustomLevelModal(newLevel) {
    const modal = document.getElementById('achieveModal');
    const img = document.getElementById('modalImg');
    img.src = 'assets/avatar-fallback.svg';
    modal.style.display = 'flex';
    const shareBtn = modal.querySelector('.btn');
    shareBtn.innerText = 'Continue';
    shareBtn.onclick = () => modal.style.display = 'none';
    const closeBtn = modal.querySelector('.close-modal-btn');
    closeBtn.onclick = () => modal.style.display = 'none';
}

// ======================== FILTERS ========================
function buildFilterOptionHtml(val, checked = false) {
    return `<label class="filter-item">
        <input type="checkbox" value="${val}" ${checked ? 'checked' : ''}>
        <span>${val}</span>
    </label>`;
}

function setupMultiFilters() {
    const setupDropdown = (id) => {
        const container = document.getElementById(id);
        if (!container) return;
        container.querySelector('.dropdown-header').onclick = (e) => {
            e.stopPropagation();
            const isOpen = container.classList.contains('open');
            document.querySelectorAll('.dropdown-container').forEach(d => d.classList.remove('open'));
            if (!isOpen) container.classList.add('open');
        };
    };
    setupDropdown('coreFilterDropdown');
    setupDropdown('stageFilterDropdown');
    setupDropdown('tagFilterDropdown');
    document.addEventListener('click', () => document.querySelectorAll('.dropdown-container').forEach(d => d.classList.remove('open')));
    updateFilterOptions(baseTasks);
}

function updateFilterOptions(availableTasks) {
    const fields = [
        { field: 'core_theme', listId: 'coreFilterList', summaryId: 'coreFilterSummary' },
        { field: 'stage', listId: 'stageFilterList', summaryId: 'stageFilterSummary' },
        { field: 'subcategory', listId: 'tagFilterList', summaryId: 'tagFilterSummary' }
    ];
    fields.forEach(({ field, listId, summaryId }) => {
        const uniqueValues = [...new Set(availableTasks.map(t => t[field]))];
        const listContainer = document.getElementById(listId);
        const summarySpan = document.getElementById(summaryId);
        const currentSelected = activeFilters[field] || [];
        activeFilters[field] = currentSelected.filter(val => uniqueValues.includes(val));
        listContainer.innerHTML = uniqueValues.map(val =>
            buildFilterOptionHtml(val, activeFilters[field].includes(val))
        ).join('');
        summarySpan.innerText = activeFilters[field].length > 0 ? `${activeFilters[field].length} Selected` : "All";
        listContainer.querySelectorAll('input').forEach(cb => {
            cb.onchange = () => {
                const checked = Array.from(listContainer.querySelectorAll('input:checked')).map(c => c.value);
                activeFilters[field] = checked;
                summarySpan.innerText = checked.length > 0 ? `${checked.length} Selected` : "All";
                applyFiltersAndRender();
            };
        });
    });
}

// ======================== BOTTOM SHEET RENDERING ========================
function renderMobileTasksInSheet(suffix, tasks = allTasks) {
    const container = document.getElementById(`mobileTasksContainer${suffix}`);
    if (!container) return;
    const sourceTasks = tasks;
    const completedSet = showingExperienced ? completedExperienced : completedNovice;
    const scopeAll = allTasksWithCompleted;
    const completedVisible = scopeAll.filter(t => completedSet.has(t.id)).length;
    const totalVisible = scopeAll.length;
    const pct = totalVisible ? Math.min(Math.round((completedVisible / totalVisible) * 100), 100) : 0;
    const progressBar = document.getElementById(`mobileProgressBarCopy`);
    const progressPct = document.getElementById(`mobileProgressPctCopy`);
    if (progressBar) progressBar.value = pct;
    if (progressPct) progressPct.innerText = `${pct}% (${completedVisible}/${totalVisible})`;

    if (!sourceTasks.length) {
        container.innerHTML = '<p class="tiny muted">No missions available.</p>';
        return;
    }
    container.innerHTML = '';
    sourceTasks.forEach(task => {
        const taskDiv = createTaskCard(task);
        container.appendChild(taskDiv);
    });
    attachTaskEventListeners(container);
}

function populateMobileFilters(suffix) {
    const sourceTasks = allTasks;
    const uniqueThemes = [...new Set(sourceTasks.map(t => t.core_theme).filter(Boolean))];
    const uniqueStages = [...new Set(sourceTasks.map(t => t.stage).filter(Boolean))];
    const uniqueTags = [...new Set(sourceTasks.map(t => t.subcategory).filter(Boolean))];

    const themeList = document.getElementById(`mobileCoreFilterList${suffix}`);
    const stageList = document.getElementById(`mobileStageFilterList${suffix}`);
    const tagList = document.getElementById(`mobileTagFilterList${suffix}`);

    if (themeList) {
        themeList.innerHTML = uniqueThemes.map(val => buildFilterOptionHtml(val)).join('');
    }
    if (stageList) {
        stageList.innerHTML = uniqueStages.map(val => buildFilterOptionHtml(val)).join('');
    }
    if (tagList) {
        tagList.innerHTML = uniqueTags.map(val => buildFilterOptionHtml(val)).join('');
    }
}

function attachMobileFilterListeners(suffix) {
    const themeContainer = document.getElementById(`mobileCoreFilterDropdownCopy`);
    const stageContainer = document.getElementById(`mobileStageFilterDropdownCopy`);
    const tagContainer = document.getElementById(`mobileTagFilterDropdownCopy`);

    [themeContainer, stageContainer, tagContainer].forEach(container => {
        if (!container) return;
        const header = container.querySelector('.dropdown-header');
        header.addEventListener('click', (e) => {
            e.stopPropagation();
            const isOpen = container.classList.contains('open');
            document.querySelectorAll('.dropdown-container').forEach(d => d.classList.remove('open'));
            if (!isOpen) container.classList.add('open');
        });
    });

    const updateFilters = () => {
        const selectedThemes = Array.from(themeContainer.querySelectorAll('input:checked')).map(cb => cb.value);
        const selectedStages = Array.from(stageContainer.querySelectorAll('input:checked')).map(cb => cb.value);
        const selectedTags = Array.from(tagContainer.querySelectorAll('input:checked')).map(cb => cb.value);
        const themeSummary = document.getElementById(`mobileCoreFilterSummaryCopy`);
        const stageSummary = document.getElementById(`mobileStageFilterSummaryCopy`);
        const tagSummary = document.getElementById(`mobileTagFilterSummaryCopy`);
        if (themeSummary) themeSummary.innerText = selectedThemes.length ? `${selectedThemes.length} Selected` : 'All';
        if (stageSummary) stageSummary.innerText = selectedStages.length ? `${selectedStages.length} Selected` : 'All';
        if (tagSummary) tagSummary.innerText = selectedTags.length ? `${selectedTags.length} Selected` : 'All';
        const sourceTasks = allTasks;
        const filtered = sourceTasks.filter(t => {
            if (selectedThemes.length && !selectedThemes.includes(t.core_theme)) return false;
            if (selectedStages.length && !selectedStages.includes(t.stage)) return false;
            if (selectedTags.length && !selectedTags.includes(t.subcategory)) return false;
            return true;
        });
        renderMobileTasksInSheet('Copy', filtered);
        const tasksContainer = document.getElementById('mobileTasksContainerCopy');
        if (tasksContainer) attachTaskEventListeners(tasksContainer);
    };

    themeContainer.querySelectorAll('input').forEach(cb => cb.addEventListener('change', updateFilters));
    stageContainer.querySelectorAll('input').forEach(cb => cb.addEventListener('change', updateFilters));
    tagContainer.querySelectorAll('input').forEach(cb => cb.addEventListener('change', updateFilters));
}

// ======================== MOBILE MISSIONS BOTTOM SHEET (exact copy of desktop daily tasks) ========================
async function openMissionsModal() {
    // Ensure we have tasks to show
    if ((!allTasksWithCompleted || allTasksWithCompleted.length === 0) && (!allTasks || allTasks.length === 0)) {
        console.error('No tasks loaded');
        showToast('Tasks not loaded yet. Please refresh.', 'error');
        return;
    }

    // Use allTasksWithCompleted for filter options (it contains all possible tasks)
    const sourceForFilters = allTasksWithCompleted.length ? allTasksWithCompleted : allTasks;

    console.log('Source for filters:', sourceForFilters);

    const uniqueThemes = [...new Set(sourceForFilters.map(t => t.core_theme).filter(Boolean))];
    const uniqueStages = [...new Set(sourceForFilters.map(t => t.stage).filter(Boolean))];
    const uniqueTags = [...new Set(sourceForFilters.map(t => t.subcategory).filter(Boolean))];

    const contentHtml = `
        <div class="filter-row mobile-sheet-filters" style="margin-bottom: 16px;">
            <div class="dropdown-container" id="mobileCoreFilterDropdown">
                <span class="filter-label">Core Theme:</span>
                <div class="dropdown-header"><span id="mobileCoreFilterSummary">Themes</span> <i class="fas fa-chevron-down"></i></div>
                <div class="dropdown-list scroll-list" id="mobileCoreFilterList"></div>
            </div>
            <div class="dropdown-container" id="mobileStageFilterDropdown">
                <span class="filter-label">Stage:</span>
                <div class="dropdown-header"><span id="mobileStageFilterSummary">Stages</span> <i class="fas fa-chevron-down"></i></div>
                <div class="dropdown-list scroll-list" id="mobileStageFilterList"></div>
            </div>
            <div class="dropdown-container" id="mobileTagFilterDropdown">
                <span class="filter-label">Subcategory:</span>
                <div class="dropdown-header"><span id="mobileTagFilterSummary">Tags</span> <i class="fas fa-chevron-down"></i></div>
                <div class="dropdown-list scroll-list" id="mobileTagFilterList"></div>
            </div>
        </div>
        <div class="progressWrap" style="margin: 12px 0;">
            <progress id="mobileProgressBar" value="0" max="100" style="width: 100%; height: 14px;"></progress>
            <div style="text-align: right; margin-top: 8px;"><span id="mobileProgressPct" class="tiny bold">0%</span></div>
        </div>
        <div id="mobileTasksContainer" class="tasks"></div>
    `;

    const sheet = showBottomSheet('Daily Tasks', contentHtml);

    setTimeout(() => {
        const sheetContent = sheet.querySelector('.bottom-sheet-content');

        // Setup dropdown toggles (scoped to this bottom sheet only)
        const setupDropdown = (id) => {
            const container = document.getElementById(id);
            if (!container) return;
            const header = container.querySelector('.dropdown-header');
            if (header) {
                header.onclick = (e) => {
                    e.stopPropagation();
                    const isOpen = container.classList.contains('open');
                    sheetContent?.querySelectorAll('.dropdown-container').forEach(d => d.classList.remove('open'));
                    if (!isOpen) container.classList.add('open');
                };
            }
        };
        setupDropdown('mobileCoreFilterDropdown');
        setupDropdown('mobileStageFilterDropdown');
        setupDropdown('mobileTagFilterDropdown');

        const closeSheetDropdowns = (e) => {
            if (e.target.closest('.dropdown-container')) return;
            sheetContent?.querySelectorAll('.dropdown-container').forEach(d => d.classList.remove('open'));
        };
        sheetContent?.addEventListener('click', closeSheetDropdowns);
        sheet.addEventListener('click', closeSheetDropdowns);

        // Populate filter checkboxes
        const themeList = document.getElementById('mobileCoreFilterList');
        const stageList = document.getElementById('mobileStageFilterList');
        const tagList = document.getElementById('mobileTagFilterList');

        if (themeList) {
            themeList.innerHTML = uniqueThemes.map(val => buildFilterOptionHtml(val)).join('');
        }
        if (stageList) {
            stageList.innerHTML = uniqueStages.map(val => buildFilterOptionHtml(val)).join('');
        }
        if (tagList) {
            tagList.innerHTML = uniqueTags.map(val => buildFilterOptionHtml(val)).join('');
        }

        // Helper: get selected filters
        function getSelectedFilters() {
            const themes = Array.from(document.querySelectorAll('#mobileCoreFilterList input:checked')).map(cb => cb.value);
            const stages = Array.from(document.querySelectorAll('#mobileStageFilterList input:checked')).map(cb => cb.value);
            const tags = Array.from(document.querySelectorAll('#mobileTagFilterList input:checked')).map(cb => cb.value);
            return { themes, stages, tags };
        }

        // Render tasks (unlocked first)
        function renderMobileTasks() {
            const container = document.getElementById('mobileTasksContainer');
            if (!container) return;
            const { themes, stages, tags } = getSelectedFilters();
            let filtered = [...allTasks];
            if (themes.length) filtered = filtered.filter(t => themes.includes(t.core_theme));
            if (stages.length) filtered = filtered.filter(t => stages.includes(t.stage));
            if (tags.length) filtered = filtered.filter(t => tags.includes(t.subcategory));

            // Sort: unlocked first
            filtered.sort((a, b) => {
                if (a.is_unlocked === b.is_unlocked) return 0;
                return a.is_unlocked ? -1 : 1;
            });

            if (filtered.length === 0) {
                container.innerHTML = '<p class="tiny muted" style="padding:20px;">No missions available with current filters.</p>';
                return;
            }
            container.innerHTML = '';
            filtered.forEach(task => {
                const taskCard = createTaskCard(task);
                container.appendChild(taskCard);
            });
            attachTaskEventListeners(container);
        }

        // Update progress bar
        function updateMobileProgress() {
            const { themes, stages, tags } = getSelectedFilters();
            let filteredAll = [...allTasksWithCompleted];
            if (themes.length) filteredAll = filteredAll.filter(t => themes.includes(t.core_theme));
            if (stages.length) filteredAll = filteredAll.filter(t => stages.includes(t.stage));
            if (tags.length) filteredAll = filteredAll.filter(t => tags.includes(t.subcategory));
            const completedSet = showingExperienced ? completedExperienced : completedNovice;
            const scopeAll = filteredAll;
            const total = scopeAll.length;
            const completed = scopeAll.filter(t => completedSet.has(t.id)).length;
            const pct = total ? Math.min(Math.round((completed / total) * 100), 100) : 0;
            const progressBar = document.getElementById('mobileProgressBar');
            const progressPct = document.getElementById('mobileProgressPct');
            if (progressBar) progressBar.value = pct;
            if (progressPct) progressPct.innerText = `${pct}% (${completed}/${total})`;
        }

        // Update filter summary text
        function updateFilterSummaries() {
            const themeCount = document.querySelectorAll('#mobileCoreFilterList input:checked').length;
            const stageCount = document.querySelectorAll('#mobileStageFilterList input:checked').length;
            const tagCount = document.querySelectorAll('#mobileTagFilterList input:checked').length;
            const themeSummary = document.getElementById('mobileCoreFilterSummary');
            const stageSummary = document.getElementById('mobileStageFilterSummary');
            const tagSummary = document.getElementById('mobileTagFilterSummary');
            if (themeSummary) themeSummary.innerText = themeCount ? `${themeCount} Selected` : 'Themes';
            if (stageSummary) stageSummary.innerText = stageCount ? `${stageCount} Selected` : 'Stages';
            if (tagSummary) tagSummary.innerText = tagCount ? `${tagCount} Selected` : 'Tags';
        }

        // Attach filter change listeners
        const allCheckboxes = document.querySelectorAll('#mobileCoreFilterList input, #mobileStageFilterList input, #mobileTagFilterList input');
        allCheckboxes.forEach(cb => {
            cb.addEventListener('change', () => {
                renderMobileTasks();
                updateMobileProgress();
                updateFilterSummaries();
            });
        });

        // Initial render
        renderMobileTasks();
        updateMobileProgress();
        updateFilterSummaries();

        // Store refresh function for task completion
        window.refreshMobileSheet = () => {
            renderMobileTasks();
            updateMobileProgress();
            updateFilterSummaries();
        };
        window._mobileSheetOpen = true;

        // Cleanup on close
        const closeSheet = () => {
            window._mobileSheetOpen = false;
            window.refreshMobileSheet = null;
        };
        const closeBtn = sheet.querySelector('.bottom-sheet-close');
        if (closeBtn) {
            const originalClick = closeBtn.onclick;
            closeBtn.onclick = () => {
                closeSheet();
                if (originalClick) originalClick();
                // pop this sheet off the stack (never a bare remove: the exit
                // animation and the stack bookkeeping live in closeBottomSheet)
                closeBottomSheet(sheet);
            };
        }
        sheet.addEventListener('click', (e) => {
            if (e.target === sheet) closeSheet();
        });
    }, 100);
}
// ======================== MODALS ========================
async function loadAchievementsModal() {
    if (!document.getElementById('achievementModalStyles')) {
        const styleEl = document.createElement('style');
        styleEl.id = 'achievementModalStyles';
        styleEl.textContent = `
            .achievement-modal-overlay {
                position: fixed !important;
                top: 0 !important;
                left: 0 !important;
                right: 0 !important;
                bottom: 0 !important;
                width: 100% !important;
                height: 100% !important;
                background: rgba(255,255,255,0.75);
                backdrop-filter: blur(15px);
                -webkit-backdrop-filter: blur(15px);
                display: none;
                justify-content: center;
                align-items: center;
                z-index: 99999 !important;
                opacity: 0;
                transition: opacity 0.3s ease;
                padding: 20px;
                box-sizing: border-box;
            }
            .achievement-modal-overlay.active {
                display: flex !important;
                opacity: 1;
            }
            .achievement-modal-content {
                background: white;
                border-radius: 40px;
                padding: 40px 36px 44px;
                max-width: 420px;
                width: 100%;
                text-align: center;
                border: 1px solid rgba(245,158,11,0.2);
                box-shadow: 0 40px 100px rgba(0,0,0,0.12);
                transform: scale(0.85);
                transition: transform 0.4s cubic-bezier(0.34,1.56,0.64,1);
                position: relative;
                display: flex;
                flex-direction: column;
                align-items: center;
                max-height: 90vh;
                overflow-y: auto;
            }
            .achievement-modal-overlay.active .achievement-modal-content {
                transform: scale(1);
            }
            .achievement-modal-close {
                position: absolute;
                top: 18px;
                right: 20px;
                background: #f3f4f6;
                border: none;
                border-radius: 50%;
                width: 44px;
                height: 44px;
                font-size: 14px;
                color: #6b7280;
                cursor: pointer;
                display: flex;
                align-items: center;
                justify-content: center;
                transition: background 0.2s;
                flex-shrink: 0;
            }
            .achievement-modal-close:hover { background: #e5e7eb; color: #374151; }
            .modal-img-wrap {
                width: 100%;
                display: flex;
                justify-content: center;
                align-items: center;
                margin-bottom: 24px;
            }
            .modal-img-animated {
                width: 180px;
                height: 180px;
                border-radius: 50%;
                border: 6px solid white;
                box-shadow: 0 20px 40px rgba(245,158,11,0.4), 0 0 20px rgba(251,191,36,0.3);
                object-fit: cover;
                animation: achieveFloat 4s ease-in-out infinite;
            }
            @keyframes achieveFloat {
                0%, 100% { transform: translateY(0) rotate(0deg); }
                50% { transform: translateY(-16px) rotate(3deg); }
            }
            .modal-text-block { width: 100%; text-align: center; }
            @media (max-width: 480px) {
                .achievement-modal-content {
                    border-radius: 28px;
                    padding: 32px 24px 36px;
                }
                .modal-img-animated { width: 140px; height: 140px; }
            }
        `;
        document.head.appendChild(styleEl);
    }

    Loader.show("Loading achievements...");
    let html;
    try {
        html = await generateAchievementsHtml();
    } finally {
        Loader.hide();
    }

    const existingModal = document.getElementById('achievementModal');
    if (existingModal) existingModal.remove();

    const modalEl = document.createElement('div');
    modalEl.id = 'achievementModal';
    modalEl.className = 'achievement-modal-overlay';
    modalEl.innerHTML = `
        <div class="achievement-modal-content" onclick="event.stopPropagation()">
            <button class="achievement-modal-close" onclick="closeAchievementModal()">&#x2715;</button>
            <div class="modal-img-wrap">
                <img id="achievementModalImg" src="" class="modal-img-animated" alt="">
            </div>
            <div class="modal-text-block">
                <span id="achievementModalSub" class="text-[10px] font-black text-amber-600 uppercase tracking-widest bg-amber-50 px-4 py-1.5 rounded-full border border-amber-200">Milestone</span>
                <h2 id="achievementModalTitle" class="text-3xl font-black text-gray-900 mt-5 italic uppercase tracking-tight">Title</h2>
                <p id="achievementModalDesc" class="text-gray-500 mt-4 leading-relaxed text-sm px-2">Achievement description.</p>
            </div>
        </div>
    `;
    modalEl.addEventListener('click', (e) => {
        if (e.target === modalEl) closeAchievementModal();
    });
    document.body.appendChild(modalEl);

    const sheet = showBottomSheet('Achievements', html);

    setTimeout(() => {
        attachAchievement3DEffects(sheet.querySelector('.bottom-sheet-content'));
    }, 100);

    const cleanup = () => {
        const m = document.getElementById('achievementModal');
        if (m) m.remove();
    };
    const closeBtn = sheet.querySelector('.bottom-sheet-close');
    if (closeBtn) closeBtn.addEventListener('click', cleanup);
    sheet.addEventListener('click', (e) => {
        if (e.target === sheet) cleanup();
    });
}

async function openCompletedModal() {
    Loader.show("Loading completed tasks...");
    let html;
    try {
        html = await generateCompletedTasksHtml();
    } finally {
        Loader.hide();
    }
    const overlay = showBottomSheet('Completed Tasks', html);
    wireCompletedList(overlay);
}

async function generateCompletedTasksHtml() {
    const { data: completed, error } = await supabase
        .from('user_tasks')
        .select(`task_id, version, points_awarded, completed_at, tasks ( task_title, novice_description, experienced_description, stage, theme_id )`)
        .eq('user_id', userProfile.id)
        .order('completed_at', { ascending: false });
    if (error || !completed || completed.length === 0) {
        return '<p class="tiny muted">No completed tasks yet.</p>';
    }

    const themeIds = [...new Set(completed.map(item => item.tasks.theme_id))];
    let themeIconMap = {};
    if (themeIds.length) {
        const { data: themes, error: themeError } = await supabase
            .from('themes')
            .select('theme_id, visual_symbol_icon_idea')
            .in('theme_id', themeIds);
        if (!themeError && themes) {
            themes.forEach(t => { themeIconMap[t.theme_id] = t.visual_symbol_icon_idea; });
        }
    }

    const escapeHtml = (str) => {
        if (!str) return '';
        return String(str).replace(/[&<>"']/g, m => {
            if (m === '&') return '&amp;';
            if (m === '<') return '&lt;';
            if (m === '>') return '&gt;';
            if (m === '"') return '&quot;';
            return '&#39;';
        });
    };

    let itemsHtml = '';
    for (const item of completed) {
        const task = item.tasks;
        const version = item.version;
        const points = item.points_awarded;
        const date = new Date(item.completed_at).toLocaleDateString();
        const description = version === 'novice' ? task.novice_description : task.experienced_description;
        const iconUrl = themeIconMap[task.theme_id];
        const iconHtml = iconUrl
            ? `<div class="theme-icon-container">
                 <img src="${iconUrl}" alt="${task.task_title}">
               </div>`
            : `<div class="theme-icon-container no-image"><i class="fas fa-clipboard-list"></i></div>`;

        itemsHtml += `
            <div class="completed-task-card">
                <div class="theme-card-content">
                    ${iconHtml}
                    <div class="theme-text">
                        <div class="flex justify-between items-start">
                            <h4 class="theme-name">${escapeHtml(task.task_title)}</h4>
                            <span class="text-xs text-stone-500">${date}</span>
                        </div>
                        <div class="text-sm text-stone-500 mt-1">${version === 'novice' ? '<i class="fas fa-square" style="color:#2563eb"></i> Novice' : '<i class="fas fa-square" style="color:#ea580c"></i> Experienced'}</div>
                        <div class="text-sm text-stone-600 mt-1">${escapeHtml(description || '')}</div>
                        <div class="mt-2 font-bold text-emerald-600">+${points} pts</div>
                    </div>
                    <div class="completed-eye-cell">
                        <button type="button" class="eye-btn" data-detail-task="${item.task_id}" data-detail-version="${version}" title="See the full task" aria-label="See the full task: ${escapeHtml(task.task_title)}"><i class="fas fa-eye"></i></button>
                    </div>
                </div>
            </div>
        `;
    }

    const modalHtml = `
        <style>
    .completed-task-card {
        margin-bottom: 12px;
    }
    .theme-card-content {
        display: flex;
        align-items: center;
        background: #fffdf5;
        border: 2px solid #eeebe0;
        border-radius: 20px;
        overflow: hidden;
    }
    .theme-icon-container {
        width: 80px;
        height: 80px;
        flex-shrink: 0;
        background: transparent;
        display: flex;
        align-items: center;
        justify-content: center;
        overflow: hidden;
    }
    .theme-icon-container img {
        width: 100%;
        height: 100%;
        object-fit: cover;
    }
    .theme-icon-container.no-image {
        font-size: 2rem;
        background: transparent;
    }
    .theme-text {
        flex: 1;
        min-width: 0;
        padding: 12px 16px;
        display: flex;
        flex-direction: column;
        justify-content: center;
    }
    .theme-name {
        margin: 0 0 2px 0;
        font-weight: 800;
        color: #5c3d2e;
        font-size: 1rem;
    }
    .flex {
        display: flex;
    }
    .justify-between {
        justify-content: space-between;
    }
    .items-start {
        align-items: flex-start;
    }
    .text-xs {
        font-size: 0.75rem;
    }
    .text-sm {
        font-size: 0.875rem;
    }
    .text-stone-500 {
        color: #78716c;
    }
    .text-stone-600 {
        color: #57534e;
    }
    .mt-1 {
        margin-top: 0.25rem;
    }
    .font-bold {
        font-weight: 700;
    }
    .text-emerald-600 {
        color: #059669;
    }
    .completed-eye-cell {
        display: flex;
        align-items: center;
        padding-right: 14px;
        flex-shrink: 0;
    }
    .eye-btn {
        width: 44px;
        height: 44px;
        border: 0;
        border-radius: 50%;
        background: #f1ede1;
        color: #5c3d2e;
        font-size: 1rem;
        display: flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
    }
    .eye-btn:hover,
    .eye-btn:focus-visible {
        background: #d9c7a5;
        color: #3d2a1f;
        outline: 2px solid #5c3d2e;
        outline-offset: 2px;
    }
</style>
        <div class="scrollable-list">
            ${itemsHtml}
        </div>
    `;

    return modalHtml;
}

// ======================== COMPLETED TASK DETAIL (eye icon) ========================
// The Completed Tasks list only shows a summary row. The eye button opens the very
// same card the Daily Tasks feed renders for this task - including the like/dislike
// controls and the comment thread, all still editable (they hit the same
// task_feedback / task_comments tables).
let detailTaskId = null;
let detailVersion = 'novice';

function findTaskForDetail(taskId) {
    const wanted = String(taskId);
    const pools = [allTasksWithCompleted, allTasks];
    for (const pool of pools) {
        if (!Array.isArray(pool)) continue;
        const hit = pool.find(t => t && String(t.id) === wanted);
        if (hit) return hit;
    }
    return null;
}

function renderCompletedDetailHtml(task) {
    const prev = showingExperienced;
    showingExperienced = detailVersion === 'experienced';
    let cardHtml = '';
    try {
        const card = createTaskCard({ ...task, is_unlocked: true });
        // the feed may already render this task: never duplicate the DOM id
        card.removeAttribute('id');
        cardHtml = card.outerHTML;
    } finally {
        showingExperienced = prev;
    }
    return `
      <style>
        .detail-task-wrap{margin-top:4px}
        .detail-task-wrap .post.task-item{margin:0 0 10px 0}
      </style>
      <div class="detail-task-wrap">${cardHtml}</div>
      <p class="tiny muted">Like / dislike and your comments stay editable here.</p>
    `;
}

function refreshCompletedDetail() {
    if (!detailTaskId) return;
    const overlay = topBottomSheet();
    if (!overlay) return;
    const box = overlay.querySelector('.bottom-sheet-content');
    const task = findTaskForDetail(detailTaskId);
    if (!box || !task) return;
    box.innerHTML = renderCompletedDetailHtml(task);
    wireCompletedDetail(overlay);
}

function wireCompletedDetail(overlay) {
    const box = overlay ? overlay.querySelector('.bottom-sheet-content') : null;
    if (!box) return;
    attachTaskEventListeners(box);
    // re-bind the shared handlers so this sheet re-renders itself after a change
    box.querySelectorAll('.react-btn:not([disabled])').forEach(el => {
        el.onclick = async (e) => {
            e.preventDefault();
            el.disabled = true;
            try { await handleReact(el); } finally { el.disabled = false; }
            refreshCompletedDetail();
            if (typeof refreshTasks === 'function') refreshTasks();
        };
    });
    box.querySelectorAll('.comment-btn:not([disabled])').forEach(el => {
        el.onclick = async (e) => {
            e.preventDefault();
            await handleComment(el);
            refreshCompletedDetail();
        };
    });
    // Comment Edit / Save / Cancel / Delete are inline onclick handlers on the page's
    // own functions. Intercept them in the CAPTURE phase (so the inline handler never
    // runs), await the DB round-trip, then re-render this sheet. Delegation is needed
    // because the Save/Cancel buttons only exist after Edit swaps the row: a per-button
    // pass at wire time would never see them. startEditComment is left alone - it swaps
    // the row for its inline input in place.
    if (!box.dataset.cactDelegated) {
        box.dataset.cactDelegated = '1';
        box.addEventListener('click', async (e) => {
            const b = e.target && e.target.closest ? e.target.closest('button[onclick]') : null;
            if (!b || !box.contains(b)) return;
            const oc = b.getAttribute('onclick') || '';
            const m = oc.match(/^window\.(saveEditComment|deleteComment|cancelEditComment)\('([^']+)'\)/);
            if (!m) return;
            e.preventDefault();
            e.stopImmediatePropagation();
            try { await window[m[1]](m[2]); } catch (err) { console.warn('[completed-detail] ' + m[1] + ' failed', err); }
            refreshCompletedDetail();
        }, true);
    }
}

function wireCompletedList(overlay) {
    const box = overlay ? overlay.querySelector('.bottom-sheet-content') : null;
    if (!box) return;
    box.querySelectorAll('.eye-btn[data-detail-task]').forEach(btn => {
        btn.onclick = (e) => {
            e.preventDefault();
            openCompletedTaskDetail(btn.dataset.detailTask, btn.dataset.detailVersion);
        };
    });
}

async function openCompletedTaskDetail(taskId, version) {
    let task = findTaskForDetail(taskId);
    if (!task) {
        Loader.show("Loading task...");
        try {
            const { data, error } = await supabase.from('tasks').select('*').eq('id', taskId).limit(1);
            if (!error && data && data.length) {
                task = { ...data[0], subcategory: data[0].subcategory ?? data[0].category ?? null };
            }
        } finally {
            Loader.hide();
        }
    }
    if (!task) { showToast('Could not load that task.', 'error'); return; }
    detailTaskId = String(taskId);
    detailVersion = version === 'experienced' ? 'experienced' : 'novice';
    // tell the card it is done (a completed task is stored with is_unlocked=false,
    // which would otherwise render it as a locked card)
    (detailVersion === 'experienced' ? completedExperienced : completedNovice).add(task.id);
    const overlay = showBottomSheet(escapeHtml(task.task_title || 'Task details'), renderCompletedDetailHtml(task));
    wireCompletedDetail(overlay);
}

/* Reflection rows for this session: id -> the submitted answers plus the task
   title. Filled while the Tasks Reflection sheet is built, so the detail view
   and the edit form can show the stored answers without another round trip. */
let submittedReflections = new Map();

async function openPendingSigmaModal() {
    Loader.show("Loading reflections...");
    let sheet;
    try {
        const html = await generatePendingSigmaHtml();
        sheet = showBottomSheet('Tasks Reflection', html);
    } finally {
        Loader.hide();
    }
    wireReflectionTabs(sheet);
}

async function generatePendingSigmaHtml() {
    const pendingTaskIds = Array.from(completedNovice).concat(Array.from(completedExperienced))
        .filter(id => !loggedSigmaTasks.has(id));
    const { data: tasks, error } = pendingTaskIds.length
        ? await supabase
            .from('tasks')
            .select('id, task_title, novice_description, experienced_description, stage, theme_id')
            .in('id', pendingTaskIds)
        : { data: [], error: null };
    if (error) return '<p class="tiny muted">Error loading tasks.</p>';

    // Submitted reflections: the member's own rows, newest first. RLS scopes the
    // query to the signed-in member, so this is their history and nobody else's.
    const uid = userProfile ? userProfile.id : null;
    let logsQuery = supabase
        .from('task_sigma_logs')
        .select('id, task_id, define, measure, analysis, improve, control, created_at')
        .order('created_at', { ascending: false });
    if (uid) logsQuery = logsQuery.eq('user_id', uid);
    const { data: logs, error: logsError } = await logsQuery;
    const submittedLogs = logsError ? [] : (logs || []);

    const submittedTaskIds = [...new Set(submittedLogs.map(l => l.task_id).filter(Boolean))];
    let submittedTasks = [];
    if (submittedTaskIds.length) {
        const { data: st, error: stError } = await supabase
            .from('tasks')
            .select('id, task_title')
            .in('id', submittedTaskIds);
        if (!stError && st) submittedTasks = st;
    }
    const titleMap = {};
    (tasks || []).forEach(t => { titleMap[t.id] = t.task_title; });
    submittedTasks.forEach(t => { titleMap[t.id] = t.task_title; });

    submittedReflections = new Map();
    submittedLogs.forEach(l => {
        submittedReflections.set(l.id, Object.assign({}, l, {
            task_id: l.task_id,
            task_title: titleMap[l.task_id] || 'Task'
        }));
    });

    const themeIds = [...new Set(tasks.map(t => t.theme_id))];
    let themeIconMap = {};
    if (themeIds.length) {
        const { data: themes, error: themeError } = await supabase
            .from('themes')
            .select('theme_id, visual_symbol_icon_idea')
            .in('theme_id', themeIds);
        if (!themeError && themes) {
            themes.forEach(t => { themeIconMap[t.theme_id] = t.visual_symbol_icon_idea; });
        }
    }

    const escapeHtml = (str) => {
        if (!str) return '';
        return String(str).replace(/[&<>"']/g, m => {
            if (m === '&') return '&amp;';
            if (m === '<') return '&lt;';
            if (m === '>') return '&gt;';
            if (m === '"') return '&quot;';
            return '&#39;';
        });
    };

    let itemsHtml = '';
    for (const task of tasks) {
        const version = completedNovice.has(task.id) ? 'novice' : 'experienced';
        const description = version === 'novice' ? task.novice_description : task.experienced_description;
        const iconUrl = themeIconMap[task.theme_id];
        const iconHtml = iconUrl
            ? `<div class="theme-icon-container">
                 <img src="${iconUrl}" alt="${task.task_title}">
               </div>`
            : `<div class="theme-icon-container no-image"><i class="fas fa-pen"></i></div>`;

        itemsHtml += `
            <div class="pending-sigma-card">
                <div class="theme-card-content">
                    ${iconHtml}
                    <div class="theme-text">
                        <h4 class="theme-name">${escapeHtml(task.task_title)}</h4>
                        <div class="text-sm text-stone-500 mt-1">${version === 'novice' ? '<i class="fas fa-square" style="color:#2563eb"></i> Novice' : '<i class="fas fa-square" style="color:#ea580c"></i> Experienced'}</div>
                        <div class="text-sm text-stone-600 mt-1">${escapeHtml(description || '')}</div>
                    </div>
                    <div class="self-center mr-4">
                        <button class="reflect-btn btn tiny" onclick="openTaskSigmaModal('${task.id}', '${escapeHtml(task.task_title)}')">Reflect</button>
                    </div>
                </div>
            </div>
        `;
    }

    let submittedHtml = '';
    for (const log of submittedLogs) {
        const meta = submittedReflections.get(log.id) || {};
        const when = log.created_at
            ? new Date(log.created_at).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
            : '';
        submittedHtml += `
            <div class="pending-sigma-card">
                <div class="theme-card-content">
                    <div class="theme-text">
                        <h4 class="theme-name">${escapeHtml(meta.task_title)}</h4>
                        <div class="text-sm text-stone-500 mt-1">Submitted ${when}</div>
                    </div>
                    <div class="self-center mr-4 refl-actions">
                        <button type="button" class="eye-btn" data-refl-view="${log.id}" title="View the full reflection" aria-label="View the full reflection: ${escapeHtml(meta.task_title)}"><i class="fas fa-eye"></i></button>
                        <button type="button" class="reflect-btn btn tiny" data-refl-edit="${log.id}">Edit</button>
                    </div>
                </div>
            </div>
        `;
    }
    if (!submittedHtml) {
        submittedHtml = '<p class="tiny muted">No submitted reflections yet.</p>';
    }

    const modalHtml = `
      <style>
    .pending-sigma-card {
        margin-bottom: 12px;
    }
    .theme-card-content {
        display: flex;
        align-items: center;
        background: #fffdf5;
        border: 2px solid #eeebe0;
        border-radius: 20px;
        overflow: hidden;
    }
    .theme-icon-container {
        width: 80px;
        height: 80px;
        flex-shrink: 0;
        background: transparent;
        display: flex;
        align-items: center;
        justify-content: center;
        overflow: hidden;
    }
    .theme-icon-container img {
        width: 100%;
        height: 100%;
        object-fit: cover;
    }
    .theme-icon-container.no-image {
        font-size: 2rem;
        background: transparent;
    }
    .theme-text {
        flex: 1;
        min-width: 0;
        padding: 12px 16px;
        display: flex;
        flex-direction: column;
        justify-content: center;
    }
    .theme-name {
        margin: 0 0 2px 0;
        font-weight: 800;
        color: #5c3d2e;
        font-size: 1rem;
    }
    .text-sm {
        font-size: 0.875rem;
    }
    .text-stone-500 {
        color: #78716c;
    }
    .text-stone-600 {
        color: #57534e;
    }
    .mt-1 {
        margin-top: 0.25rem;
    }
    .reflect-btn {
        background: var(--cta);
        color: #000;
        border: none;
        padding: 6px 12px;
        border-radius: 12px;
        font-weight: 600;
        cursor: pointer;
        transition: all 0.2s;
        white-space: nowrap;
    }
    .reflect-btn:hover {
        transform: scale(1.02);
        background: #f59e0b;
    }
    .refl-tabs {
        display: flex;
        gap: 8px;
        margin-bottom: 12px;
    }
    .refl-tab {
        flex: 1;
        padding: 10px 12px;
        border-radius: 14px;
        border: 2px solid #eeebe0;
        background: #fffdf5;
        color: #5c3d2e;
        font-weight: 700;
        font-size: 0.875rem;
        cursor: pointer;
        transition: all 0.2s;
    }
    .refl-tab.active {
        background: var(--cta);
        border-color: var(--cta);
        color: #000;
    }
    .refl-actions {
        display: flex;
        gap: 8px;
        align-items: center;
    }
    .eye-btn {
        width: 44px;
        height: 44px;
        flex-shrink: 0;
        border: none;
        border-radius: 50%;
        background: #f1ede1;
        color: #5c3d2e;
        font-size: 1rem;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        transition: all 0.2s;
    }
    .eye-btn:hover,
    .eye-btn:focus {
        background: #e5dfcd;
        transform: scale(1.05);
    }
</style>
        <div class="refl-tabs" id="reflTabs">
            <button type="button" class="refl-tab active" data-refl-tab="pending">Pending (${pendingTaskIds.length})</button>
            <button type="button" class="refl-tab" data-refl-tab="submitted">Submitted (${submittedLogs.length})</button>
        </div>
        <div class="scrollable-list" id="reflPanePending">
            ${itemsHtml || '<p class="tiny muted">No pending reflections.</p>'}
        </div>
        <div class="scrollable-list" id="reflPaneSubmitted" hidden>
            ${submittedHtml}
        </div>
    `;

    return modalHtml;
}

/* Tabs, view and edit wiring for the Tasks Reflection sheet. The sheet body is
   rebuilt after a save, so this runs again on the fresh content. */
function wireReflectionTabs(root) {
    const scope = root || document;
    const tabs = Array.from(scope.querySelectorAll('#reflTabs .refl-tab'));
    tabs.forEach(tab => {
        tab.onclick = () => {
            tabs.forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            const want = tab.dataset.reflTab;
            const pendingPane = scope.querySelector('#reflPanePending');
            const submittedPane = scope.querySelector('#reflPaneSubmitted');
            if (pendingPane) pendingPane.hidden = want !== 'pending';
            if (submittedPane) submittedPane.hidden = want !== 'submitted';
        };
    });

    scope.querySelectorAll('[data-refl-view]').forEach(btn => {
        btn.onclick = (e) => { e.preventDefault(); openReflectionDetail(btn.dataset.reflView); };
    });

    scope.querySelectorAll('[data-refl-edit]').forEach(btn => {
        btn.onclick = (e) => {
            e.preventDefault();
            const meta = submittedReflections.get(btn.dataset.reflEdit);
            if (!meta) return;
            openTaskSigmaModal(meta.task_id, meta.task_title, meta.id);
        };
    });
}

/* Read-only view of a submitted reflection, with the same eye affordance the
   completed-task list uses. Editing hands off to the reflection form. */
function openReflectionDetail(logId) {
    const meta = submittedReflections.get(logId);
    if (!meta) {
        showToast('Reflection not found', 'error');
        return;
    }
    const when = meta.created_at
        ? new Date(meta.created_at).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
        : '';
    const answers = [
        ['What did you do?', meta.define],
        ['What did you learn?', meta.measure],
        ['What impact did you have?', meta.analysis],
        ['Proof of completion', meta.improve],
        ['What would you do differently?', meta.control]
    ];
    const bodyHtml = answers.map(([label, value]) => `
        <div style="margin-bottom:14px;">
            <div class="tiny bold" style="margin-bottom:4px;">${label}</div>
            <div class="text-sm text-stone-600" style="white-space:pre-wrap;">${value ? escapeHtml(value) : '<span class="muted">Not provided</span>'}</div>
        </div>
    `).join('');

    const html = `
        <div style="margin-bottom:16px;">
            <h4 class="theme-name" style="margin:0 0 2px 0;">${escapeHtml(meta.task_title)}</h4>
            <div class="tiny muted">Submitted ${when}</div>
        </div>
        ${bodyHtml}
        <button type="button" class="btn" id="reflDetailEdit" style="width:100%;">Edit this reflection</button>
    `;

    const sheet = showBottomSheet('Your Reflection', html);
    const editBtn = sheet.querySelector('#reflDetailEdit');
    if (editBtn) {
        editBtn.onclick = () => {
            const closeBtn = sheet.querySelector('.bottom-sheet-close');
            if (closeBtn) closeBtn.click();
            openTaskSigmaModal(meta.task_id, meta.task_title, meta.id);
        };
    }
}

async function openSigmaModal() {
    const formHtml = `
        <form id="sigmaFormBottom">
            <div style="margin-bottom: 16px;">
                <label class="tiny bold" style="display: block; margin-bottom: 8px;">Define (the problem)</label>
                <textarea id="sigmaDefineBottom" rows="2" placeholder="What is the issue?" style="width: 100%;"></textarea>
            </div>
            <div style="margin-bottom: 16px;">
                <label class="tiny bold" style="display: block; margin-bottom: 8px;">Measure (current state)</label>
                <textarea id="sigmaMeasureBottom" rows="2" placeholder="How do you measure it?" style="width: 100%;"></textarea>
            </div>
            <div style="margin-bottom: 16px;">
                <label class="tiny bold" style="display: block; margin-bottom: 8px;">Analyse (root cause)</label>
                <textarea id="sigmaAnalyseBottom" rows="2" placeholder="Why does it happen?" style="width: 100%;"></textarea>
            </div>
            <div style="margin-bottom: 16px;">
                <label class="tiny bold" style="display: block; margin-bottom: 8px;">Improve (proposed solution)</label>
                <textarea id="sigmaImproveBottom" rows="2" placeholder="What can be done?" style="width: 100%;"></textarea>
            </div>
            <div style="margin-bottom: 24px;">
                <label class="tiny bold" style="display: block; margin-bottom: 8px;">Control (how to sustain)</label>
                <textarea id="sigmaControlBottom" rows="2" placeholder="How will you maintain the improvement?" style="width: 100%;"></textarea>
            </div>
            <button type="submit" class="btn btn-success" style="width: 100%;">Submit Log</button>
        </form>
    `;
    const sheet = showBottomSheet('Sigma Improvement Log', formHtml);
    const form = document.getElementById('sigmaFormBottom');
    if (form) {
        form.addEventListener('submit', async (e) => {
            e.preventDefault();
            const define = document.getElementById('sigmaDefineBottom').value.trim();
            const measure = document.getElementById('sigmaMeasureBottom').value.trim();
            const analysis = document.getElementById('sigmaAnalyseBottom').value.trim();
            const improve = document.getElementById('sigmaImproveBottom').value.trim();
            const control = document.getElementById('sigmaControlBottom').value.trim();
            const { error } = await supabase.from('sigma_logs').insert([{
                user_id: userProfile.id,
                define: define || null,
                measure: measure || null,
                analysis: analysis || null,
                improve: improve || null,
                control: control || null
            }]);
            if (error) {
                console.error('Error inserting sigma log:', error);
                showToast('Failed to save log', 'error');
            } else {
                showToast('Sigma log saved!', 'success');
                sheet.querySelector('.bottom-sheet-close').click();
                await checkAndAwardMilestones();
            }
        });
    }
}

async function openTaskSigmaModal(taskId, taskTitle, editLogId) {
    const existing = editLogId ? submittedReflections.get(editLogId) : null;
    const prefill = (v) => (v ? escapeHtml(String(v)) : '');
    const formHtml = `
        <form id="taskSigmaFormBottom">
            <input type="hidden" id="taskSigmaTaskIdBottom" value="${taskId}">
            <div style="margin-bottom: 16px;">
                <label class="tiny bold" style="display: block; margin-bottom: 8px;">What did you do?</label>
                <textarea id="taskSigmaDefineBottom" rows="2" placeholder="Describe the action you took..." style="width: 100%;">${prefill(existing && existing.define)}</textarea>
            </div>
            <div style="margin-bottom: 16px;">
                <label class="tiny bold" style="display: block; margin-bottom: 8px;">What did you learn?</label>
                <textarea id="taskSigmaMeasureBottom" rows="2" placeholder="What insights or lessons did you gain?" style="width: 100%;">${prefill(existing && existing.measure)}</textarea>
            </div>
            <div style="margin-bottom: 16px;">
                <label class="tiny bold" style="display: block; margin-bottom: 8px;">What impact did you have?</label>
                <textarea id="taskSigmaAnalyseBottom" rows="2" placeholder="Describe the results or changes you observed." style="width: 100%;">${prefill(existing && existing.analysis)}</textarea>
            </div>
            <div style="margin-bottom: 16px;">
                <label class="tiny bold" style="display: block; margin-bottom: 8px;">Proof of completion (link or description)</label>
                <textarea id="taskSigmaImproveBottom" rows="2" placeholder="Add a photo link, screenshot, or brief proof." style="width: 100%;">${prefill(existing && existing.improve)}</textarea>
            </div>
            <div style="margin-bottom: 24px;">
                <label class="tiny bold" style="display: block; margin-bottom: 8px;">What would you do differently?</label>
                <textarea id="taskSigmaControlBottom" rows="2" placeholder="How would you improve if you did it again?" style="width: 100%;">${prefill(existing && existing.control)}</textarea>
            </div>
            <button type="submit" class="btn btn-success" style="width: 100%;">${existing ? 'Save Changes' : 'Submit Reflection'}</button>
        </form>
    `;
    const sheet = showBottomSheet(existing ? `Edit reflection: ${taskTitle}` : `Reflect on: ${taskTitle}`, formHtml);
    const form = document.getElementById('taskSigmaFormBottom');
    if (form) {
        form.addEventListener('submit', async (e) => {
            e.preventDefault();
            const taskIdVal = document.getElementById('taskSigmaTaskIdBottom').value;
            const define = document.getElementById('taskSigmaDefineBottom').value.trim();
            const measure = document.getElementById('taskSigmaMeasureBottom').value.trim();
            const analysis = document.getElementById('taskSigmaAnalyseBottom').value.trim();
            const improve = document.getElementById('taskSigmaImproveBottom').value.trim();
            const control = document.getElementById('taskSigmaControlBottom').value.trim();
            const answers = {
                define: define || null,
                measure: measure || null,
                analysis: analysis || null,
                improve: improve || null,
                control: control || null
            };
            const { error } = editLogId
                ? await supabase.from('task_sigma_logs').update(answers).eq('id', editLogId)
                : await supabase.from('task_sigma_logs').insert([Object.assign({
                    user_id: userProfile.id,
                    task_id: taskIdVal
                }, answers)]);
            if (error) {
                console.error('Error saving task sigma log:', error);
                showToast('Failed to save reflection', 'error');
            } else {
                showToast(existing ? 'Reflection updated!' : 'Reflection saved!', 'success');
                if (!existing) loggedSigmaTasks.add(taskIdVal);
                sheet.querySelector('.bottom-sheet-close').click();
                updatePendingSigmaBadge();
                const pendingSheet = topBottomSheet();
                if (pendingSheet && pendingSheet.querySelector('#reflTabs')) {
                    const newHtml = await generatePendingSigmaHtml();
                    pendingSheet.querySelector('.bottom-sheet-content').innerHTML = newHtml;
                    wireReflectionTabs(pendingSheet);
                    if (existing) {
                        const tab = pendingSheet.querySelector('#reflTabs .refl-tab[data-refl-tab="submitted"]');
                        if (tab) tab.click();
                    }
                }
                refreshTasks();
                await checkAndAwardMilestones();
            }
        });
    }
}

// ======================== THEME SELECTOR ========================
async function showThemeSelectorModal() {
    const availableThemeIds = [...new Set(baseTasks.map(t => t.theme_id))];
    if (!availableThemeIds.length) return;

    const { data: themes, error } = await supabase
        .from('themes')
        .select('theme_id, theme_name, purpose, visual_symbol_icon_idea')
        .in('theme_id', availableThemeIds);

    if (error) {
        console.error('Error fetching theme details:', error);
        showToast('Could not load theme details', 'error');
        return;
    }

    const escapeHtml = (str) => {
        if (!str) return '';
        return String(str).replace(/[&<>"']/g, m => {
            if (m === '&') return '&amp;';
            if (m === '<') return '&lt;';
            if (m === '>') return '&gt;';
            if (m === '"') return '&quot;';
            return '&#39;';
        });
    };

    const checkboxesHtml = themes.map(theme => {
        const isChecked = selectedThemes.includes(theme.theme_id);
        const iconHtml = theme.visual_symbol_icon_idea
            ? `<div class="theme-icon-container">
                 <img src="${theme.visual_symbol_icon_idea}" alt="${theme.theme_name}">
               </div>`
            : `<div class="theme-icon-container no-image"><i class="fas fa-seedling"></i></div>`;

        return `
            <label class="theme-selector-card">
                <input type="checkbox" class="theme-checkbox" value="${theme.theme_id}" ${isChecked ? 'checked' : ''}>
                <div class="theme-card-content">
                    ${iconHtml}
                    <div class="theme-text">
                        <h4 class="theme-name">${escapeHtml(theme.theme_name)}</h4>
                        <p class="theme-purpose">${escapeHtml(theme.purpose || 'Discover a new perspective')}</p>
                    </div>
                    <div class="theme-checkmark">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3">
                            <path d="M5 13l4 4L19 7" />
                        </svg>
                    </div>
                </div>
            </label>
        `;
    }).join('');

    const modalHtml = `
        <style>
            .theme-selector-card {
                display: block;
                cursor: pointer;
                margin-bottom: 12px;
                position: relative;
            }
            .theme-checkbox {
                position: absolute;
                opacity: 0;
                width: 0;
                height: 0;
            }
            .theme-card-content {
                display: flex;
                align-items: stretch;
                background: #fffdf5;
                border: 2px solid #eeebe0;
                border-radius: 20px;
                transition: all 0.2s ease;
                overflow: hidden;
            }
            .theme-selector-card:hover .theme-card-content {
                border-color: #fbbf24;
                transform: translateY(-2px);
            }
            .theme-checkbox:checked + .theme-card-content {
                background: #fff9db;
                border-color: #fbbf24;
                box-shadow: 0 4px 15px rgba(217, 119, 6, 0.1);
            }
            .theme-icon-container {
                width: 80px;
                min-height: 80px;
                flex-shrink: 0;
                background: #fdf2f2;
                display: flex;
                align-items: center;
                justify-content: center;
                overflow: hidden;
            }
            .theme-icon-container img {
                width: 100%;
                height: 100%;
                object-fit: cover;
            }
            .theme-icon-container.no-image {
                font-size: 2rem;
                background: #fef9e8;
            }
            .theme-text {
                flex: 1;
                padding: 12px 0 12px 16px;
                display: flex;
                flex-direction: column;
                justify-content: center;
            }
            .theme-name {
                margin: 0 0 2px 0;
                font-weight: 800;
                color: #5c3d2e;
                font-size: 1rem;
            }
            .theme-purpose {
                margin: 0;
                font-size: 0.75rem;
                color: #8d6e63;
                line-height: 1.3;
            }
            .theme-checkmark {
                margin: auto 16px;
                width: 24px;
                height: 24px;
                border-radius: 8px;
                border: 2px solid #d1d5db;
                display: flex;
                align-items: center;
                justify-content: center;
                background: white;
                transition: all 0.2s;
            }
            .theme-checkbox:checked + .theme-card-content .theme-checkmark {
                background: #fbbf24;
                border-color: #fbbf24;
                transform: rotate(360deg);
            }
            .theme-checkbox:checked + .theme-card-content .theme-checkmark svg {
                opacity: 1;
                color: white;
            }
            .theme-checkmark svg {
                width: 14px;
                height: 14px;
                opacity: 0;
                transition: opacity 0.1s;
            }
            .btn-nectar-save {
                flex: 1;
                background: white;
                border: 2px solid #fbbf24;
                color: #b45309;
                font-weight: 800;
                text-transform: uppercase;
                letter-spacing: 1px;
                padding: 14px;
                border-radius: 16px;
                transition: all 0.2s;
                cursor: pointer;
            }
            .btn-nectar-save:hover {
                background: #fffcf0;
                border-color: #f59e0b;
                transform: scale(1.02);
            }
            .btn-nectar-cancel {
                padding: 14px 24px;
                border: 2px solid #fbbf24;
                color: #b45309;
                font-weight: 700;
                border-radius: 16px;
                background: white;
                transition: all 0.2s;
                cursor: pointer;
            }
            .btn-nectar-cancel:hover {
                background: #fffcf0;
                border-color: #f59e0b;
            }
            .scrollable-list {
                max-height: 55vh;
                overflow-y: auto;
                padding: 4px;
            }
        </style>
        <div class="mb-4">
            <p class="text-sm text-stone-600">Select the themes you want to focus on. Only tasks from selected themes will appear in your daily tasks. You can change this anytime.</p>
        </div>
        <div class="scrollable-list">
            ${checkboxesHtml}
        </div>
        <div class="mt-8 flex gap-3">
            <button id="themeSelectorSaveBtn" class="btn-nectar-save">Save Selection</button>
            <button id="themeSelectorCancelBtn" class="btn-nectar-cancel">Cancel</button>
        </div>
    `;

    const sheet = showBottomSheet('Choose Your Focus Themes', modalHtml);
    const saveBtn = document.getElementById('themeSelectorSaveBtn');
    const cancelBtn = document.getElementById('themeSelectorCancelBtn');
    const closeSheet = () => sheet.querySelector('.bottom-sheet-close').click();

    saveBtn.onclick = async () => {
        const checkboxes = document.querySelectorAll('.theme-checkbox:checked');
        const newSelected = Array.from(checkboxes).map(cb => cb.value);
        const { error } = await supabase
            .from('profiles')
            .update({ selected_themes: newSelected })
            .eq('id', userProfile.id);
        if (error) {
            showToast('Failed to save theme selection', 'error');
            return;
        }
        selectedThemes = newSelected;
        userProfile.selected_themes = newSelected;
        closeSheet();
        await refreshTasks();
        showToast('Theme selection saved!', 'success');
    };
    cancelBtn.onclick = closeSheet;
}

// ======================== SILENT EXPERIENCED TASK SWITCH ========================
async function autoSwitchToExperiencedIfReady() {
    if (showingExperienced || !userProfile) return;

    const allNoviceCompleted = baseTasks.length > 0 && baseTasks.every(t => completedNovice.has(t.id));
    if (!allNoviceCompleted) return;

    if (userProfile.prefers_experienced) {
        showingExperienced = true;
        await refreshTasks();
        return;
    }

    const { error } = await supabase
        .from('profiles')
        .update({ prefers_experienced: true })
        .eq('id', userProfile.id);

    if (error) {
        console.warn('Failed to auto-switch to experienced tasks:', error);
        return;
    }

    userProfile.prefers_experienced = true;
    showingExperienced = true;
    await refreshTasks();
}

function checkAndShowUpgradeModal() {
    autoSwitchToExperiencedIfReady();
}

function checkAndShowDeadEndModal() {
    // No popup – experienced tasks continue silently; tier upgrades via paid Stripe flow only
}

function closeUpgradePromptModal() {
    const modal = document.getElementById('upgradePromptModal');
    if (modal) modal.style.display = 'none';
    upgradeModalShown = false;
}

// ======================== OTHER FUNCTIONS ========================
async function upgradeTier(newTier) {
    const newMemberTier = tierToNumber[newTier];
    const updates = { tier: newTier, member_tier: newMemberTier, prefers_experienced: false };
    const { error } = await supabase
        .from('profiles')
        .update(updates)
        .eq('id', userProfile.id);

    if (!error) {
        userProfile.tier = newTier;
        userProfile.member_tier = newMemberTier;
        userProfile.prefers_experienced = false;
        showingExperienced = false;
        upgradeModalShown = false;
        deadEndModalShown = false;
        showToast(`Tier updated to ${newTier}`, 'success');
        const newBaseTasks = await fetchBaseTasksForTier(newMemberTier);
        if (newBaseTasks.length) {
            baseTasks = newBaseTasks;
        }
        updateProfileUI();
        await refreshTasks();
        await checkAndAwardMilestones();
        setThemeFromTier();
        window.location.reload();
    } else {
        showToast('Failed to update tier', 'error');
    }
}

async function loadSubscriptionInfo() {
  const tier = userProfile.tier;
  const status = userProfile.subscription_status;
  const periodEnd = userProfile.subscription_current_period_end;
  const cancelAtPeriodEnd = userProfile.subscription_cancel_at_period_end;

  const container = document.getElementById('subscriptionInfo');
  if (!container) return;

  // Show the panel for anyone on a paid tier. Early-access upgrades are granted
  // without Stripe, so a missing stripe_subscription_id must NOT hide it.
  if (userProfile.member_tier === 0 && !userProfile.stripe_subscription_id) {
    container.style.display = 'none';
    return;
  }

  container.style.display = 'block';
  document.getElementById('subTier').innerText = tier === 'plus' ? 'Meadow+' : tier === 'steward' ? 'Steward' : 'Collective';

  // Renewal date: profiles.subscription_current_period_end first, then the
  // subscriptions row. Never leave the field blank.
  const hasStripeSub = !!userProfile.stripe_subscription_id;
  let effectivePeriodEnd = periodEnd || null;
  if (!effectivePeriodEnd && hasStripeSub) {
    const { data: subRow } = await supabase
      .from('subscriptions')
      .select('current_period_end')
      .eq('user_id', userProfile.id)
      .maybeSingle();
    if (subRow && subRow.current_period_end) effectivePeriodEnd = subRow.current_period_end;
  }

  const renewalEl = document.getElementById('subRenewalDate');
  if (effectivePeriodEnd) {
    renewalEl.innerText = new Date(effectivePeriodEnd).toLocaleDateString();
  } else if (hasStripeSub) {
    renewalEl.innerText = 'awaiting confirmation from Stripe';
  } else {
    renewalEl.innerText = 'Free during early access - no renewal charge';
  }

  if (status === 'canceled' || cancelAtPeriodEnd) {
    const endDate = effectivePeriodEnd ? new Date(effectivePeriodEnd).toLocaleDateString() : 'the end of the current period';
    document.getElementById('subscriptionCancelMsg').style.display = 'block';
    document.getElementById('subscriptionCancelMsg').innerHTML = `<i class="fas fa-exclamation-triangle"></i> Your subscription will end on ${endDate}. You will be downgraded to Free tier after that date.`;
    document.getElementById('cancelSubscriptionBtn').style.display = 'none';
  } else {
    document.getElementById('subscriptionCancelMsg').style.display = 'none';
    document.getElementById('cancelSubscriptionBtn').style.display = hasStripeSub ? 'inline-block' : 'none';
  }
}

async function cancelSubscription() {
  // Show custom confirmation modal
  const modal = document.getElementById('confirmationModal');
  const messageEl = document.getElementById('confirmationMessage');
  if (!modal) return;

  // Set custom message (optional)
  messageEl.innerText = 'Are you sure you want to cancel your subscription? You will lose access to paid features after the current billing period ends.';

  // Show modal
  modal.style.display = 'flex';
  setTimeout(() => modal.classList.add('active'), 10);

  // Handle Yes click
  const yesBtn = document.getElementById('confirmYesBtn');
  const noBtn = document.getElementById('confirmNoBtn');

  const onYes = async () => {
    // Clean up listeners and hide modal
    yesBtn.removeEventListener('click', onYes);
    noBtn.removeEventListener('click', onNo);
    modal.classList.remove('active');
    setTimeout(() => modal.style.display = 'none', 300);

    // Close any open bottom sheets
    closeAllBottomSheets();

    // Show loading toast
    showToast('Cancelling subscription...', 'info');

    // Perform cancellation
    Loader.show('Processing cancellation...');
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const accessToken = session?.access_token;
      if (!accessToken) throw new Error('Not logged in');

      const response = await fetch('https://gxboojbfmpejbjolfmjq.supabase.co/functions/v1/cancel-subscription', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        }
      });

      const result = await response.json();
      if (!response.ok) throw new Error(result.error);

      showToast('Subscription cancelled. Reloading page...', 'success');
      setTimeout(() => {
        window.location.reload();
      }, 1500);
    } catch (err) {
      console.error(err);
      showToast(err.message, 'error');
      Loader.hide();
    } finally {
      Loader.hide();
    }
  };

  const onNo = () => {
    modal.classList.remove('active');
    setTimeout(() => modal.style.display = 'none', 300);
    // Clean up listeners
    yesBtn.removeEventListener('click', onYes);
    noBtn.removeEventListener('click', onNo);
  };

  // Attach listeners (remove any existing first to avoid duplicates)
  yesBtn.removeEventListener('click', onYes);
  noBtn.removeEventListener('click', onNo);
  yesBtn.addEventListener('click', onYes);
  noBtn.addEventListener('click', onNo);
}

function setupTierSimulator() {
    if (userProfile.email !== 'anhishgautam@gmail.com') return;
    const simulator = document.getElementById('tierSimulator');
    if (!simulator) return;
    simulator.style.display = 'block';
    const select = document.getElementById('tierSelect');
    select.value = userProfile.tier || 'free';

    let bypassCheckbox = document.getElementById('bypassGuardrails');
    if (!bypassCheckbox) {
        const div = document.createElement('div');
        div.style.marginTop = '10px';
        div.innerHTML = `
            <label style="display:flex; align-items:center; gap:5px;">
                <input type="checkbox" id="bypassGuardrails" ${bypassGuardrails ? 'checked' : ''}>
                <span class="tiny">Bypass Guardrails (for testing)</span>
            </label>
        `;
        simulator.appendChild(div);
        bypassCheckbox = document.getElementById('bypassGuardrails');
        bypassCheckbox.addEventListener('change', (e) => {
            bypassGuardrails = e.target.checked;
            refreshTasks();
        });
    } else {
        bypassCheckbox.checked = bypassGuardrails;
    }

    document.getElementById('updateTierBtn').addEventListener('click', async () => {
        await upgradeTier(select.value);
    });

    const incBtn = document.getElementById('incInfluenceBtn');
    if (incBtn) {
        incBtn.addEventListener('click', async () => {
            const newCount = (userProfile.referral_count || 0) + 1;
            const { error } = await supabase
                .from('profiles')
                .update({ referral_count: newCount })
                .eq('id', userProfile.id);
            if (!error) {
                userProfile.referral_count = newCount;
                showToast(`Influence count increased to ${newCount}`, 'success');
                await checkAndAwardMilestones();
            } else {
                showToast('Failed to update influence', 'error');
            }
        });
    }
}

// Admin simulator functions
let adminSimulatorInitialized = false;

async function initAdminSimulator() {
    if (adminSimulatorInitialized) return;
    adminSimulatorInitialized = true;

    const { data: themes, error } = await supabase
        .from('themes')
        .select('theme_id, theme_name')
        .order('theme_id');
    if (error) {
        console.error('Failed to fetch themes for admin:', error);
        return;
    }
    adminThemes = themes;

    const themeSelect = document.getElementById('adminThemeSelect');
    if (themeSelect) {
        themeSelect.innerHTML = themes.map(t => `<option value="${t.theme_id}">${t.theme_name} (${t.theme_id})</option>`).join('');
    }

    const incBtn = document.getElementById('adminIncrementBtn');
    const unlockAllBtn = document.getElementById('adminUnlockAllBtn');
    const resetBtn = document.getElementById('adminResetBtn');
    const msgDiv = document.getElementById('adminMessage');

    const showMessage = (text, isError = false) => {
        if (msgDiv) {
            msgDiv.innerText = text;
            msgDiv.style.color = isError ? 'var(--error)' : 'var(--success)';
            setTimeout(() => { msgDiv.innerText = ''; }, 3000);
        }
    };

    const performUpdate = async (increment = 1) => {
        const themeId = document.getElementById('adminThemeSelect').value;
        const stage = document.getElementById('adminStageSelect').value;
        if (!themeId || !stage) {
            showMessage('Please select theme and stage', true);
            return;
        }

        if (increment === 'unlock') {
            const { error } = await supabase
                .from('user_theme_progress')
                .upsert({
                    user_id: userProfile.id,
                    theme_id: themeId,
                    stage: stage,
                    novice_days_count: 100,
                    experienced_days_count: 100
                }, { onConflict: 'user_id, theme_id, stage' });
            if (error) {
                showMessage('Error: ' + error.message, true);
                return;
            }
            showMessage('Unlocked all tasks for this theme/stage! Refresh page to see changes.');
            return;
        }

        if (increment === 'reset') {
            const { error } = await supabase
                .from('user_theme_progress')
                .upsert({
                    user_id: userProfile.id,
                    theme_id: themeId,
                    stage: stage,
                    novice_days_count: 0,
                    experienced_days_count: 0
                }, { onConflict: 'user_id, theme_id, stage' });
            if (error) {
                showMessage('Error: ' + error.message, true);
                return;
            }
            showMessage('Reset to 0. Refresh page to see changes.');
            return;
        }

        const { error } = await supabase.rpc('increment_theme_stage_progress', {
            p_user_id: userProfile.id,
            p_theme_id: themeId,
            p_stage: stage,
            p_increment: increment
        });
        if (error) {
            showMessage('Error: ' + error.message, true);
            return;
        }
        showMessage(`Incremented both counts by ${increment}. Refresh page to see changes.`);
    };

    incBtn.onclick = () => {
        const amount = parseInt(document.getElementById('adminIncrementAmount').value, 10) || 1;
        performUpdate(amount);
    };
    unlockAllBtn.onclick = () => performUpdate('unlock');
    resetBtn.onclick = () => performUpdate('reset');
}

function setupAdminSimulator() {
    if (userProfile.email === 'anhishgautam@gmail.com') {
        const desktopSim = document.getElementById('adminSimulator');
        if (desktopSim) desktopSim.style.display = 'block';
        const mobileBtn = document.getElementById('mobileAdminSimulatorBtn');
        if (mobileBtn) mobileBtn.style.display = 'block';
        initAdminSimulator();

        if (mobileBtn) {
            mobileBtn.onclick = () => {
                const formHtml = `
                    <div style="margin-bottom: 12px;">
                        <label class="tiny">Theme</label>
                        <select id="mobileAdminThemeSelect" style="width: 100%; padding: 8px;"></select>
                    </div>
                    <div style="margin-bottom: 12px;">
                        <label class="tiny">Stage</label>
                        <select id="mobileAdminStageSelect" style="width: 100%; padding: 8px;">
                            <option value="\u{1F330} Seeds">Seeds</option>
                            <option value="\u{1F331} Sprout">Sprout</option>
                            <option value="\u{1F338} Bloom">Bloom</option>
                            <option value="\u{1F33E} Harvest">Harvest</option>
                        </select>
                    </div>
                    <div style="margin-bottom: 12px;">
                        <label class="tiny">Increment by</label>
                        <input type="number" id="mobileAdminIncrementAmount" value="1" min="1" style="width: 100%; padding: 8px;">
                    </div>
                    <div style="display: flex; gap: 8px; flex-wrap: wrap;">
                        <button id="mobileAdminIncrementBtn" class="btn tiny" style="background: var(--primary);">Increment</button>
                        <button id="mobileAdminUnlockAllBtn" class="btn tiny" style="background: var(--success);">Unlock All</button>
                        <button id="mobileAdminResetBtn" class="btn tiny" style="background: var(--error);">Reset</button>
                    </div>
                    <div id="mobileAdminMessage" class="tiny muted" style="margin-top: 12px;"></div>
                `;
                const sheet = showBottomSheet('Admin Simulator', formHtml);
                const themeSelect = document.getElementById('mobileAdminThemeSelect');
                if (themeSelect && adminThemes.length) {
                    themeSelect.innerHTML = adminThemes.map(t => `<option value="${t.theme_id}">${t.theme_name} (${t.theme_id})</option>`).join('');
                }
                const incBtn = document.getElementById('mobileAdminIncrementBtn');
                const unlockAllBtn = document.getElementById('mobileAdminUnlockAllBtn');
                const resetBtn = document.getElementById('mobileAdminResetBtn');
                const msgDiv = document.getElementById('mobileAdminMessage');

                const showMsg = (text, isErr) => {
                    msgDiv.innerText = text;
                    msgDiv.style.color = isErr ? 'var(--error)' : 'var(--success)';
                    setTimeout(() => msgDiv.innerText = '', 3000);
                };

                const perform = async (action) => {
                    const themeId = document.getElementById('mobileAdminThemeSelect').value;
                    const stage = document.getElementById('mobileAdminStageSelect').value;
                    if (!themeId || !stage) { showMsg('Select theme and stage', true); return; }
                    if (action === 'increment') {
                        const amount = parseInt(document.getElementById('mobileAdminIncrementAmount').value, 10) || 1;
                        const { error } = await supabase.rpc('increment_theme_stage_progress', {
                            p_user_id: userProfile.id,
                            p_theme_id: themeId,
                            p_stage: stage,
                            p_increment: amount
                        });
                        if (error) showMsg(error.message, true);
                        else showMsg(`Incremented both counts by ${amount}. Refresh page.`);
                    } else if (action === 'unlock') {
                        const { error } = await supabase
                            .from('user_theme_progress')
                            .upsert({
                                user_id: userProfile.id,
                                theme_id: themeId,
                                stage: stage,
                                novice_days_count: 100,
                                experienced_days_count: 100
                            }, { onConflict: 'user_id, theme_id, stage' });
                        if (error) showMsg(error.message, true);
                        else showMsg('Unlocked all. Refresh page.');
                    } else if (action === 'reset') {
                        const { error } = await supabase
                            .from('user_theme_progress')
                            .upsert({
                                user_id: userProfile.id,
                                theme_id: themeId,
                                stage: stage,
                                novice_days_count: 0,
                                experienced_days_count: 0
                            }, { onConflict: 'user_id, theme_id, stage' });
                        if (error) showMsg(error.message, true);
                        else showMsg('Reset to 0. Refresh page.');
                    }
                };

                incBtn.onclick = () => perform('increment');
                unlockAllBtn.onclick = () => perform('unlock');
                resetBtn.onclick = () => perform('reset');
            };
        }
    }
}

function setupLogout() {
    const logoutBtn = document.getElementById('logoutBtn');
    if (logoutBtn) {
        logoutBtn.addEventListener('click', async () => {
            Loader.show("Safely signing you out...");
            try {
                await supabase.auth.signOut();
                window.location.replace('index.html');
            } catch (err) {
                console.error("Logout Error:", err);
                showToast("Error signing out. Please try again.", "error");
                Loader.hide();
            }
        });
    }
}

async function restartProgress() {
    console.log("Restarting progress...");
    const deadEndModal = document.getElementById('deadEndModal');
    const completedModal = document.getElementById('completedModal');
    const noviceModal = document.getElementById('noviceCompleteModal');
    if (deadEndModal) deadEndModal.style.display = 'none';
    if (completedModal) completedModal.style.display = 'none';
    if (noviceModal) noviceModal.style.display = 'none';
    try {
        await supabase.from('user_tasks').delete().eq('user_id', userProfile.id);
        await supabase.from('user_task_group_stats').delete().eq('user_id', userProfile.id);
        await supabase.from('sigma_logs').delete().eq('user_id', userProfile.id);
        await supabase.from('task_sigma_logs').delete().eq('user_id', userProfile.id);
        await supabase.from('user_milestones').delete().eq('user_id', userProfile.id);
        await supabase.from('profiles').update({ nectar_points: 0, experience: 0, referral_count: 0 }).eq('id', userProfile.id);
        userProfile.total_points = 0;
        userProfile.nectar_points = 0;
        userProfile.experience = 0;
        userProfile.referral_count = 0;
        completedNovice.clear();
        completedExperienced.clear();
        loggedSigmaTasks.clear();
        showingExperienced = false;
        noviceModalShown = false;
        deadEndModalShown = false;
        upgradeModalShown = false;
        setTimeout(() => initProfile(), 100);
    } catch (err) {
        console.error("Restart failed:", err);
        showToast("Failed to reset progress: " + err.message, "error");
    }
}

function updateCompletedBadge() {
    const totalCompleted = completedNovice.size + completedExperienced.size;
    const badge = document.getElementById('completedCountBadge');
    if (badge) badge.innerText = totalCompleted;
    const mobileBadge = document.getElementById('mobileCompletedBadge');
    if (mobileBadge) mobileBadge.innerText = totalCompleted;
}

function updatePendingSigmaBadge() {
    const pendingCount = Array.from(completedNovice).concat(Array.from(completedExperienced))
        .filter(id => !loggedSigmaTasks.has(id)).length;
    const badge = document.getElementById('pendingSigmaCountBadge');
    if (badge) badge.innerText = pendingCount;
    const mobileBadge = document.getElementById('mobilePendingSigmaBadge');
    if (mobileBadge) mobileBadge.innerText = pendingCount;
}

function closePendingSigmaModal() {
    document.getElementById('pendingSigmaModal').style.display = 'none';
}

function setThemeFromTier() {
    const tier = userProfile.tier || 'free';
    let theme = 'classic';
    if (tier === 'plus') theme = 'gold';
    else if (tier === 'steward') theme = 'dark';
    document.body.setAttribute('data-theme', theme);
    localStorage.setItem('meadow-theme', theme);
}

// ======================== INIT ========================
export async function initProfile() {
    Loader.show("Gathering your nectar...");
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) {
        // Installed PWA: /login.html is outside the manifest scope, so the
        // navigation would be handed to the browser and the member would fall
        // out of the app. Ask for the credentials in place instead.
        if (window.MeadowPwa && window.MeadowPwa.isStandalone()) {
            Loader.hide();
            window.MeadowPwa.showSignIn();
            return;
        }
        window.location.replace(getBaseURL() + 'login.html');
        return;
    }

    try {
        const { data: profile, error: profileError } = await supabase
            .from('profiles')
            .select('*')
            .eq('id', user.id)
            .single();
        if (profileError) throw profileError;
        userProfile = profile;
        if (!userProfile.tier) userProfile.tier = 'free';
        userProfile.total_points = userProfile.nectar_points;
        userProfile.experience = userProfile.total_points % 100;

        const tierNum = tierToNumber[userProfile.tier];

        const { data: userTasks, error: userTasksError } = await supabase
            .from('user_tasks')
            .select('task_id, version, completed_at')
            .eq('user_id', user.id);
        if (userTasksError) throw userTasksError;

        completedNovice.clear();
        completedExperienced.clear();
        // Rebuild the completion-time map from the DB on every load. It drives the 24h
        // sequential cooldown in refreshTasks(); previously it was filled ONLY when a task
        // was completed in the current session, so after any refresh it was empty and
        // `hoursSincePrev` fell through to 999 -> every task whose predecessor was done
        // unlocked instantly. That is why the cooldown appeared to be gone.
        completedAtMap = {};
        userTasks.forEach(t => {
            if (t.version === 'novice') completedNovice.add(t.task_id);
            else if (t.version === 'experienced') completedExperienced.add(t.task_id);
            if (t.completed_at) completedAtMap[t.task_id] = t.completed_at;
        });

        const { data: progressData, error: progressError } = await supabase
            .from('user_theme_progress')
            .select('theme_id, stage, novice_days_count, experienced_days_count')
            .eq('user_id', user.id);
        if (progressError) throw progressError;
        themeStageProgress = {};
        progressData.forEach(p => {
            if (!themeStageProgress[p.theme_id]) themeStageProgress[p.theme_id] = {};
            themeStageProgress[p.theme_id][p.stage] = {
                novice: p.novice_days_count,
                experienced: p.experienced_days_count
            };
        });

        const { data: feedback, error: feedbackError } = await supabase
            .from('task_feedback')
            .select('task_id, reaction')
            .eq('user_id', user.id);
        if (feedbackError) throw feedbackError;
        userReactions = {};
        feedback.forEach(f => { userReactions[f.task_id] = f.reaction; });

        const { data: comments, error: commentsError } = await supabase
            .from('task_comments')
            .select('*')
            .eq('user_id', user.id)
            .order('created_at', { ascending: false });
        if (commentsError) throw commentsError;
        userComments = comments;

        const { data: sigmaLogs, error: sigmaLogsError } = await supabase
            .from('task_sigma_logs')
            .select('task_id')
            .eq('user_id', user.id);
        if (sigmaLogsError) throw sigmaLogsError;
        loggedSigmaTasks.clear();
        sigmaLogs.forEach(l => loggedSigmaTasks.add(l.task_id));

        baseTasks = await fetchBaseTasksForTier(tierNum);

        selectedThemes = profile.selected_themes || [];

        const desktopThemeBtn = document.getElementById('themeSelectorDesktopBtn');
        const mobileThemeBtn = document.getElementById('mobileThemeSelectorBtn');
        if (tierNum >= 1) {
            if (desktopThemeBtn) desktopThemeBtn.style.display = 'block';
            if (mobileThemeBtn) mobileThemeBtn.style.display = 'block';
        } else {
            if (desktopThemeBtn) desktopThemeBtn.style.display = 'none';
            if (mobileThemeBtn) mobileThemeBtn.style.display = 'none';
        }

        if (desktopThemeBtn) desktopThemeBtn.addEventListener('click', showThemeSelectorModal);
        if (mobileThemeBtn) mobileThemeBtn.addEventListener('click', showThemeSelectorModal);

        showingExperienced = userProfile.prefers_experienced || false;

        setupMultiFilters();
        await refreshTasks();

        setupLogout();
        setupTierSimulator();

        window.openMissionsModal = openMissionsModal;
        window.loadAchievementsModal = loadAchievementsModal;
        window.openCompletedModal = openCompletedModal;
        window.openPendingSigmaModal = openPendingSigmaModal;
        window.openSigmaModal = openSigmaModal;
        window.openTaskSigmaModal = openTaskSigmaModal;
        window.loadCompletedTasks = openCompletedModal;
        window.loadPendingSigmaTasks = openPendingSigmaModal;

        // These sidebar entries are anchors with href="#". Without preventDefault the
        // click bubbles to the router, which re-renders the view and wipes the sheet
        // the handler just opened (the "loader spins, nothing happens" bug).
        const onNavClick = (el, fn) => {
            if (!el) return;
            el.addEventListener('click', (e) => { e.preventDefault(); fn(); });
        };
        onNavClick(document.getElementById('desktopMissionsBtn'), openMissionsModal);
        onNavClick(document.getElementById('desktopAchievementsBtn'), loadAchievementsModal);
        onNavClick(document.getElementById('completedTasksSection'), openCompletedModal);
        onNavClick(document.getElementById('pendingSigmaSection'), openPendingSigmaModal);
        onNavClick(document.getElementById('addSigmaBtnDesktop'), openSigmaModal);

        // #mobileMissionsBtn carries the "Tasks Reflection" label and the pending
        // reflection badge — it must open the reflection list, not Daily Tasks.
        // (Missions keeps its own entry: the sidebar "Go to Missions" link, which
        // is visible on mobile too.)
        const mobileMissions = document.getElementById('mobileMissionsBtn');
        if (mobileMissions) mobileMissions.onclick = () => openPendingSigmaModal();
        const mobileAchievements = document.getElementById('mobileAchievementsBtn');
        if (mobileAchievements) mobileAchievements.onclick = () => loadAchievementsModal();
        const mobileCompleted = document.getElementById('mobileCompletedTasksBtn');
        if (mobileCompleted) mobileCompleted.onclick = () => openCompletedModal();
        const mobilePending = document.getElementById('mobilePendingSigmaBtn');
        if (mobilePending) mobilePending.onclick = () => openPendingSigmaModal();
        const mobileSigma = document.getElementById('mobileAddSigmaBtn');
        if (mobileSigma) mobileSigma.onclick = () => openSigmaModal();

        updateCompletedBadge();
        updatePendingSigmaBadge();

        await checkAndAwardMilestones();

        setThemeFromTier();

        const mobileLogout = document.getElementById('mobileLogoutBtn');
        if (mobileLogout) {
            mobileLogout.addEventListener('click', async () => {
                Loader.show("Safely signing you out...");
                try {
                    await supabase.auth.signOut();
                    window.location.replace('index.html');
                } catch (err) {
                    console.error("Logout Error:", err);
                    showToast("Error signing out. Please try again.", "error");
                    Loader.hide();
                }
            });
        }

        const mobileTierSelect = document.getElementById('mobileTierSelect');
        const mobileUpdateTier = document.getElementById('mobileUpdateTierBtn');
        if (mobileTierSelect && mobileUpdateTier) {
            mobileTierSelect.value = userProfile.tier || 'free';
            mobileUpdateTier.addEventListener('click', async () => {
                await upgradeTier(mobileTierSelect.value);
            });
        }
        const mobileIncInfluence = document.getElementById('mobileIncInfluenceBtn');
        if (mobileIncInfluence) {
            mobileIncInfluence.addEventListener('click', async () => {
                const newCount = (userProfile.referral_count || 0) + 1;
                const { error } = await supabase
                    .from('profiles')
                    .update({ referral_count: newCount })
                    .eq('id', userProfile.id);
                if (!error) {
                    userProfile.referral_count = newCount;
                    showToast(`Influence count increased to ${newCount}`, 'success');
                    await checkAndAwardMilestones();
                } else {
                    showToast('Failed to update influence', 'error');
                }
            });
        }

        const mobileCompletedBadge = document.getElementById('mobileCompletedBadge');
        if (mobileCompletedBadge) {
            mobileCompletedBadge.innerText = completedNovice.size + completedExperienced.size;
        }
        const mobilePendingBadge = document.getElementById('mobilePendingSigmaBadge');
        if (mobilePendingBadge) {
            const pendingCount = Array.from(completedNovice).concat(Array.from(completedExperienced))
                .filter(id => !loggedSigmaTasks.has(id)).length;
            mobilePendingBadge.innerText = pendingCount;
        }

        const { data: guardrails, error: guardrailsError } = await supabase
            .from('theme_guardrails')
            .select('theme_id, stage, min_days');
        if (!guardrailsError && guardrails) {
            stageGuardrails = {};
            guardrails.forEach(g => {
                if (!stageGuardrails[g.theme_id]) stageGuardrails[g.theme_id] = {};
                stageGuardrails[g.theme_id][g.stage] = { min_days: g.min_days };
            });
        }

        await autoSwitchToExperiencedIfReady();
        await updateAchievementsBadge();

        if (tierNum >= 1 && (!selectedThemes || selectedThemes.length === 0)) {
            setTimeout(() => {
                showThemeSelectorModal();
            }, 500);
        }

        // 2026-10-13: dead code removed — #mobileFloatingMissionsBtn is not in the DOM and
        // duplicated the mobile 'Go to Missions' action button (overlap risk).

        // ========== NEW: Load subscription info and attach cancel button ==========
        await loadSubscriptionInfo();
        const cancelBtn = document.getElementById('cancelSubscriptionBtn');
        if (cancelBtn) {
            cancelBtn.addEventListener('click', cancelSubscription);
        }

    } catch (err) {
        console.error("Profile initialization failed:", err);
        showToast("Failed to load profile data.", "error");
    } finally {
        Loader.hide();
        document.body.classList.remove('data-loading');
    }
}

// ======================== MODAL EVENT LISTENERS ========================
document.addEventListener('DOMContentLoaded', () => {
    const restartBtn = document.getElementById('restartBtn');
    if (restartBtn) restartBtn.addEventListener('click', restartProgress);
});

window.closeCompletedModal = () => {
    document.getElementById('completedModal').style.display = 'none';
};
window.closePendingSigmaModal = closePendingSigmaModal;
window.closeSigmaModal = () => {
    document.getElementById('sigmaModal').style.display = 'none';
};
window.closeTaskSigmaModal = () => {
    document.getElementById('taskSigmaModal').style.display = 'none';
};
window.closeAchievementsModal = () => {
    document.getElementById('achievementsModal').style.display = 'none';
};
window.closeUpgradePromptModal = closeUpgradePromptModal;
window.startEditComment = (id, oldText) => {
    const box = document.getElementById(`comment-box-${id}`);
    const escaped = String(oldText).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    box.innerHTML = `
        <input type="text" id="edit-input-${id}" value="${escaped}" style="width:100%; padding:5px; border:1px solid #3b82f6; border-radius:4px;">
        <div style="margin-top:5px;">
            <button onclick="window.saveEditComment('${id}')" style="background:#22c55e; color:white; border:none; padding:10px 14px; border-radius:4px; min-height:44px;">Save</button>
            <button onclick="window.cancelEditComment('${id}')" style="background:#64748b; color:white; border:none; padding:10px 14px; border-radius:4px; min-height:44px;">Cancel</button>
        </div>
    `;
};
window.saveEditComment = async (id) => {
    const input = document.getElementById(`edit-input-${id}`);
    if (!input) return;
    const newText = input.value;
    if (!newText.trim()) return;
    await supabase.from('task_comments').update({ comment_text: newText }).eq('id', id);
    // refreshTasks() renders from the in-memory list, so an edit never showed up until
    // a full page reload (same class of bug as the insert path).
    const row = userComments.find(c => String(c.id) === String(id));
    if (row) row.comment_text = newText;
    refreshTasks();
};
window.cancelEditComment = (id) => { refreshTasks(); };
window.deleteComment = async (id) => {
    if (confirm("Delete this comment?")) {
        await supabase.from('task_comments').delete().eq('id', id);
        // deleted rows lingered in the in-memory list and kept rendering
        userComments = userComments.filter(c => String(c.id) !== String(id));
        refreshTasks();
    }
};

// ======================== DESIGN LAYER (profile page) ========================
// Purely presentational: story rail, filter toggle/badge, tab counts, hero CTA,
// nudge. All of it reads/writes the same state the page already used.
var storyFilter = 'All';
var locksExpanded = false;
var lastRenderedTasks = [];
var justCompletedId = null;

function activeFilterCount() {
    return activeFilters.core_theme.length + activeFilters.stage.length + activeFilters.subcategory.length;
}

function updateFilterBadge() {
    const badge = document.getElementById('filterBadge');
    if (badge) badge.innerText = activeFilterCount();
}

function updateTabCounts() {
    const pending = document.getElementById('pendingSigmaCountBadge');
    const completed = document.getElementById('completedCountBadge');
    const ach = document.querySelector('.achievements-badge');
    const t1 = document.getElementById('tabTaskCount');
    const t2 = document.getElementById('tabReflectionCount');
    const t3 = document.getElementById('tabCompletedCount');
    const t4 = document.getElementById('tabAchievementCount');
    if (t1) t1.innerText = (typeof totalVisibleTasks === 'number' && totalVisibleTasks) ? totalVisibleTasks : '';
    if (t2) t2.innerText = (pending && pending.innerText) ? pending.innerText : '';
    if (t3) t3.innerText = (typeof completedVisibleTasks === 'number' && completedVisibleTasks) ? completedVisibleTasks : '';
    if (t4) t4.innerText = (ach && ach.innerText) ? ach.innerText : '';
}

function updatePartnerCompare() {
    const el = document.getElementById('partnerCmp');
    if (!el) return;
    if (!hasCollabAccess || !partnerInfo || partnerInfo.length === 0) { el.innerText = ''; return; }
    const mine = completedNovice.size + completedExperienced.size;
    const theirs = (typeof partnerCompletedTasks !== 'undefined' && partnerCompletedTasks) ? partnerCompletedTasks.size : 0;
    el.innerHTML = `<b>You</b> ${mine} completed &nbsp;\u00b7&nbsp; <b>${escapeHtml(partnerInfo[0].username || 'Partner')}</b> ${theirs}`;
}
window.updatePartnerCompare = updatePartnerCompare;

// ---- Theme chip artwork ---------------------------------------------------
// themes.visual_symbol_icon_idea holds each theme's token image (Supabase Storage
// "Theme image" bucket, ~1.6 MB per PNG). That is far too heavy for a 56px chip, so
// the same artwork ships pre-trimmed at assets/theme-icons/<key>.{webp,png} (9-18 KB).
// Regenerate with scripts/build-theme-icons.py after changing a theme image.
const THEME_ICON_FILES = {
    connecting: 'connecting',
    creating: 'creating',
    innovating: 'innovating',
    reflecting: 'reflecting',
    acting: 'acting'
};
let themeImageMap = null; // null = not fetched yet; object = fetched (may be empty if RLS/offline)

// "Connecting / Belonging" -> "connecting";  "Creating" -> "creating"
function themeKey(str) {
    return String(str || '').toLowerCase().replace(/[^a-z]+/g, ' ').trim().split(' ')[0] || '';
}

async function loadThemeImages() {
    themeImageMap = {};
    try {
        const { data, error } = await supabase
            .from('themes')
            .select('theme_id, theme_name, visual_symbol_icon_idea');
        if (error) return themeImageMap;
        (data || []).forEach(t => {
            const k = themeKey(t.theme_name);
            if (k) themeImageMap[k] = { name: t.theme_name, remote: t.visual_symbol_icon_idea || '' };
        });
    } catch (e) { /* chips keep the hashtag glyph */ }
    return themeImageMap;
}

function themeChipIcon(themeStr) {
    const k = themeKey(themeStr);
    if (!k || !themeImageMap || !themeImageMap[k]) return null;
    const file = THEME_ICON_FILES[k];
    if (!file) return null;
    const meta = themeImageMap[k];
    const base = 'assets/theme-icons/' + file;
    return `<picture>
                 <source srcset="${base}.webp" type="image/webp">
                 <img src="${base}.png" alt="${escapeHtml(meta.name || themeStr)}" width="56" height="56" loading="lazy" decoding="async">
               </picture>`;
}

function renderStories() {
    const rail = document.getElementById('storiesRail');
    if (!rail) return;
    const themes = [...new Set(allTasksWithCompleted.map(t => t.core_theme).filter(Boolean))].slice(0, 6);
    const partnerLabel = (typeof partnerInfo !== 'undefined' && partnerInfo.length > 0 && partnerInfo[0].username) ? partnerInfo[0].username : 'Partner';
    const items = [{ v: 'All', label: 'All tasks', icon: 'fa-seedling', ring: 'var(--sage5)' }];
    if (hasCollabAccess) items.push({ v: 'partner', label: partnerLabel, icon: 'fa-user-group', ring: 'var(--clay)' });
    items.push({ v: 'mine', label: 'Tended', icon: 'fa-check', ring: 'var(--green)' });
    themes.forEach(t => items.push({ v: t, label: t, icon: 'fa-hashtag', ring: 'var(--sage4)', theme: t }));

    // Theme artwork comes from the DB; paint the chips now and repaint once it lands.
    if (themeImageMap === null) loadThemeImages().then(() => renderStories());

    rail.innerHTML = items.map(it => {
        const on = (storyFilter === it.v) || (it.v !== 'All' && it.v !== 'mine' && it.v !== 'partner' && storyFilter === 'All' && activeFilters.core_theme.length === 1 && activeFilters.core_theme[0] === it.v);
        const chipIcon = it.theme ? themeChipIcon(it.theme) : null;
        return `<button type="button" class="story${on ? ' on' : ''}" style="--ring:${it.ring}" data-story="${escapeHtml(it.v)}" aria-pressed="${on}">
            <span class="rg"><span class="in">${chipIcon || `<i class="fas ${it.icon}"></i>`}</span></span>
            <span>${escapeHtml(it.label)}</span>
        </button>`;
    }).join('');
    rail.querySelectorAll('.story').forEach(btn => {
        btn.addEventListener('click', () => setStoryFilter(btn.dataset.story));
    });
}

function setStoryFilter(value) {
    if (value === 'mine' || value === 'partner') {
        storyFilter = value;
        activeFilters.core_theme.length = 0;
    } else if (value === 'All') {
        storyFilter = 'All';
        activeFilters.core_theme.length = 0;
    } else {
        storyFilter = 'All';
        activeFilters.core_theme.length = 0;
        activeFilters.core_theme.push(value);
    }
    syncFilterCheckboxes();
    applyFiltersAndRender();
}

// Reflect story/filter state onto the page's real dropdown checkboxes + summaries.
function syncFilterCheckboxes() {
    const map = [
        { field: 'core_theme', listId: 'coreFilterList', summaryId: 'coreFilterSummary', empty: 'Themes' },
        { field: 'stage', listId: 'stageFilterList', summaryId: 'stageFilterSummary', empty: 'Stages' },
        { field: 'subcategory', listId: 'tagFilterList', summaryId: 'tagFilterSummary', empty: 'Tags' }
    ];
    map.forEach(m => {
        const list = document.getElementById(m.listId);
        if (list) list.querySelectorAll('input[type="checkbox"]').forEach(cb => { cb.checked = activeFilters[m.field].includes(cb.value); });
        const summary = document.getElementById(m.summaryId);
        if (summary) {
            const n = activeFilters[m.field].length;
            summary.innerText = n === 0 ? m.empty : (n === 1 ? activeFilters[m.field][0] : `${n} selected`);
        }
    });
}

function resetFilters() {
    activeFilters.core_theme.length = 0;
    activeFilters.stage.length = 0;
    activeFilters.subcategory.length = 0;
    storyFilter = 'All';
    syncFilterCheckboxes();
    applyFiltersAndRender();
    showToast('Filters cleared');
}

function initDesignExtras() {
    if (window.__designExtrasBound) return;
    window.__designExtrasBound = true;

    // Filters toggle (panel is open by default, exactly like before)
    const toggle = document.getElementById('filterToggle');
    const panel = document.getElementById('filterPanel');
    if (toggle && panel) {
        toggle.addEventListener('click', () => {
            const hidden = panel.style.display === 'none';
            panel.style.display = hidden ? '' : 'none';
            toggle.setAttribute('aria-expanded', hidden ? 'true' : 'false');
        });
    }
    const reset = document.getElementById('filterReset');
    if (reset) reset.addEventListener('click', resetFilters);

    // Hero CTA: jump to the next task that is actually actionable
    const heroCta = document.getElementById('heroCta');
    if (heroCta) {
        heroCta.addEventListener('click', () => {
            const next = document.querySelector('#tasks .post.next') || document.querySelector('#tasks .post:not(.done):not(.locked)') || document.querySelector('#tasks .post');
            if (next) {
                next.scrollIntoView({ behavior: 'smooth', block: 'center' });
                const check = next.querySelector('.task-check');
                if (check && !check.disabled) check.focus({ preventScroll: true });
            } else {
                showToast('No tasks in this view', 'error');
            }
        });
    }

    // Tab bars (desktop tabs + mobile tab bar) reuse the page's own controls
    document.querySelectorAll('.tabs button, .tab button').forEach(btn => {
        btn.addEventListener('click', () => {
            const bar = btn.closest('.tabs, .tab');
            if (bar && bar.classList.contains('tabs')) bar.querySelectorAll('button').forEach(b => b.classList.remove('on'));
            btn.classList.add('on');
            const scroll = btn.dataset.scrollTo;
            if (scroll) {
                const target = document.getElementById(scroll);
                if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
                else showToast('Nothing to show yet', 'error');
                return;
            }
            const nav = btn.dataset.nav;
            if (nav) {
                const el = document.getElementById(nav);
                if (el) el.click();
                return;
            }
            const href = btn.dataset.href;
            if (href) window.location.href = href;
        });
    });

    // Nudge (cosmetic: no partner-facing API exists yet)
    document.addEventListener('click', e => {
        const btn = e.target.closest('.mini[data-nudge]');
        if (!btn || btn.disabled) return;
        btn.disabled = true;
        showToast('Nudge noted - your partner will see it on the board');
    });
}

if (typeof document !== 'undefined') {
    document.addEventListener('DOMContentLoaded', () => setTimeout(() => { renderStories(); initDesignExtras(); }, 400));
}
