import { supabase } from './supabase-config.js';
import { showToast, Loader } from './app.js';

// ======================== HELPER FUNCTIONS ========================
function hexToRgba(hex, alpha) {
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
// ======================== END HELPER FUNCTIONS ========================

let allTasks = [];
let completedNovice = new Set();
let completedExperienced = new Set();
let loggedSigmaTasks = new Set();
let userProfile = null;
let userReactions = {};
let userComments = [];

let activeFilters = {
    core_theme: [],
    stage: [],
    subcategory: []
};

let showingExperienced = false;
let noviceModalShown = false;
let deadEndModalShown = false;
let bypassGuardrails = false;
let totalVisibleTasks = 0;
let completedVisibleTasks = 0;

const MILESTONE_THRESHOLDS = [ /* unchanged */ ];

const getBaseURL = () => {
    const { origin, pathname } = window.location;
    if (origin.includes('github.io')) {
        return `${origin}/Hive-Nectar-Website/`;
    }
    return `${origin}/`;
};

const stageTierMap = {
    'Seed': null,
    'Sprout': 'plus',
    'Bloom': 'steward'
};
const tierRank = { 'free': 0, 'plus': 1, 'steward': 2 };

// ======================== BOTTOM SHEET HELPER ========================
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
}

// ======================== INITIALIZATION ========================
export async function initProfile() {
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) {
        window.location.replace(getBaseURL() + 'login.html');
        return;
    }

    Loader.show("Gathering your nectar...");

    try {
        // Fetch profile
        const { data: profile, error: profileError } = await supabase
            .from('profiles')
            .select('*')
            .eq('id', user.id)
            .single();
        if (profileError) throw profileError;
        userProfile = profile;

        // Fetch user's completed tasks
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

        // Fetch reactions and comments
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

        // Fetch sigma logs
        const { data: sigmaLogs, error: sigmaLogsError } = await supabase
            .from('task_sigma_logs')
            .select('task_id')
            .eq('user_id', user.id);
        if (sigmaLogsError) throw sigmaLogsError;
        loggedSigmaTasks.clear();
        sigmaLogs.forEach(l => loggedSigmaTasks.add(l.task_id));

        // Fetch tasks via RPC
        const { data: tasks, error: tasksError } = await supabase.rpc('get_user_tasks', { p_user_id: user.id });
        if (tasksError) {
            console.error('RPC error:', tasksError);
            showToast('Failed to load tasks: ' + tasksError.message, 'error');
            allTasks = [];
        } else {
            console.log('Tasks loaded:', tasks);
            allTasks = tasks || [];
        }

        // Determine if we should show experienced
        const noviceTasks = allTasks.filter(t => !completedNovice.has(t.id));
        showingExperienced = (noviceTasks.length === 0 && allTasks.length > 0);

        // Setup filters and render
        setupMultiFilters();
        await applyFiltersAndRender();

        // Setup UI helpers
        setupLogout();
        setupTierSimulator();

        // Override modal handlers with bottom sheet
        window.openMissionsModal = openMissionsModal;
        window.loadAchievementsModal = loadAchievementsModal;
        window.openCompletedModal = openCompletedModal;
        window.openPendingSigmaModal = openPendingSigmaModal;
        window.openSigmaModal = openSigmaModal;
        window.openTaskSigmaModal = openTaskSigmaModal;  // new bottom sheet for task reflection
        window.loadCompletedTasks = openCompletedModal;
        window.loadPendingSigmaTasks = openPendingSigmaModal;

        // Attach desktop button handlers
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

        // Mobile buttons (already have ids, we'll reassign to bottom sheet functions)
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

        // Check milestones for display
        await checkMilestones();

        setThemeFromTier();

        // Admin simulator
        if (userProfile.email === 'anhishgautam@gmail.com') {
            const mobileSim = document.getElementById('mobileTierSimulator');
            if (mobileSim) mobileSim.style.display = 'block';
        }

        // Mobile logout
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

        // Mobile tier simulator
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
                    await checkMilestones();
                } else {
                    showToast('Failed to update influence', 'error');
                }
            });
        }

        // Update mobile badge counts
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

    } catch (err) {
        console.error("Profile initialization failed:", err);
        showToast("Failed to load profile data.", "error");
    } finally {
        Loader.hide();
    }
}

