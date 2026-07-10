import { supabase } from './supabase-config.js';
import { showToast, Loader } from './app.js';
import { checkAndAwardThemeTokens, getAchievementSubtext, getMilestoneDisplayDescription } from './theme-tokens.js';

// ======================== HELPER FUNCTIONS ========================
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

const stagesForTier = {
    0: ['🌰 Seeds'],
    1: ['🌰 Seeds', '🌱 Sprout'],
    2: ['🌰 Seeds', '🌱 Sprout', '🌸 Bloom'],
    3: ['🌰 Seeds', '🌱 Sprout', '🌸 Bloom', '🌾 Harvest']
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
                showToast(`🏆 ${m.name} unlocked!`, 'success');
            });
            await updateAchievementsBadge();
        }

        await checkAndAwardThemeTokens(userProfile.id, updateAchievementsBadge);
    } catch (err) {
        console.error('Failed to check milestones:', err);
    }
}

// ======================== ACHIEVEMENTS HELPERS ========================
async function updateAchievementsBadge() {
    if (!userProfile) return;
    const { count, error } = await supabase
        .from('user_milestones')
        .select('*', { count: 'exact', head: true })
        .eq('user_id', userProfile.id)
        .eq('viewed', false);
    if (error) return;
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

function getUnlockCondition(milestone) {
    const val = milestone.requirement_value;
    switch (milestone.category) {
        case 'nectar': return `Earn ${val} Nectar points`;
        case 'tasks': return `Complete ${val} tasks`;
        case 'membership': return `Be a member for ${val} days`;
        case 'sigma': return `Complete ${val} improvement logs`;
        case 'referrals': return `Refer ${val} friends`;
        case 'theme_token': {
            const meta = parseTokenMeta(milestone.description);
            const theme = meta.core_theme || '';
            return `Complete ${val} tasks in ${theme || 'this theme'}`;
        }
        default: return `Reach milestone`;
    }
}

async function generateAchievementsHtml() {
    // 1. Fetch ALL milestones (not just earned ones)
    const { data: allMilestones, error: mError } = await supabase
        .from('milestones')
        .select('*')
        .order('category', { ascending: true })
        .order('requirement_value', { ascending: true });

    if (mError || !allMilestones || allMilestones.length === 0) {
        return '<p class="tiny muted">No achievements available yet.</p>';
    }

    // 2. Fetch user's earned milestones
    const { data: userM, error: uError } = await supabase
        .from('user_milestones')
        .select('milestone_id, achieved_at, viewed')
        .eq('user_id', userProfile.id);

    // 3. Build a map of earned milestone_id -> { viewed }
    const earnedMap = new Map();
    (userM || []).forEach(um => {
        earnedMap.set(um.milestone_id, { viewed: um.viewed });
    });

    // 4. Sort: earned milestones first, locked after
    allMilestones.sort((a, b) => {
        const aEarned = earnedMap.has(a.id) ? 0 : 1;
        const bEarned = earnedMap.has(b.id) ? 0 : 1;
        return aEarned - bEarned;
    });

    // 5. Build cards for ALL milestones — earned = full color, unearned = greyed/locked
    let cardsHtml = '';
    for (const milestone of allMilestones) {
        const earned = earnedMap.has(milestone.id);
        const earnedData = earnedMap.get(milestone.id);

        const icon = milestone.icon_url || '';
        const description = getMilestoneDisplayDescription(milestone);
        const subText = getAchievementSubtext(milestone);
        const unlockText = getUnlockCondition(milestone);

        const safeIcon = (icon || '').replace(/"/g, '%22');
        const safeName = milestone.name.replace(/"/g, '&quot;');
        const safeDesc = description.replace(/"/g, '&quot;');
        const safeSub = subText.replace(/"/g, '&quot;');
        const safeUnlock = unlockText.replace(/"/g, '&quot;');

        if (earned) {
            // --- Earned card (full colour, clickable) ---
            const imgTag = icon
                ? `<img src="${icon}" class="achievement-badge-img${milestone.category === 'theme_token' ? ' token-badge-img' : ''}" alt="${safeName}">`
                : `<div class="no-icon-placeholder earned-placeholder">🏆</div>`;

            cardsHtml += `
                <div class="achievement-container earned"
                     data-milestone-id="${milestone.id}"
                     data-icon="${safeIcon}"
                     data-name="${safeName}"
                     data-sub="${safeSub}"
                     data-desc="${safeDesc}"
                     onclick="viewMilestone(this)">
                    <div class="achievement-card">
                        ${!earnedData.viewed ? `
                            <div class="mystery-overlay">
                                <div class="reveal-msg">Click To Reveal</div>
                            </div>
                        ` : ''}
                        <div class="badge-icon-wrap">
                            ${imgTag}
                        </div>
                        <div class="achievement-card-text">
                            <h3 class="font-bold text-gray-800 text-xl italic">${milestone.name}</h3>
                            <p class="text-[10px] text-amber-600 font-black uppercase tracking-[0.2em] mt-2 bg-amber-50 inline-block px-3 py-1 rounded-full border border-amber-100">${subText}</p>
                        </div>
                    </div>
                </div>`;
        } else {
            // --- Locked card (greyed out, shows unlock condition) ---
            const imgTag = icon
                ? `<img src="${icon}" class="achievement-badge-img locked-img" alt="${safeName}">`
                : `<div class="no-icon-placeholder locked-placeholder">🏆</div>`;

            cardsHtml += `
                <div class="achievement-container locked">
                    <div class="achievement-card locked-card">
                        <div class="badge-icon-wrap">
                            ${imgTag}
                        </div>
                        <div class="achievement-card-text">
                            <h3 class="font-bold achievement-name-locked">${milestone.name}</h3>
                        </div>
                        <div class="lock-blur-overlay">
                            <div class="lock-icon-circle"><i class="fas fa-lock"></i></div>
                            <div class="unlock-message">${unlockText}</div>
                        </div>
                    </div>
                </div>`;
        }
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
            .achievement-container {
                perspective: 1200px;
                margin-bottom: 24px;
                min-height: 380px;
            }
            .achievement-container.earned {
                cursor: pointer;
            }
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
            .badge-icon-wrap {
                width: 100%;
                display: flex;
                justify-content: center;
                align-items: center;
                flex-shrink: 0;
                margin-top: 10px;
            }
            .achievement-card-text {
                width: 100%;
                text-align: center;
                margin-top: auto;
                padding-bottom: 4px;
            }
            .achievement-container.earned .achievement-card:hover {
                transform: translateY(-12px) rotateX(4deg) rotateY(4deg);
                box-shadow: 0 25px 50px -12px rgba(245, 158, 11, 0.2);
            }
            .mystery-overlay {
                position: absolute;
                inset: 0;
                z-index: 20;
                background: rgba(255, 255, 255, 0.1);
                backdrop-filter: blur(12px) saturate(180%);
                display: flex;
                align-items: center;
                justify-content: center;
                transition: all 0.5s ease;
                border-radius: 32px;
            }
            .reveal-msg {
                background: white;
                color: var(--honey-amber);
                padding: 8px 16px;
                border-radius: 100px;
                font-size: 0.7rem;
                font-weight: 800;
                text-transform: uppercase;
                letter-spacing: 1.5px;
                box-shadow: 0 4px 12px rgba(0,0,0,0.1);
            }
            .achievement-container.earned .achievement-card:hover .reveal-msg {
                transform: scale(1.05);
                box-shadow: 0 8px 20px rgba(245, 158, 11, 0.3);
            }
            .achievement-badge-img {
                width: 140px;
                height: 140px;
                margin: 0 auto;
                transform: translateZ(30px);
                border-radius: 50%;
                border: 4px solid white;
                box-shadow: 0 10px 25px rgba(245, 158, 11, 0.3), 0 0 15px rgba(251, 191, 36, 0.2);
                object-fit: cover;
            }
            .achievement-badge-img.token-badge-img {
                width: 100%;
                max-width: 220px;
                height: auto;
                min-height: 56px;
                border-radius: 12px;
                object-fit: contain;
                background: #fff;
                padding: 8px;
                flex-shrink: 0;
                display: block;
            }
            .grid-achievements {
                display: grid;
                grid-template-columns: repeat(1, 1fr);
                gap: 32px;
                max-width: 1280px;
                margin: 0 auto;
                padding: 0 32px;
            }
            @media (min-width: 640px) {
                .grid-achievements { grid-template-columns: repeat(2, 1fr); }
            }
            @media (min-width: 1024px) {
                .grid-achievements { grid-template-columns: repeat(3, 1fr); }
            }
            /* ---- Locked (unearned) card styles ---- */
            .achievement-container.locked {
                cursor: default;
                opacity: 0.85;
            }
            .achievement-card.locked-card {\n                background: #f5f5f4;\n                border-color: #e5e5e4;\n                position: relative;\n                overflow: hidden;\n            }\n            .achievement-card.locked-card .badge-icon-wrap {\n                filter: blur(5px) brightness(0.75);\n            }\n            .achievement-badge-img.locked-img {\n                box-shadow: none;\n                border-color: #d4d4d4;\n            }\n            .achievement-card.locked-card .achievement-card-text {\n                filter: blur(3px);\n                pointer-events: none;\n            }\n            /* --- Locked blur overlay --- */\n            .lock-blur-overlay {\n                position: absolute;\n                inset: 0;\n                z-index: 10;\n                display: flex;\n                flex-direction: column;\n                align-items: center;\n                justify-content: center;\n                gap: 8px;\n                pointer-events: none;\n            }\n            .lock-blur-overlay .lock-icon-circle {\n                background: rgba(255,255,255,0.85);\n                backdrop-filter: blur(6px);\n                width: 48px;\n                height: 48px;\n                border-radius: 50%;\n                display: flex;\n                align-items: center;\n                justify-content: center;\n                font-size: 1.2rem;\n                color: #a3a3a3;\n                box-shadow: 0 4px 12px rgba(0,0,0,0.08);\n            }\n            .lock-blur-overlay .unlock-message {\n                background: rgba(255,255,255,0.9);\n                backdrop-filter: blur(6px);\n                padding: 8px 16px;\n                border-radius: 100px;\n                font-size: 0.65rem;\n                font-weight: 800;\n                text-transform: uppercase;\n                letter-spacing: 1.5px;\n                color: #78716c;\n                text-align: center;\n                max-width: 180px;\n                box-shadow: 0 4px 12px rgba(0,0,0,0.08);\n            }
            .achievement-name-locked {
                color: #a3a3a3 !important;
                font-size: 1.25rem;
                font-style: italic;
            }
            .unlock-condition-text {
                font-size: 0.75rem;
                color: #78716c;
                font-weight: 600;
                margin-top: 8px;
                padding: 6px 12px;
                background: rgba(120, 113, 108, 0.08);
                border-radius: 100px;
                display: inline-block;
                letter-spacing: 0.3px;
            }
            .lock-overlay-icon {
                position: absolute;
                top: 16px;
                right: 16px;
                z-index: 5;
                width: 36px;
                height: 36px;
                background: rgba(168, 162, 158, 0.25);
                border-radius: 50%;
                display: flex;
                align-items: center;
                justify-content: center;
                color: #a8a29e;
                font-size: 1rem;
                backdrop-filter: blur(4px);
            }
            .no-icon-placeholder {
                width: 140px;
                height: 140px;
                border-radius: 50%;
                display: flex;
                align-items: center;
                justify-content: center;
                font-size: 3rem;
                background: #fef3c7;
                border: 4px solid white;
            }
            .no-icon-placeholder.locked-placeholder {
                background: #e5e5e4;
                filter: grayscale(1);
                opacity: 0.5;
            }
        </style>
        <div class="profile-hero-mini">
            <h1 class="text-4xl font-black uppercase tracking-tighter italic">Nectar Artefacts</h1>
            <p class="opacity-90 font-medium text-sm tracking-widest mt-2 uppercase">Unlock your garden milestones</p>
        </div>
        <div class="grid-achievements" id="achievementsGrid">
            ${cardsHtml}
        </div>
    `;
}

function attachAchievement3DEffects(container) {
    if (!container) return;
    const cards = container.querySelectorAll('.achievement-container.earned .achievement-card');
    cards.forEach(card => {
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

    const modal   = document.getElementById('achievementModal');
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

    const filteredTasks = tasks.filter(task => allowedStages.includes(task.stage));

    const themeColorMap = {};
    themes.forEach(t => { themeColorMap[t.theme_id] = t.primary_color || '#F59E0B'; });

    return filteredTasks.map(task => ({
        ...task,
        primary_color: themeColorMap[task.theme_id] || '#F59E0B'
    }));
}

// ======================== BOTTOM SHEET ========================
function showBottomSheet(title, contentHtml, onClose) {
    const existing = document.querySelector('.bottom-sheet-overlay');
    if (existing) existing.remove();

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

    const closeBtn = overlay.querySelector('.bottom-sheet-close');
    const close = () => {
        overlay.classList.remove('active');
        setTimeout(() => overlay.remove(), 300);
        if (onClose) onClose();
    };
    closeBtn.addEventListener('click', close);
    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) close();
    });

    overlay.offsetHeight;
    overlay.classList.add('active');
    return overlay;
}

function closeAllBottomSheets() {
  const sheets = document.querySelectorAll('.bottom-sheet-overlay');
  sheets.forEach(sheet => {
    sheet.classList.remove('active');
    sheet.style.visibility = 'hidden';
    sheet.style.opacity = '0';
  });
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
        el.onclick = (e) => handleComment(e.target);
    });
    container.querySelectorAll('.edit-comment-btn').forEach(el => {
        el.onclick = (e) => handleEditComment(e.target);
    });
    container.querySelectorAll('.delete-comment-btn').forEach(el => {
        el.onclick = (e) => handleDeleteComment(e.target);
    });
}

// ======================== TASK RENDERING ========================
async function refreshTasks() {
    const now = new Date();
    const joinDate = new Date(userProfile.join_date);
    const daysSinceJoin = Math.floor((now - joinDate) / (1000 * 60 * 60 * 24));

    const tasksWithUnlock = baseTasks.map(task => {
        const minDays = stageGuardrails[task.theme_id]?.[task.stage]?.min_days ?? 0;
        const effectiveDays = Math.max(0, daysSinceJoin - minDays);
        const maxAllowedOrder = effectiveDays + 1;
        const isUnlocked = task.task_order <= maxAllowedOrder;

        let unlockMessage = '';
        if (!isUnlocked) {
            const daysNeeded = task.task_order - 1 - effectiveDays;
            if (daysNeeded > 0) {
                unlockMessage = `🔒 Unlocks in ${daysNeeded} day(s) (after ${minDays + task.task_order - 1} days total)`;
            } else {
                unlockMessage = '🔒 Unlocks soon';
            }
        }
        return { ...task, is_unlocked: isUnlocked, unlock_message: unlockMessage };
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
    const unlockedAll = filteredWithCompleted.filter(t => t.is_unlocked);
    const unlockedShown = filtered.filter(t => t.is_unlocked);
    const lockedTasks = filtered.filter(t => !t.is_unlocked);

    totalVisibleTasks = unlockedAll.length;
    completedVisibleTasks = unlockedAll.filter(t => completedSet.has(t.id)).length;

    const tasksToShow = [...unlockedShown, ...lockedTasks];
    renderTaskList(tasksToShow);

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
}

function renderTaskList(tasks) {
    const container = document.getElementById('tasks');
    if (!container) return;

    if (!tasks.length) {
        container.innerHTML = '<p class="tiny muted" style="padding:20px;">No missions available with current filters.</p>';
        return;
    }

    container.innerHTML = '';
    tasks.forEach(task => {
        const taskDiv = createTaskCard(task);
        container.appendChild(taskDiv);
    });
    attachTaskEventListeners(container);
}

function createTaskCard(task) {
    const isLocked = !task.is_unlocked;
    const completedSet = showingExperienced ? completedExperienced : completedNovice;
    const isCompleted = completedSet.has(task.id);
    const currentReaction = userReactions[task.id];
    const taskComments = userComments.filter(c => c.task_id === task.id);

    const primaryColor = task.primary_color;
    const rgbaBg = hexToRgba(primaryColor, 0.08);
    const rgbaBorder = hexToRgba(primaryColor, 0.25);

    const stagePill = `<span style="background:#f1f7ff; color:#3b82f6; border:1px solid #dbeafe; padding:2px 8px; border-radius:12px;">${task.stage || 'Stage'}</span>`;
    const corePill = `<span style="background:#3b82f6; color:white; padding:2px 8px; border-radius:12px;">${task.core_theme || 'Theme'}</span>`;
    const subcategoryPill = `<span style="background:#f0fdf4; color:#15803d; border:1px solid #dcfce7; padding:2px 8px; border-radius:12px;">${task.category || 'Subcategory'}</span>`;
    const audiencePill = `<span style="background:#f3f0ff; color:#7c3aed; border:1px solid #ede9fe; padding:2px 8px; border-radius:12px;">${task.audience || 'All'}</span>`;

    const description = showingExperienced ? (task.experienced_description || task.task_description) : (task.novice_description || task.task_description);

    const likeBtnColor = (currentReaction === 'like') ? '#22c55e' : (isLocked ? '#ccc' : '#ffcc00');
    const dislikeBtnColor = (currentReaction === 'dislike') ? '#ef4444' : (isLocked ? '#ccc' : '#ffcc00');
    const likeTextColor = (currentReaction === 'like') ? 'white' : (isLocked ? '#666' : '#1e293b');
    const dislikeTextColor = (currentReaction === 'dislike') ? 'white' : (isLocked ? '#666' : '#1e293b');

    let leftColumn = '';
    if (isLocked) {
        leftColumn = `<div style="margin-right: 15px;"><i class="fas fa-lock" style="font-size: 1.4rem; color: ${primaryColor};"></i></div>`;
    } else if (isCompleted) {
        leftColumn = `<div style="margin-right: 15px;"><i class="fas fa-check-circle" style="color: var(--success); font-size: 1.4rem;"></i></div>`;
    } else {
        leftColumn = `<div style="margin-right: 15px;">
            <input type="checkbox" class="task-check" data-id="${task.id}" data-version="${showingExperienced ? 'experienced' : 'novice'}"
                style="width: 24px; height: 24px; cursor: pointer;">
        </div>`;
    }

    const taskDiv = document.createElement('div');
    taskDiv.style.marginBottom = "20px";
    taskDiv.style.position = "relative";

    const cardHtml = `
        <div style="border-radius: 24px; background: ${rgbaBg}; border: 1px solid ${rgbaBorder}; box-shadow: 0 4px 12px rgba(0,0,0,0.02); transition: all 0.2s ease;">
            <div style="display: flex; align-items: center; padding: 20px;">
                ${leftColumn}
                <div style="flex-grow: 1;">
                    <div style="font-weight: 800; font-size: 1.05rem; color: var(--fg);">
                        ${task.task_title || 'Task'}
                    </div>
                    <div style="font-size: 0.9rem; margin: 6px 0; color: var(--fg-muted);">
                        ${description}
                    </div>
                    <div style="display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 8px;">
                        ${corePill}
                        ${stagePill}
                        ${audiencePill}
                        ${subcategoryPill}
                    </div>
                    <div style="font-size: 0.8rem; font-style: italic; color: var(--fg-muted);">
                        <strong>Impact :</strong> ${task.impact_value || 'N/A'}. 
                        ${isLocked ? '<span class="tiny muted">(Locked – complete previous tasks first)</span>' : ''}
                    </div>
                </div>
                <div style="display: flex; flex-direction: column; gap: 8px;">
                    <button class="react-btn" data-id="${task.id}" data-type="like" 
                        style="background:${likeBtnColor}; color:${likeTextColor}; border:none; padding:8px 16px; border-radius:12px; font-weight:600; cursor:pointer; transition:all 0.2s; ${isLocked ? 'opacity:0.6; cursor:not-allowed;' : ''}" ${isLocked ? 'disabled' : ''}>👍 Like</button>
                    <button class="react-btn" data-id="${task.id}" data-type="dislike" 
                        style="background:${dislikeBtnColor}; color:${dislikeTextColor}; border:none; padding:8px 16px; border-radius:12px; font-weight:600; cursor:pointer; transition:all 0.2s; ${isLocked ? 'opacity:0.6; cursor:not-allowed;' : ''}" ${isLocked ? 'disabled' : ''}>👎 Dislike</button>
                </div>
            </div>
            <div style="padding: 0 20px 20px 68px; border-top: 1px solid ${rgbaBorder};">
                <div class="comments-list">${taskComments.map(c => `
                    <div id="comment-box-${c.id}" style="background: rgba(255,255,255,0.5); padding:8px 12px; border-radius:12px; margin-bottom:8px;">
                        <div>${escapeHtml(c.comment_text)}</div>
                        <div><button style="background:none;border:none;color:var(--cta);cursor:pointer;font-size:0.8rem;" data-comment-id="${c.id}" class="edit-comment-btn">Edit</button>
                        <button style="background:none;border:none;color:#ef4444;cursor:pointer;font-size:0.8rem;" data-comment-id="${c.id}" class="delete-comment-btn">Delete</button></div>
                    </div>
                `).join('')}</div>
                <div style="display: flex; gap: 10px; margin-top: 8px;">
                    <input type="text" class="comment-input" data-id="${task.id}" placeholder="Write a comment..." style="flex-grow:1; padding:8px; border:1px solid ${rgbaBorder}; border-radius:12px; background: rgba(255,255,255,0.5);" ${isLocked ? 'disabled' : ''}>
                    <button class="comment-btn" data-id="${task.id}" style="background:${primaryColor}; color:white; padding:8px 16px; border-radius:12px; font-weight:600; border:none; cursor:pointer;" ${isLocked ? 'disabled' : ''}>Post</button>
                </div>
            </div>
        </div>
    `;

    if (isLocked) {
        const overlay = document.createElement('div');
        overlay.style.position = "absolute";
        overlay.style.top = "0";
        overlay.style.left = "0";
        overlay.style.width = "100%";
        overlay.style.height = "100%";
        overlay.style.backgroundColor = "rgba(0,0,0,0.7)";
        overlay.style.borderRadius = "24px";
        overlay.style.display = "flex";
        overlay.style.flexDirection = "column";
        overlay.style.alignItems = "center";
        overlay.style.justifyContent = "center";
        overlay.style.color = "white";
        overlay.style.textAlign = "center";
        overlay.style.padding = "20px";
        overlay.style.zIndex = "2";
        overlay.style.backdropFilter = "blur(2px)";
        overlay.innerHTML = `
            <i class="fas fa-lock" style="font-size: 48px; margin-bottom: 16px;"></i>
            <strong>${task.unlock_message}</strong>
            <p class="tiny" style="margin-top: 8px;">Complete tasks in this theme to unlock</p>
        `;
        taskDiv.innerHTML = cardHtml;
        taskDiv.appendChild(overlay);
    } else {
        taskDiv.innerHTML = cardHtml;
    }

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

        if (version === 'novice') completedNovice.add(taskId);
        else completedExperienced.add(taskId);

        const pointsEarned = result.points_earned;
        userProfile.total_points = (userProfile.total_points || 0) + pointsEarned;
        userProfile.nectar_points = userProfile.total_points;
        userProfile.experience = userProfile.total_points % 100;
        userProfile.user_level = result.new_user_level;
        userProfile.engagement_level = result.new_engagement_level;

        if (result.awarded_milestones && result.awarded_milestones.length) {
            result.awarded_milestones.forEach(m => {
                showToast(`🏆 ${m.name} unlocked!`, 'success');
            });
        }
        if (result.awarded_tokens && result.awarded_tokens.length) {
            result.awarded_tokens.forEach(t => {
                showToast(`🎁 New token: ${t.token_name} (${t.stage})`, 'success');
            });
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

        const openBottomSheet = document.querySelector('.bottom-sheet-overlay');
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
                const unlockedAll = allTasksWithCompleted.filter(t => t.is_unlocked);
                const completedVisible = unlockedAll.filter(t => completedSet.has(t.id)).length;
                const totalVisible = unlockedAll.length;
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

    const taskCard = btn.closest('.task') || btn.closest('[style*="border-radius"]').parentElement;
    if (taskCard) {
        const likeBtn = taskCard.querySelector(`.react-btn[data-id="${taskId}"][data-type="like"]`);
        const dislikeBtn = taskCard.querySelector(`.react-btn[data-id="${taskId}"][data-type="dislike"]`);
        if (likeBtn) {
            likeBtn.style.background = reactionType === 'like' ? '#22c55e' : '#ffcc00';
            likeBtn.style.color = reactionType === 'like' ? 'white' : '#1e293b';
        }
        if (dislikeBtn) {
            dislikeBtn.style.background = reactionType === 'dislike' ? '#ef4444' : '#ffcc00';
            dislikeBtn.style.color = reactionType === 'dislike' ? 'white' : '#1e293b';
        }
    }
}

async function handleComment(btn) {
    const taskId = btn.dataset.id;
    const input = document.querySelector(`.comment-input[data-id="${taskId}"]`);
    if (!input.value.trim()) return;
    await supabase.from('task_comments').insert([{
        user_id: userProfile.id,
        task_id: taskId,
        comment_text: input.value.trim()
    }]);
    refreshTasks();
}

async function handleEditComment(btn) {
    const commentId = btn.dataset.commentId;
    const commentDiv = document.getElementById(`comment-box-${commentId}`);
    const textDiv = commentDiv?.querySelector('div:first-child');
    if (!textDiv) return;
    const newText = prompt('Edit your comment:', textDiv.textContent);
    if (!newText || newText.trim() === '') return;
    const { error } = await supabase.from('task_comments').update({ comment_text: newText.trim() }).eq('id', commentId).eq('user_id', userProfile.id);
    if (error) { showToast('Failed to edit comment', 'error'); return; }
    refreshTasks();
}

async function handleDeleteComment(btn) {
    const commentId = btn.dataset.commentId;
    if (!confirm('Delete this comment?')) return;
    const { error } = await supabase.from('task_comments').delete().eq('id', commentId).eq('user_id', userProfile.id);
    if (error) { showToast('Failed to delete comment', 'error'); return; }
    refreshTasks();
}

// ======================== UI UPDATES ========================
function updateProfileUI() {
    const totalPoints = userProfile.total_points || 0;
    const nectarEarned = Math.floor(totalPoints / 100);
    const progressToNext = totalPoints % 100;
    const percent = progressToNext;
    const tier = userProfile.tier || 'free';

    const userNameShort = document.getElementById('userNameDisplayShort');
    if (userNameShort) userNameShort.innerText = `${userProfile.first_name} ${userProfile.last_name}`;

    const rankCompact = document.getElementById('rankNameDisplayCompact');
    if (rankCompact) rankCompact.innerText = `Meadow Level ${userProfile.member_tier || 0}`;

    const tierCompact = document.getElementById('userTierBadgeCompact');
    if (tierCompact) tierCompact.innerText = tier === 'free' ? 'Free' : tier === 'plus' ? 'Meadow+' : 'Steward';

    const pointsVal = document.getElementById('pointsVal');
    if (pointsVal) pointsVal.innerText = nectarEarned;

    const rankLevel = document.getElementById('rankLevel');
    if (rankLevel) rankLevel.innerText = `#${userProfile.member_tier || 0}`;

    const expText = document.getElementById('expText');
    if (expText) expText.innerText = `${progressToNext}/100 towards next Nectar`;

    const nectarDisplay = document.getElementById('nectarPointsDisplay');
    if (nectarDisplay) nectarDisplay.innerText = nectarEarned;

    const experienceBar = document.getElementById('experienceBar');
    if (experienceBar) experienceBar.value = progressToNext;

    const knobEl = document.getElementById('customProgressKnob');
    if (knobEl) knobEl.style.left = `${percent}%`;

    const mobilePointsVal = document.getElementById('mobilePointsVal');
    if (mobilePointsVal) mobilePointsVal.innerText = totalPoints;

    const mobileRankLevel = document.getElementById('mobileRankLevel');
    if (mobileRankLevel) mobileRankLevel.innerText = `#${userProfile.member_tier || 0}`;

    const mobileExpBar = document.getElementById('mobileExperienceBar');
    const mobileExpText = document.getElementById('mobileExpText');
    if (mobileExpBar && mobileExpText) {
        mobileExpBar.value = progressToNext;
        mobileExpText.innerText = `${progressToNext}/100`;
    }

    const mobileRankDisplay = document.getElementById('mobileRankDisplay');
    if (mobileRankDisplay) mobileRankDisplay.innerText = `Meadow Level ${userProfile.member_tier || 0}`;

    const mobileTierBadge = document.querySelector('.mobile-hero .tier-badge');
    if (mobileTierBadge) mobileTierBadge.innerText = tier === 'free' ? 'Free' : tier === 'plus' ? 'Meadow+' : 'Steward';

    const avatarImg = document.getElementById('profileAvatar');
    if (avatarImg && userProfile.avatar_url) {
        avatarImg.src = userProfile.avatar_url;
    }
}
function showCustomLevelModal(newLevel) {
    const modal = document.getElementById('achieveModal');
    const img = document.getElementById('modalImg');
    img.src = 'https://api.dicebear.com/9.x/fun-emoji/svg?seed=LevelUp';
    modal.style.display = 'flex';
    const shareBtn = modal.querySelector('.btn');
    shareBtn.innerText = 'Continue';
    shareBtn.onclick = () => modal.style.display = 'none';
    const closeBtn = modal.querySelector('.close-modal-btn');
    closeBtn.onclick = () => modal.style.display = 'none';
}

// ======================== FILTERS ========================
function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

function buildFilterOptionHtml(val, checked = false) {
    return `<label class="filter-item">
        <input type="checkbox" value="${escapeHtml(val)}" ${checked ? 'checked' : ''}>
        <span>${escapeHtml(val)}</span>
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
    const unlockedTasks = sourceTasks.filter(t => t.is_unlocked);
    const completedSet = showingExperienced ? completedExperienced : completedNovice;
    const completedVisible = unlockedTasks.filter(t => completedSet.has(t.id)).length;
    const totalVisible = unlockedTasks.length;
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
            const unlockedAll = filteredAll.filter(t => t.is_unlocked);
            const completedSet = showingExperienced ? completedExperienced : completedNovice;
            const total = unlockedAll.length;
            const completed = unlockedAll.filter(t => completedSet.has(t.id)).length;
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
                sheet.remove();
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
                width: 32px;
                height: 32px;
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
    showBottomSheet('Completed Tasks', html);
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
        return str.replace(/[&<>]/g, m => {
            if (m === '&') return '&amp;';
            if (m === '<') return '&lt;';
            if (m === '>') return '&gt;';
            return m;
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
            : `<div class="theme-icon-container no-image">📋</div>`;

        itemsHtml += `
            <div class="completed-task-card">
                <div class="theme-card-content">
                    ${iconHtml}
                    <div class="theme-text">
                        <div class="flex justify-between items-start">
                            <h4 class="theme-name">${escapeHtml(task.task_title)}</h4>
                            <span class="text-xs text-stone-500">${date}</span>
                        </div>
                        <div class="text-sm text-stone-500 mt-1">${version === 'novice' ? '🟦 Novice' : '🟧 Experienced'}</div>
                        <div class="text-sm text-stone-600 mt-1">${escapeHtml(description || '')}</div>
                        <div class="mt-2 font-bold text-emerald-600">+${points} pts</div>
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
</style>
        <div class="scrollable-list">
            ${itemsHtml}
        </div>
    `;

    return modalHtml;
}

async function openPendingSigmaModal() {
    Loader.show("Loading reflections...");
    let html;
    try {
        html = await generatePendingSigmaHtml();
    } finally {
        Loader.hide();
    }
    showBottomSheet('Tasks Reflection', html);
}

async function generatePendingSigmaHtml() {
    const pendingTaskIds = Array.from(completedNovice).concat(Array.from(completedExperienced))
        .filter(id => !loggedSigmaTasks.has(id));
    if (pendingTaskIds.length === 0) {
        return '<p class="tiny muted">No pending reflections.</p>';
    }
    const { data: tasks, error } = await supabase
        .from('tasks')
        .select('id, task_title, novice_description, experienced_description, stage, theme_id')
        .in('id', pendingTaskIds);
    if (error) return '<p class="tiny muted">Error loading tasks.</p>';

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
        return str.replace(/[&<>]/g, m => {
            if (m === '&') return '&amp;';
            if (m === '<') return '&lt;';
            if (m === '>') return '&gt;';
            return m;
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
            : `<div class="theme-icon-container no-image">📝</div>`;

        itemsHtml += `
            <div class="pending-sigma-card">
                <div class="theme-card-content">
                    ${iconHtml}
                    <div class="theme-text">
                        <h4 class="theme-name">${escapeHtml(task.task_title)}</h4>
                        <div class="text-sm text-stone-500 mt-1">${version === 'novice' ? '🟦 Novice' : '🟧 Experienced'}</div>
                        <div class="text-sm text-stone-600 mt-1">${escapeHtml(description || '')}</div>
                    </div>
                    <div class="self-center mr-4">
                        <button class="reflect-btn btn tiny" onclick="openTaskSigmaModal('${task.id}', '${escapeHtml(task.task_title)}')">Reflect</button>
                    </div>
                </div>
            </div>
        `;
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
</style>
        <div class="scrollable-list">
            ${itemsHtml}
        </div>
    `;

    return modalHtml;
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

async function openTaskSigmaModal(taskId, taskTitle) {
    const formHtml = `
        <form id="taskSigmaFormBottom">
            <input type="hidden" id="taskSigmaTaskIdBottom" value="${taskId}">
            <div style="margin-bottom: 16px;">
                <label class="tiny bold" style="display: block; margin-bottom: 8px;">What did you do?</label>
                <textarea id="taskSigmaDefineBottom" rows="2" placeholder="Describe the action you took..." style="width: 100%;"></textarea>
            </div>
            <div style="margin-bottom: 16px;">
                <label class="tiny bold" style="display: block; margin-bottom: 8px;">What did you learn?</label>
                <textarea id="taskSigmaMeasureBottom" rows="2" placeholder="What insights or lessons did you gain?" style="width: 100%;"></textarea>
            </div>
            <div style="margin-bottom: 16px;">
                <label class="tiny bold" style="display: block; margin-bottom: 8px;">What impact did you have?</label>
                <textarea id="taskSigmaAnalyseBottom" rows="2" placeholder="Describe the results or changes you observed." style="width: 100%;"></textarea>
            </div>
            <div style="margin-bottom: 16px;">
                <label class="tiny bold" style="display: block; margin-bottom: 8px;">Proof of completion (link or description)</label>
                <textarea id="taskSigmaImproveBottom" rows="2" placeholder="Add a photo link, screenshot, or brief proof." style="width: 100%;"></textarea>
            </div>
            <div style="margin-bottom: 24px;">
                <label class="tiny bold" style="display: block; margin-bottom: 8px;">What would you do differently?</label>
                <textarea id="taskSigmaControlBottom" rows="2" placeholder="How would you improve if you did it again?" style="width: 100%;"></textarea>
            </div>
            <button type="submit" class="btn btn-success" style="width: 100%;">Submit Reflection</button>
        </form>
    `;
    const sheet = showBottomSheet(`Reflect on: ${taskTitle}`, formHtml);
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
            const { error } = await supabase.from('task_sigma_logs').insert([{
                user_id: userProfile.id,
                task_id: taskIdVal,
                define: define || null,
                measure: measure || null,
                analysis: analysis || null,
                improve: improve || null,
                control: control || null
            }]);
            if (error) {
                console.error('Error saving task sigma log:', error);
                showToast('Failed to save reflection', 'error');
            } else {
                showToast('Reflection saved!', 'success');
                loggedSigmaTasks.add(taskIdVal);
                sheet.querySelector('.bottom-sheet-close').click();
                updatePendingSigmaBadge();
                const pendingSheet = document.querySelector('.bottom-sheet-overlay');
                if (pendingSheet && pendingSheet.querySelector('.bottom-sheet-header h3')?.innerText === 'Tasks Reflection') {
                    const newHtml = await generatePendingSigmaHtml();
                    pendingSheet.querySelector('.bottom-sheet-content').innerHTML = newHtml;
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
        return str.replace(/[&<>]/g, m => {
            if (m === '&') return '&amp;';
            if (m === '<') return '&lt;';
            if (m === '>') return '&gt;';
            return m;
        });
    };

    const checkboxesHtml = themes.map(theme => {
        const isChecked = selectedThemes.includes(theme.theme_id);
        const iconHtml = theme.visual_symbol_icon_idea
            ? `<div class="theme-icon-container">
                 <img src="${theme.visual_symbol_icon_idea}" alt="${theme.theme_name}">
               </div>`
            : `<div class="theme-icon-container no-image">🌱</div>`;

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
        sessionStorage.setItem('meadow_toast', JSON.stringify({message: `Tier updated to ${newTier}`, type: 'success'}));
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

  // Only show for paying tiers (plus, steward, collective) and if they have a subscription
  if (userProfile.member_tier === 0 || !userProfile.stripe_subscription_id) {
    container.style.display = 'none';
    return;
  }

  container.style.display = 'block';
  document.getElementById('subTier').innerText = tier === 'plus' ? 'Meadow+' : tier === 'steward' ? 'Steward' : 'Collective';

  if (periodEnd) {
    const renewDate = new Date(periodEnd).toLocaleDateString();
    document.getElementById('subRenewalDate').innerText = renewDate;
  }

  if (status === 'canceled' || cancelAtPeriodEnd) {
    const endDate = new Date(periodEnd).toLocaleDateString();
    document.getElementById('subscriptionCancelMsg').style.display = 'block';
    document.getElementById('subscriptionCancelMsg').innerHTML = `⚠️ Your subscription will end on ${endDate}. You will be downgraded to Free tier after that date.`;
    document.getElementById('cancelSubscriptionBtn').style.display = 'none';
  } else {
    document.getElementById('subscriptionCancelMsg').style.display = 'none';
    document.getElementById('cancelSubscriptionBtn').style.display = 'inline-block';
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
                            <option value="🌰 Seeds">🌰 Seeds</option>
                            <option value="🌱 Sprout">🌱 Sprout</option>
                            <option value="🌸 Bloom">🌸 Bloom</option>
                            <option value="🌾 Harvest">🌾 Harvest</option>
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
    // Show any toast persisted across page reload (e.g. tier upgrade)
    const pendingToast = sessionStorage.getItem('meadow_toast');
    if (pendingToast) {
        try {
            const { message, type } = JSON.parse(pendingToast);
            showToast(message, type || 'success');
        } catch(e) {}
        sessionStorage.removeItem('meadow_toast');
    }

    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) {
        window.location.replace(getBaseURL() + 'login.html');
        return;
    }

    Loader.show("Gathering your nectar...");

    try {
        const { data: profile, error: profileError } = await supabase
            .from('profiles')
            .select('*')
            .eq('id', user.id)
            .single();
        if (profileError) throw profileError;
        userProfile = profile;
        // Initialize decorator jar module
        try {
            const { initDecorator } = await import('./decorator.js');
            await initDecorator(userProfile);
        } catch (e) {
            console.warn('Decorator init skipped:', e.message);
        }
        if (!userProfile.tier) userProfile.tier = 'free';
        userProfile.total_points = userProfile.nectar_points;
        userProfile.experience = userProfile.total_points % 100;

        const tierNum = tierToNumber[userProfile.tier];

        const { data: userTasks, error: userTasksError } = await supabase
            .from('user_tasks')
            .select('task_id, version')
            .eq('user_id', user.id);
        if (userTasksError) throw userTasksError;

        completedNovice.clear();
        completedExperienced.clear();
        userTasks.forEach(t => {
            if (t.version === 'novice') completedNovice.add(t.task_id);
            else if (t.version === 'experienced') completedExperienced.add(t.task_id);
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

        const desktopMissions = document.getElementById('desktopMissionsBtn');
        if (desktopMissions) desktopMissions.addEventListener('click', () => openMissionsModal());
        const desktopAchievements = document.getElementById('desktopAchievementsBtn');
        if (desktopAchievements) desktopAchievements.addEventListener('click', () => loadAchievementsModal());
        const desktopCompleted = document.getElementById('completedTasksSection');
        if (desktopCompleted) desktopCompleted.addEventListener('click', () => openCompletedModal());
        const desktopPending = document.getElementById('pendingSigmaSection');
        if (desktopPending) desktopPending.addEventListener('click', () => openPendingSigmaModal());
        const desktopSigmaBtn = document.getElementById('addSigmaBtnDesktop');
        if (desktopSigmaBtn) desktopSigmaBtn.addEventListener('click', () => openSigmaModal());

        const mobileMissions = document.getElementById('mobileMissionsBtn');
        if (mobileMissions) mobileMissions.onclick = () => openMissionsModal();
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

        // Floating button for mobile (optional – not required if you use the left column button)
        const floatingBtn = document.getElementById('mobileFloatingMissionsBtn');
        if (floatingBtn) {
            const updateVisibility = () => {
                floatingBtn.style.display = window.innerWidth <= 767 ? 'flex' : 'none';
            };
            updateVisibility();
            window.addEventListener('resize', updateVisibility);
            floatingBtn.addEventListener('click', () => openMissionsModal());
        }

        // ========== NEW: Load subscription info and attach cancel button ==========
        await loadSubscriptionInfo();
        const cancelBtn = document.getElementById('cancelSubscriptionBtn');
        if (cancelBtn) {
            cancelBtn.addEventListener('click', cancelSubscription);
        }

    } catch (err) {
        console.error("Profile initialization failed:", err);
        let msg = "Failed to load profile data.";
        if (err.message?.includes("type")) msg = "Data type error — ensure the database schema matches the application.";
        else if (err.message?.includes("relation") || err.message?.includes("does not exist")) msg = "Database table not found — run the schema setup.";
        else if (err.message?.includes("JWT") || err.message?.includes("auth")) msg = "Authentication error — please log out and back in.";
        showToast(msg, "error");
    } finally {
        Loader.hide();
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