function setThemeFromTier() {
    const tier = userProfile.tier || 'free';
    let theme = 'classic';
    if (tier === 'plus') theme = 'gold';
    else if (tier === 'steward') theme = 'dark';
    document.body.setAttribute('data-theme', theme);
    localStorage.setItem('hive-theme', theme);
}

// ======================== TASK RENDERING ========================
async function refreshTasks() {
    const { data: tasks, error } = await supabase.rpc('get_user_tasks', { p_user_id: userProfile.id });
    if (error) {
        console.error("Failed to refresh tasks:", error);
        showToast("Could not refresh tasks", "error");
        return;
    }
    allTasks = tasks || [];
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

    const completedSet = showingExperienced ? completedExperienced : completedNovice;
    const unlockedTasks = filtered.filter(t => t.is_unlocked);
    const lockedTasks = filtered.filter(t => !t.is_unlocked);

    totalVisibleTasks = unlockedTasks.length;
    completedVisibleTasks = unlockedTasks.filter(t => completedSet.has(t.id)).length;

    const tasksToShow = [...unlockedTasks, ...lockedTasks];
    renderTaskList(tasksToShow);

    const pct = totalVisibleTasks ? Math.min(Math.round((completedVisibleTasks / totalVisibleTasks) * 100), 100) : 0;
    const progressBar = document.getElementById('progressBar');
    const progressPct = document.getElementById('progressPct');
    if (progressBar) progressBar.value = pct;
    if (progressPct) progressPct.innerText = `${pct}% (${completedVisibleTasks}/${totalVisibleTasks})`;

    const mobileProgressBar = document.getElementById('mobileProgressBar');
    const mobileProgressPct = document.getElementById('mobileProgressPct');
    if (mobileProgressBar && mobileProgressPct) {
        mobileProgressBar.value = pct;
        mobileProgressPct.innerText = `${pct}% (${completedVisibleTasks}/${totalVisibleTasks})`;
    }

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

        const versionBadge = !showingExperienced
            ? '<span style="background:#3b82f6; color:white; padding:2px 8px; border-radius:12px; font-size:0.7rem; margin-left:8px;">Novice</span>'
            : '<span style="background:#f59e0b; color:white; padding:2px 8px; border-radius:12px; font-size:0.7rem; margin-left:8px;">Experienced</span>';

        // Colors for like/dislike buttons (green for like, red for dislike)
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
        taskDiv.innerHTML = `
            <div style="border-radius: 24px; background: ${rgbaBg}; border: 1px solid ${rgbaBorder}; box-shadow: 0 4px 12px rgba(0,0,0,0.02); transition: all 0.2s ease;">
                <div style="display: flex; align-items: center; padding: 20px;">
                    ${leftColumn}
                    <div style="flex-grow: 1;">
                        <div style="font-weight: 800; font-size: 1.05rem; color: var(--fg);">
                            ${task.task_title || 'Task'} ${versionBadge}
                        </div>
                        <div style="font-size: 0.9rem; margin: 6px 0; color: var(--fg-muted);">
                            ${task.task_description || ''}
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
                            <div>${c.comment_text}</div>
                            <div><button onclick="window.startEditComment('${c.id}', '${c.comment_text.replace(/'/g, "\\'")}')">Edit</button>
                            <button onclick="window.deleteComment('${c.id}')">Delete</button></div>
                        </div>
                    `).join('')}</div>
                    <div style="display: flex; gap: 10px; margin-top: 8px;">
                        <input type="text" class="comment-input" data-id="${task.id}" placeholder="Write a comment..." style="flex-grow:1; padding:8px; border:1px solid ${rgbaBorder}; border-radius:12px; background: rgba(255,255,255,0.5);" ${isLocked ? 'disabled' : ''}>
                        <button class="comment-btn" data-id="${task.id}" style="background:${primaryColor}; color:white; padding:8px 16px; border-radius:12px; font-weight:600; border:none; cursor:pointer;" ${isLocked ? 'disabled' : ''}>Post</button>
                    </div>
                </div>
            </div>
        `;
        container.appendChild(taskDiv);
    });

    container.querySelectorAll('.task-check:not([disabled])').forEach(el => {
        el.onchange = (e) => handleDone(e.target);
    });
    container.querySelectorAll('.react-btn:not([disabled])').forEach(el => {
        el.onclick = (e) => handleReact(e.target);
    });
    container.querySelectorAll('.comment-btn:not([disabled])').forEach(el => {
        el.onclick = (e) => handleComment(e.target);
    });
}

// ======================== TASK COMPLETION ========================
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

        userProfile.total_points = (userProfile.total_points || 0) + result.points_earned;
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

        // Refresh the main task list (desktop)
        await refreshTasks();

        // If there's a bottom sheet currently open for missions, update it in place
        const openBottomSheet = document.querySelector('.bottom-sheet-overlay');
        if (openBottomSheet) {
            const title = openBottomSheet.querySelector('.bottom-sheet-header h3')?.innerText;
            if (title === 'Daily Tasks') {
                // Re‑render the tasks inside the bottom sheet
                const tasksContainer = document.getElementById('mobileTasksContainerCopy');
                if (tasksContainer) {
                    renderMobileTasksInSheet('Copy', allTasks);
                    attachTaskEventListeners(tasksContainer);
                }
                // Update progress bar
                const unlockedTasks = allTasks.filter(t => t.is_unlocked);
                const completedSet = showingExperienced ? completedExperienced : completedNovice;
                const completedVisible = unlockedTasks.filter(t => completedSet.has(t.id)).length;
                const totalVisible = unlockedTasks.length;
                const pct = totalVisible ? Math.min(Math.round((completedVisible / totalVisible) * 100), 100) : 0;
                const progressBar = document.getElementById(`mobileProgressBarCopy`);
                const progressPct = document.getElementById(`mobileProgressPctCopy`);
                if (progressBar) progressBar.value = pct;
                if (progressPct) progressPct.innerText = `${pct}% (${completedVisible}/${totalVisible})`;
            }
        }

        updateProfileUI();

        if (result.new_user_level !== userProfile.user_level) {
            showCustomLevelModal(result.new_user_level);
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

// ======================== UI UPDATES ========================
function updateProfileUI() {
    const points = userProfile.total_points || 0;
    const doneCount = completedNovice.size + completedExperienced.size;
    const exp = points % 100;
    const tier = userProfile.tier || 'free';

    document.getElementById('userNameDisplay').innerText = `${userProfile.first_name} ${userProfile.last_name}`;
    document.getElementById('pointsVal').innerText = points;
    document.getElementById('rankLevel').innerText = `#${userProfile.member_tier || 0}`;
    document.getElementById('userTierBadge').innerText = tier === 'free' ? 'Free' : tier === 'plus' ? 'Hive+' : 'Steward';
    document.getElementById('experienceBar').value = exp;
    document.getElementById('expText').innerText = `${exp}/100 towards next Nectar`;
    document.getElementById('nectarPointsDisplay').innerText = points;

    const mobilePointsVal = document.getElementById('mobilePointsVal');
    if (mobilePointsVal) mobilePointsVal.innerText = points;
    const mobileRankLevel = document.getElementById('mobileRankLevel');
    if (mobileRankLevel) mobileRankLevel.innerText = `#${userProfile.member_tier || 0}`;
    const mobileExpBar = document.getElementById('mobileExperienceBar');
    const mobileExpText = document.getElementById('mobileExpText');
    if (mobileExpBar && mobileExpText) {
        mobileExpBar.value = exp;
        mobileExpText.innerText = `${exp}/100`;
    }
    const mobileRankDisplay = document.getElementById('mobileRankDisplay');
    if (mobileRankDisplay) mobileRankDisplay.innerText = `Hive Level ${userProfile.member_tier || 0}`;

    const mobileTierBadge = document.querySelector('.mobile-hero .tier-badge');
    if (mobileTierBadge) mobileTierBadge.innerText = tier === 'free' ? 'Free' : tier === 'plus' ? 'Hive+' : 'Steward';
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
    window.onclick = () => document.querySelectorAll('.dropdown-container').forEach(d => d.classList.remove('open'));
    updateFilterOptions(allTasks);
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
        listContainer.innerHTML = uniqueValues.map(val => `
            <label class="filter-item" style="display:flex; align-items:center; gap:10px; padding:10px; cursor:pointer; border-bottom:1px solid #e2e8f0; font-size:0.8rem;">
                <input type="checkbox" value="${val}" ${activeFilters[field].includes(val) ? 'checked' : ''}>
                <span>${val}</span>
            </label>
        `).join('');
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

// ======================== REACTIONS & COMMENTS ========================
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

    // Update local state
    userReactions[taskId] = reactionType;

    // Update the button styles for both like and dislike buttons in the same task container
    const taskCard = btn.closest('.task');
    if (taskCard) {
        const likeBtn = taskCard.querySelector(`.react-btn[data-id="${taskId}"][data-type="like"]`);
        const dislikeBtn = taskCard.querySelector(`.react-btn[data-id="${taskId}"][data-type="dislike"]`);

        if (likeBtn) {
            if (reactionType === 'like') {
                likeBtn.style.background = '#22c55e';
                likeBtn.style.color = 'white';
            } else {
                likeBtn.style.background = '#ffcc00';
                likeBtn.style.color = '#1e293b';
            }
        }

        if (dislikeBtn) {
            if (reactionType === 'dislike') {
                dislikeBtn.style.background = '#ef4444';
                dislikeBtn.style.color = 'white';
            } else {
                dislikeBtn.style.background = '#ffcc00';
                dislikeBtn.style.color = '#1e293b';
            }
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
    // Refresh tasks to show the new comment
    refreshTasks();
}

// ======================== COMMENT EDIT/DELETE (global) ========================
window.startEditComment = (id, oldText) => {
    const box = document.getElementById(`comment-box-${id}`);
    box.innerHTML = `
        <input type="text" id="edit-input-${id}" value="${oldText}" style="width:100%; padding:5px; border:1px solid #3b82f6; border-radius:4px;">
        <div style="margin-top:5px;">
            <button onclick="window.saveEditComment('${id}')" style="background:#22c55e; color:white; border:none; padding:3px 8px; border-radius:4px;">Save</button>
            <button onclick="window.cancelEditComment('${id}')" style="background:#64748b; color:white; border:none; padding:3px 8px; border-radius:4px;">Cancel</button>
        </div>
    `;
};
window.saveEditComment = async (id) => {
    const newText = document.getElementById(`edit-input-${id}`).value;
    if (!newText.trim()) return;
    await supabase.from('task_comments').update({ comment_text: newText }).eq('id', id);
    refreshTasks();
};
window.cancelEditComment = (id) => { refreshTasks(); };
window.deleteComment = async (id) => {
    if (confirm("Delete this comment?")) {
        await supabase.from('task_comments').delete().eq('id', id);
        refreshTasks();
    }
};

// ======================== BOTTOM SHEET FUNCTIONS ========================
async function openMissionsModal() {
    // Build the filter row HTML
    const filterRowHtml = `
        <div class="compact-filter-row" id="mobileFilterRowCopy">
            <div class="dropdown-container" id="mobileCoreFilterDropdownCopy">
                <span style="font-size: 0.7rem; font-weight: 700;">Theme:</span>
                <div class="dropdown-header"><span id="mobileCoreFilterSummaryCopy">All</span> <i class="fas fa-chevron-down"></i></div>
                <div class="dropdown-list" id="mobileCoreFilterListCopy"></div>
            </div>
            <div class="dropdown-container" id="mobileStageFilterDropdownCopy">
                <span style="font-size: 0.7rem; font-weight: 700;">Stage:</span>
                <div class="dropdown-header"><span id="mobileStageFilterSummaryCopy">All</span> <i class="fas fa-chevron-down"></i></div>
                <div class="dropdown-list" id="mobileStageFilterListCopy"></div>
            </div>
            <div class="dropdown-container" id="mobileTagFilterDropdownCopy">
                <span style="font-size: 0.7rem; font-weight: 700;">Tag:</span>
                <div class="dropdown-header"><span id="mobileTagFilterSummaryCopy">All</span> <i class="fas fa-chevron-down"></i></div>
                <div class="dropdown-list" id="mobileTagFilterListCopy"></div>
            </div>
        </div>
        <div class="progressWrap" style="margin: 12px 0;">
            <progress id="mobileProgressBarCopy" value="0" max="100" style="width: 100%; height: 8px;"></progress>
            <div style="text-align: right; margin-top: 4px;"><span id="mobileProgressPctCopy">0%</span></div>
        </div>
        <div id="mobileTasksContainerCopy"></div>
    `;

    const sheet = showBottomSheet('Daily Tasks', filterRowHtml);
    setTimeout(() => {
        populateMobileFilters('Copy');
        renderMobileTasksInSheet('Copy');
        attachMobileFilterListeners('Copy');
        const tasksContainer = document.getElementById('mobileTasksContainerCopy');
        if (tasksContainer) attachTaskEventListeners(tasksContainer);
    }, 50);
}

function populateMobileFilters(suffix) {
    const uniqueThemes = [...new Set(allTasks.map(t => t.core_theme).filter(Boolean))];
    const uniqueStages = [...new Set(allTasks.map(t => t.stage).filter(Boolean))];
    const uniqueTags = [...new Set(allTasks.map(t => t.subcategory).filter(Boolean))];

    const themeList = document.getElementById(`mobileCoreFilterList${suffix}`);
    const stageList = document.getElementById(`mobileStageFilterList${suffix}`);
    const tagList = document.getElementById(`mobileTagFilterList${suffix}`);

    if (themeList) {
        themeList.innerHTML = uniqueThemes.map(val => `
            <label class="filter-item"><input type="checkbox" value="${val}"> ${val}</label>
        `).join('');
    }
    if (stageList) {
        stageList.innerHTML = uniqueStages.map(val => `
            <label class="filter-item"><input type="checkbox" value="${val}"> ${val}</label>
        `).join('');
    }
    if (tagList) {
        tagList.innerHTML = uniqueTags.map(val => `
            <label class="filter-item"><input type="checkbox" value="${val}"> ${val}</label>
        `).join('');
    }
}

function attachMobileFilterListeners(suffix) {
    const themeContainer = document.getElementById(`mobileCoreFilterDropdownCopy`);
    const stageContainer = document.getElementById(`mobileStageFilterDropdownCopy`);
    const tagContainer = document.getElementById(`mobileTagFilterDropdownCopy`);

    // Setup dropdown toggle
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
        const filtered = allTasks.filter(t => {
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

function renderMobileTasksInSheet(suffix, tasks = allTasks) {
    const container = document.getElementById(`mobileTasksContainer${suffix}`);
    if (!container) return;
    const unlockedTasks = tasks.filter(t => t.is_unlocked);
    const completedSet = showingExperienced ? completedExperienced : completedNovice;
    const completedVisible = unlockedTasks.filter(t => completedSet.has(t.id)).length;
    const totalVisible = unlockedTasks.length;
    const pct = totalVisible ? Math.min(Math.round((completedVisible / totalVisible) * 100), 100) : 0;
    const progressBar = document.getElementById(`mobileProgressBarCopy`);
    const progressPct = document.getElementById(`mobileProgressPctCopy`);
    if (progressBar) progressBar.value = pct;
    if (progressPct) progressPct.innerText = `${pct}% (${completedVisible}/${totalVisible})`;

    if (!tasks.length) {
        container.innerHTML = '<p class="tiny muted">No missions available.</p>';
        return;
    }
    container.innerHTML = '';
    tasks.forEach(task => {
        const taskHtml = generateTaskHtml(task);
        container.appendChild(taskHtml);
    });
}

function generateTaskHtml(task) {
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

    const versionBadge = !showingExperienced
        ? '<span style="background:#3b82f6; color:white; padding:2px 8px; border-radius:12px; font-size:0.7rem; margin-left:8px;">Novice</span>'
        : '<span style="background:#f59e0b; color:white; padding:2px 8px; border-radius:12px; font-size:0.7rem; margin-left:8px;">Experienced</span>';

    // Colors for like/dislike buttons (green for like, red for dislike)
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
    taskDiv.innerHTML = `
        <div style="border-radius: 24px; background: ${rgbaBg}; border: 1px solid ${rgbaBorder}; box-shadow: 0 4px 12px rgba(0,0,0,0.02); transition: all 0.2s ease;">
            <div style="display: flex; align-items: center; padding: 20px;">
                ${leftColumn}
                <div style="flex-grow: 1;">
                    <div style="font-weight: 800; font-size: 1.05rem; color: var(--fg);">
                        ${task.task_title || 'Task'} ${versionBadge}
                    </div>
                    <div style="font-size: 0.9rem; margin: 6px 0; color: var(--fg-muted);">
                        ${task.task_description || ''}
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
                        <div>${c.comment_text}</div>
                        <div><button onclick="window.startEditComment('${c.id}', '${c.comment_text.replace(/'/g, "\\'")}')">Edit</button>
                        <button onclick="window.deleteComment('${c.id}')">Delete</button></div>
                    </div>
                `).join('')}</div>
                <div style="display: flex; gap: 10px; margin-top: 8px;">
                    <input type="text" class="comment-input" data-id="${task.id}" placeholder="Write a comment..." style="flex-grow:1; padding:8px; border:1px solid ${rgbaBorder}; border-radius:12px; background: rgba(255,255,255,0.5);" ${isLocked ? 'disabled' : ''}>
                    <button class="comment-btn" data-id="${task.id}" style="background:${primaryColor}; color:white; padding:8px 16px; border-radius:12px; font-weight:600; border:none; cursor:pointer;" ${isLocked ? 'disabled' : ''}>Post</button>
                </div>
            </div>
        </div>
    `;
    return taskDiv;
}

// ======================== BOTTOM SHEET FUNCTIONS FOR OTHER SECTIONS ========================
async function loadAchievementsModal() {
    const html = await generateAchievementsHtml();
    showBottomSheet('Achievements', html);
}

async function generateAchievementsHtml() {
    const { data: milestones, error } = await supabase
        .from('user_milestones')
        .select('milestone_id')
        .eq('user_id', userProfile.id);
    if (error || !milestones || milestones.length === 0) {
        return '<p class="tiny muted">No achievements yet. Keep going!</p>';
    }
    let html = '';
    milestones.forEach(ms => {
        const def = MILESTONE_THRESHOLDS.find(m => m.id === ms.milestone_id);
        if (!def) return;
        html += `
            <div class="milestone-badge" style="display:inline-block; margin:8px; text-align:center;" title="${def.name}">
                <i class="fas ${def.icon}" style="font-size:2.5rem; color:${def.color};"></i>
                <span class="tiny">${def.name}</span>
            </div>
        `;
    });
    return html;
}

async function openCompletedModal() {
    const html = await generateCompletedTasksHtml();
    showBottomSheet('Completed Tasks', html);
}

async function generateCompletedTasksHtml() {
    const { data: completed, error } = await supabase
        .from('user_tasks')
        .select(`task_id, version, points_awarded, completed_at, tasks ( task_title, novice_description, experienced_description, stage )`)
        .eq('user_id', userProfile.id)
        .order('completed_at', { ascending: false });
    if (error || !completed || completed.length === 0) {
        return '<p class="tiny muted">No completed tasks yet.</p>';
    }
    let html = '';
    completed.forEach(item => {
        const task = item.tasks;
        const version = item.version;
        const points = item.points_awarded;
        const date = new Date(item.completed_at).toLocaleDateString();
        const description = version === 'novice' ? task.novice_description : task.experienced_description;
        html += `
            <div style="border-bottom:1px solid var(--border); padding:10px 0;">
                <div style="display:flex; justify-content:space-between;">
                    <strong>${task.task_title}</strong>
                    <span class="tiny">${date}</span>
                </div>
                <div style="font-size:0.85rem;">${version === 'novice' ? '🟦 Novice' : '🟧 Experienced'}</div>
                <div style="font-size:0.8rem; margin:5px 0;">${description || ''}</div>
                <div style="font-weight:bold; color:var(--success);">+${points} pts</div>
            </div>
        `;
    });
    return html;
}

async function openPendingSigmaModal() {
    const html = await generatePendingSigmaHtml();
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
        .select('id, task_title, novice_description, experienced_description, stage')
        .in('id', pendingTaskIds);
    if (error) return '<p class="tiny muted">Error loading tasks.</p>';
    let html = '';
    tasks.forEach(task => {
        const version = completedNovice.has(task.id) ? 'novice' : 'experienced';
        const description = version === 'novice' ? task.novice_description : task.experienced_description;
        html += `
            <div style="border-bottom:1px solid var(--border); padding:12px 0; display:flex; justify-content:space-between; align-items:center; gap:12px;">
                <div style="flex-grow:1;">
                    <strong>${task.task_title}</strong>
                    <div style="font-size:0.8rem; margin-top:2px;">${version === 'novice' ? '🟦 Novice' : '🟧 Experienced'}</div>
                    <div style="font-size:0.8rem; margin:6px 0 0;">${description || ''}</div>
                </div>
                <button class="btn tiny" style="background:var(--cta); white-space:nowrap; color:#000;" onclick="window.openTaskSigmaModal('${task.id}', '${task.task_title.replace(/'/g, "\\'")}')">Reflect</button>
            </div>
        `;
    });
    return html;
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
                await checkMilestones();
            }
        });
    }
}

// ======================== TASK REFLECTION BOTTOM SHEET ========================
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
                // Refresh the pending sigma bottom sheet if open
                const pendingSheet = document.querySelector('.bottom-sheet-overlay');
                if (pendingSheet && pendingSheet.querySelector('.bottom-sheet-header h3')?.innerText === 'Tasks Reflection') {
                    const newHtml = await generatePendingSigmaHtml();
                    pendingSheet.querySelector('.bottom-sheet-content').innerHTML = newHtml;
                    // No need to attach listeners for buttons – they are regenerated with onclick attributes.
                }
                refreshTasks();
            }
        });
    }
}

// ======================== OTHER HELPERS ========================
async function upgradeTier(newTier) {
    let newMemberTier;
    if (newTier === 'plus') newMemberTier = 1;
    else if (newTier === 'steward') newMemberTier = 2;
    else newMemberTier = 0;

    const updates = { tier: newTier, member_tier: newMemberTier };
    const { error } = await supabase
        .from('profiles')
        .update(updates)
        .eq('id', userProfile.id);

    if (!error) {
        userProfile.tier = newTier;
        userProfile.member_tier = newMemberTier;
        showToast(`Tier updated to ${newTier}`, 'success');
        deadEndModalShown = false;
        updateProfileUI();
        await refreshTasks();
        await checkMilestones();
        setThemeFromTier();
    } else {
        showToast('Failed to update tier', 'error');
    }
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
                await checkMilestones();
            } else {
                showToast('Failed to update influence', 'error');
            }
        });
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

async function checkMilestones() {
    // Only used for display; actual awarding is done server-side
    return;
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
        completedNovice.clear();
        completedExperienced.clear();
        loggedSigmaTasks.clear();
        showingExperienced = false;
        noviceModalShown = false;
        deadEndModalShown = false;
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

// ======================== MODAL EVENT LISTENERS ========================
document.addEventListener('DOMContentLoaded', () => {
    const noviceYes = document.getElementById('noviceCompleteYesBtn');
    if (noviceYes) {
        noviceYes.addEventListener('click', async () => {
            showingExperienced = true;
            document.getElementById('noviceCompleteModal').style.display = 'none';
            noviceModalShown = false;
            await applyFiltersAndRender();
        });
    }
    const noviceLater = document.getElementById('noviceCompleteLaterBtn');
    if (noviceLater) {
        noviceLater.addEventListener('click', () => {
            document.getElementById('noviceCompleteModal').style.display = 'none';
            noviceModalShown = false;
        });
    }
    const deadEndRestart = document.getElementById('deadEndRestartBtn');
    if (deadEndRestart) deadEndRestart.addEventListener('click', restartProgress);
    const deadEndUpgrade = document.getElementById('deadEndUpgradeBtn');
    if (deadEndUpgrade) {
        deadEndUpgrade.addEventListener('click', () => {
            upgradeTier('plus');
            document.getElementById('deadEndModal').style.display = 'none';
            deadEndModalShown = false;
        });
    }
    const restartBtn = document.getElementById('restartBtn');
    if (restartBtn) restartBtn.addEventListener('click', restartProgress);
});

window.closeCompletedModal = () => {
    document.getElementById('completedModal').style.display = 'none';
};
window.closePendingSigmaModal = closePendingSigmaModal;
window.closeNoviceCompleteModal = () => {
    document.getElementById('noviceCompleteModal').style.display = 'none';
    noviceModalShown = false;
};
window.closeDeadEndModal = () => {
    document.getElementById('deadEndModal').style.display = 'none';
    deadEndModalShown = false;
};
window.closeSigmaModal = () => {
    document.getElementById('sigmaModal').style.display = 'none';
};
window.closeTaskSigmaModal = () => {
    document.getElementById('taskSigmaModal').style.display = 'none';
};
window.closeAchievementsModal = () => {
    document.getElementById('achievementsModal').style.display = 'none';
};