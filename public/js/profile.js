import { supabase } from './supabase-config.js';
import { showToast, Loader } from './app.js';

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

// Milestone definitions
const MILESTONE_THRESHOLDS = [
    { id: 'nectar_10', type: 'nectar', threshold: 10, name: '10 Nectar', icon: 'fa-coins', color: '#cd7f32' },
    { id: 'nectar_50', type: 'nectar', threshold: 50, name: '50 Nectar', icon: 'fa-coins', color: '#c0c0c0' },
    { id: 'nectar_100', type: 'nectar', threshold: 100, name: '100 Nectar', icon: 'fa-coins', color: '#ffd700' },
    { id: 'nectar_500', type: 'nectar', threshold: 500, name: '500 Nectar', icon: 'fa-coins', color: '#ffbf00' },
    { id: 'nectar_1000', type: 'nectar', threshold: 1000, name: '1000 Nectar', icon: 'fa-coins', color: '#e5e4e2' },
    { id: 'growth_10', type: 'growth', threshold: 10, name: '10 Tasks', icon: 'fa-seedling', color: '#6b8e23' },
    { id: 'growth_25', type: 'growth', threshold: 25, name: '25 Tasks', icon: 'fa-seedling', color: '#228b22' },
    { id: 'growth_50', type: 'growth', threshold: 50, name: '50 Tasks', icon: 'fa-seedling', color: '#006400' },
    { id: 'growth_100', type: 'growth', threshold: 100, name: '100 Tasks', icon: 'fa-seedling', color: '#2e8b57' },
    { id: 'member_30', type: 'member', threshold: 30, name: '30 Days', icon: 'fa-calendar-check', color: '#4682b4' },
    { id: 'member_100', type: 'member', threshold: 100, name: '100 Days', icon: 'fa-calendar-check', color: '#4169e1' },
    { id: 'member_365', type: 'member', threshold: 365, name: '1 Year', icon: 'fa-calendar-check', color: '#0f52ba' },
    { id: 'pollinator_5', type: 'pollinator', threshold: 5, name: '5 Referrals', icon: 'fa-bug', color: '#daa520' },
    { id: 'pollinator_10', type: 'pollinator', threshold: 10, name: '10 Referrals', icon: 'fa-bug', color: '#b8860b' },
    { id: 'pollinator_25', type: 'pollinator', threshold: 25, name: '25 Referrals', icon: 'fa-bug', color: '#8b4513' },
    { id: 'sigma_3', type: 'sigma', threshold: 3, name: '3 Sigma Logs', icon: 'fa-eye', color: '#6a5acd' }
];

const getBaseURL = () => {
    const { origin, pathname } = window.location;
    if (origin.includes('github.io')) {
        return `${origin}/Hive-Nectar-Website/`;
    }
    return `${origin}/`;
};

const stageTierMap = {
    '🌰 Seeds': null,
    '🌱 Sprout': 'plus',
    '🌸 Bloom': 'steward'
};
const tierRank = { 'free': 0, 'plus': 1, 'steward': 2 };

const stageMultiplier = { '🌰 Seeds': 1, '🌱 Sprout': 2, '🌸 Bloom': 3 };
const BASE_POINTS = 10;
const getTaskPoints = (task) => (stageMultiplier[task.stage] || 1) * BASE_POINTS;

// ----------------------------------------------------------------------
// Main initialization
// ----------------------------------------------------------------------
export async function initProfile() {
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) {
        window.location.replace(getBaseURL() + 'login.html');
        return;
    }

    Loader.show("Gathering your nectar...");

    try {
        const [profileRes, tasksRes, userTasksRes, feedbackRes, commentsRes, sigmaLogsRes, taskSigmaLogsRes] = await Promise.all([
            supabase.from('profiles').select('*').eq('id', user.id).single(),
            supabase.from('tasks').select('*'),
            supabase.from('user_tasks').select('task_id, version').eq('user_id', user.id),
            supabase.from('task_feedback').select('task_id, reaction').eq('user_id', user.id),
            supabase.from('task_comments').select('*').eq('user_id', user.id).order('created_at', { ascending: false }),
            supabase.from('sigma_logs').select('id').eq('user_id', user.id),
            supabase.from('task_sigma_logs').select('task_id').eq('user_id', user.id)
        ]);

        if (profileRes.error) throw profileRes.error;
        if (tasksRes.error) throw tasksRes.error;
        if (userTasksRes.error) throw userTasksRes.error;
        if (feedbackRes.error) throw feedbackRes.error;
        if (commentsRes.error) throw commentsRes.error;
        if (sigmaLogsRes.error) throw sigmaLogsRes.error;
        if (taskSigmaLogsRes.error) throw taskSigmaLogsRes.error;

        userProfile = profileRes.data;
        allTasks = tasksRes.data || [];
        userComments = commentsRes.data || [];

        completedNovice.clear();
        completedExperienced.clear();
        userTasksRes.data?.forEach(t => {
            if (t.version === 'novice') completedNovice.add(t.task_id);
            else if (t.version === 'experienced') completedExperienced.add(t.task_id);
        });

        loggedSigmaTasks.clear();
        taskSigmaLogsRes.data?.forEach(l => loggedSigmaTasks.add(l.task_id));

        userReactions = {};
        feedbackRes.data?.forEach(f => {
            userReactions[f.task_id] = f.reaction;
        });

        if (userProfile.member_tier === undefined || userProfile.member_tier === null) {
            userProfile.member_tier = 0;
        }

        const accessibleTasks = getAccessibleTasks();
        const noviceTasks = accessibleTasks.filter(t => !completedNovice.has(t.id));
        showingExperienced = (noviceTasks.length === 0 && accessibleTasks.length > 0);

        setupMultiFilters();
        await applyFiltersAndRender(); // This will call updateProfileUI at the end
        setupLogout();
        setupTierSimulator();

        window.loadCompletedTasks = loadCompletedTasks;
        window.loadPendingSigmaTasks = loadPendingSigmaTasks;
        window.loadAchievementsModal = loadAchievementsModal;
        updateCompletedBadge();
        updatePendingSigmaBadge();

        await checkMilestones();

        if (userProfile.tier === 'free' && !deadEndModalShown) {
            const allNoviceDone = accessibleTasks.every(t => completedNovice.has(t.id));
            const allExperiencedDone = accessibleTasks.every(t => completedExperienced.has(t.id));
            if (allNoviceDone && allExperiencedDone) {
                showDeadEndModal();
            }
        }

        setThemeFromTier();

        // Mobile simulator (admin only)
        if (userProfile.email === 'anhishgautam@gmail.com') {
            const mobileSim = document.getElementById('mobileTierSimulator');
            if (mobileSim) mobileSim.style.display = 'block';
        }

        // Mobile logout button
        const mobileLogout = document.getElementById('mobileLogoutBtn');
        if (mobileLogout) {
            mobileLogout.addEventListener('click', async () => {
                Loader.show("Safely signing you out...");
                try {
                    const { error } = await supabase.auth.signOut();
                    if (error) throw error;
                    window.location.replace('index.html');
                } catch (err) {
                    console.error("Logout Error:", err);
                    showToast("Error signing out. Please try again.", "error");
                    Loader.hide();
                }
            });
        }

        // Mobile tier simulator buttons
        const mobileTierSelect = document.getElementById('mobileTierSelect');
        const mobileUpdateTier = document.getElementById('mobileUpdateTierBtn');
        if (mobileTierSelect && mobileUpdateTier) {
            mobileTierSelect.value = userProfile.tier || 'free';
            mobileUpdateTier.addEventListener('click', async () => {
                const newTier = mobileTierSelect.value;
                await upgradeTier(newTier);
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
            const totalCompleted = completedNovice.size + completedExperienced.size;
            mobileCompletedBadge.innerText = totalCompleted;
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

function getAccessibleTasks() {
    const currentLevel = userProfile.member_tier || 0;
    const userTierRank = tierRank[userProfile.tier || 'free'];
    return allTasks.filter(task => {
        if (task.required_level > currentLevel) return false;
        const requiredTier = stageTierMap[task.stage];
        if (requiredTier && userTierRank < tierRank[requiredTier]) return false;
        return true;
    });
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
        .filter(taskId => !loggedSigmaTasks.has(taskId)).length;
    const badge = document.getElementById('pendingSigmaCountBadge');
    if (badge) badge.innerText = pendingCount;
    const mobileBadge = document.getElementById('mobilePendingSigmaBadge');
    if (mobileBadge) mobileBadge.innerText = pendingCount;
}

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
        showToast(`Tier updated to ${newTier} (level ${newMemberTier})`, 'success');
        deadEndModalShown = false;
        updateProfileUI();
        await applyFiltersAndRender();
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

    // Bypass guardrails checkbox
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
            applyFiltersAndRender();
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

function updateProfileUI() {
    const currentLevel = userProfile.member_tier || 0;
    const currentLevelTasks = allTasks.filter(t => t.required_level === currentLevel);
    const completedInLevel = currentLevelTasks.filter(t => completedNovice.has(t.id) || completedExperienced.has(t.id));
    const totalCurrentLevelTasks = currentLevelTasks.length;

    document.getElementById('userNameDisplay').innerText = `${userProfile.first_name} ${userProfile.last_name}`;
    document.getElementById('pointsVal').innerText = userProfile.nectar_points || 0;
    document.getElementById('rankLevel').innerText = `#${currentLevel}`;

    const mobileUserName = document.getElementById('mobileUserName');
    if (mobileUserName) mobileUserName.innerText = `${userProfile.first_name} ${userProfile.last_name}`;
    const mobileRankDisplay = document.getElementById('mobileRankDisplay');
    if (mobileRankDisplay) mobileRankDisplay.innerText = `Hive Level ${currentLevel}`;
    const mobilePointsVal = document.getElementById('mobilePointsVal');
    if (mobilePointsVal) mobilePointsVal.innerText = userProfile.nectar_points || 0;
    const mobileRankLevel = document.getElementById('mobileRankLevel');
    if (mobileRankLevel) mobileRankLevel.innerText = `#${currentLevel}`;

    const tier = userProfile.tier || 'free';
    const tierBadge = document.getElementById('userTierBadge');
    if (tierBadge) tierBadge.innerText = tier === 'free' ? 'Free' : tier === 'plus' ? 'Hive+' : 'Steward';

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

    const exp = userProfile.experience || 0;
    const expBar = document.getElementById('experienceBar');
    if (expBar) {
        expBar.value = exp;
        document.getElementById('expText').innerText = `${exp}/100 towards next Nectar`;
    }
    const mobileExpBar = document.getElementById('mobileExperienceBar');
    const mobileExpText = document.getElementById('mobileExpText');
    if (mobileExpBar && mobileExpText) {
        mobileExpBar.value = exp;
        mobileExpText.innerText = `${exp}/100`;
    }

    if (totalCurrentLevelTasks > 0 && completedInLevel.length >= totalCurrentLevelTasks) {
        handleLevelUp(currentLevel);
    }
}

async function handleLevelUp(completedLevel) {
    if (userProfile._levelingUp) return;
    userProfile._levelingUp = true;
    showCustomLevelModal(completedLevel, async () => {
        const nextLevel = completedLevel + 1;
        const { error } = await supabase.from('profiles')
            .update({ member_tier: nextLevel })
            .eq('id', userProfile.id);
        if (!error) {
            userProfile.member_tier = nextLevel;
            initProfile();
        }
        delete userProfile._levelingUp;
    });
}

function showCustomLevelModal(level, onConfirm) {
    const modal = document.getElementById('achieveModal');
    const img = document.getElementById('modalImg');
    img.src = 'https://api.dicebear.com/9.x/fun-emoji/svg?seed=Trophy';
    modal.style.display = 'flex';
    const shareBtn = modal.querySelector('.btn');
    shareBtn.innerText = 'Unlock New Tasks';
    shareBtn.onclick = () => {
        modal.style.display = 'none';
        onConfirm();
    };
    const closeBtn = modal.querySelector('.close-modal-btn');
    closeBtn.onclick = () => {
        modal.style.display = 'none';
    };
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
    window.onclick = () => document.querySelectorAll('.dropdown-container').forEach(d => d.classList.remove('open'));
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
        const newSelected = currentSelected.filter(val => uniqueValues.includes(val));
        activeFilters[field] = newSelected;
        listContainer.innerHTML = uniqueValues.map(val => `
            <label class="filter-item" style="display:flex; align-items:center; gap:10px; padding:10px; cursor:pointer; border-bottom:1px solid #e2e8f0; font-size:0.8rem;">
                <input type="checkbox" value="${val}" ${newSelected.includes(val) ? 'checked' : ''}>
                <span>${val}</span>
            </label>
        `).join('');
        summarySpan.innerText = newSelected.length > 0 ? `${newSelected.length} Selected` : "All";
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

async function canUnlockStage(themeId, targetStage) {
    if (bypassGuardrails) return true;
    const { data: guardrails, error: guardErr } = await supabase
        .from('theme_guardrails')
        .select('*')
        .eq('theme_id', themeId)
        .eq('stage', targetStage)
        .maybeSingle();
    if (guardErr || !guardrails) return false;

    const { data: tasks, error: tasksErr } = await supabase
        .from('user_tasks')
        .select(`
            task_id,
            completed_at,
            points_awarded,
            tasks!inner ( theme_id )
        `)
        .eq('user_id', userProfile.id)
        .eq('tasks.theme_id', themeId);
    if (tasksErr || !tasks || tasks.length === 0) return false;

    const dates = tasks.map(t => new Date(t.completed_at));
    const uniqueDays = new Set(dates.map(d => d.toDateString())).size;
    const uniqueTaskTypes = new Set(tasks.map(t => t.task_id)).size;
    const minDate = new Date(Math.min(...dates));
    const maxDate = new Date(Math.max(...dates));
    const spreadDays = Math.ceil((maxDate - minDate) / (1000 * 60 * 60 * 24));
    const totalNectar = tasks.reduce((sum, t) => sum + (t.points_awarded || 0), 0);
    return (
        uniqueDays >= guardrails.min_days &&
        uniqueTaskTypes >= guardrails.min_task_types &&
        spreadDays >= guardrails.min_spread_days &&
        totalNectar >= guardrails.min_nectar
    );
}

async function applyFiltersAndRender() {
    const accessibleTasks = getAccessibleTasks();
    const themes = [...new Set(accessibleTasks.map(t => t.theme_id))];
    const unlockedStages = {};

    for (const themeId of themes) {
        unlockedStages[themeId] = {};
        if (accessibleTasks.some(t => t.theme_id === themeId && t.stage === '🌱 Sprout')) {
            const requiredTier = stageTierMap['🌱 Sprout'];
            const userTierRank = tierRank[userProfile.tier || 'free'];
            if (!requiredTier || userTierRank >= tierRank[requiredTier]) {
                unlockedStages[themeId].Sprout = await canUnlockStage(themeId, 'Sprout');
            } else {
                unlockedStages[themeId].Sprout = false;
            }
        }
        if (accessibleTasks.some(t => t.theme_id === themeId && t.stage === '🌸 Bloom')) {
            const requiredTier = stageTierMap['🌸 Bloom'];
            const userTierRank = tierRank[userProfile.tier || 'free'];
            if (!requiredTier || userTierRank >= tierRank[requiredTier]) {
                unlockedStages[themeId].Bloom = await canUnlockStage(themeId, 'Bloom');
            } else {
                unlockedStages[themeId].Bloom = false;
            }
        }
    }

    let allPossibleTasks;
    if (!showingExperienced) {
        allPossibleTasks = accessibleTasks.map(task => ({
            ...task,
            version: 'novice',
            displayDescription: task.novice_description || task.task_description
        }));
    } else {
        allPossibleTasks = accessibleTasks.map(task => ({
            ...task,
            version: 'experienced',
            displayDescription: task.experienced_description || task.task_description
        }));
    }

    const possibleAfterGuardrails = allPossibleTasks.filter(task => {
        if (task.stage === '🌱 Sprout' || task.stage === '🌸 Bloom') {
            const stageKey = task.stage === '🌱 Sprout' ? 'Sprout' : 'Bloom';
            const unlocked = unlockedStages[task.theme_id]?.[stageKey];
            if (!unlocked) return false;
        }
        return true;
    });

    totalVisibleTasks = possibleAfterGuardrails.length;
    completedVisibleTasks = possibleAfterGuardrails.filter(task => {
        return (!showingExperienced && completedNovice.has(task.id)) ||
               (showingExperienced && completedExperienced.has(task.id));
    }).length;

    let tasksToShow = possibleAfterGuardrails.filter(task => {
        const isCompleted = (!showingExperienced && completedNovice.has(task.id)) ||
                            (showingExperienced && completedExperienced.has(task.id));
        return !isCompleted;
    });

    updateFilterOptions(tasksToShow);
    const finalFiltered = tasksToShow.filter(task => {
        const matchTheme = activeFilters.core_theme.length === 0 || activeFilters.core_theme.includes(task.core_theme);
        const matchStage = activeFilters.stage.length === 0 || activeFilters.stage.includes(task.stage);
        const matchTag = activeFilters.subcategory.length === 0 || activeFilters.subcategory.includes(task.subcategory);
        return matchTheme && matchStage && matchTag;
    });

    renderTaskList(finalFiltered);
    updateCompletedBadge();
    updatePendingSigmaBadge();
    updateProfileUI(); // <-- Ensures progress bar updates after filters

    if (!showingExperienced && accessibleTasks.every(task => completedNovice.has(task.id))) {
        showNoviceCompleteModal();
    }
    if (userProfile.tier === 'free') {
        const allNoviceDone = accessibleTasks.every(t => completedNovice.has(t.id));
        const allExperiencedDone = accessibleTasks.every(t => completedExperienced.has(t.id));
        if (allNoviceDone && allExperiencedDone && !deadEndModalShown) {
            showDeadEndModal();
        }
    }
}

function showNoviceCompleteModal() {
    if (noviceModalShown) return;
    noviceModalShown = true;
    const modal = document.getElementById('noviceCompleteModal');
    if (modal) setTimeout(() => modal.style.display = 'flex', 10);
}

function showDeadEndModal() {
    if (deadEndModalShown) return;
    deadEndModalShown = true;
    const modal = document.getElementById('deadEndModal');
    if (modal) setTimeout(() => modal.style.display = 'flex', 10);
}

window.openTaskSigmaModal = (taskId, taskTitle) => {
    document.getElementById('taskSigmaTaskId').value = taskId;
    const modalHeader = document.querySelector('#taskSigmaModal h2');
    if (modalHeader) modalHeader.innerText = `Reflect on: ${taskTitle}`;
    document.getElementById('taskSigmaModal').style.display = 'flex';
};

function renderTaskList(tasks) {
    const container = document.getElementById('tasks');
    container.innerHTML = tasks.length ? '' : `<p class="tiny muted" style="padding:20px;">No missions available with current filters.</p>`;
    tasks.forEach(task => {
        const currentReaction = userReactions[task.id];
        const taskComments = userComments.filter(c => c.task_id === task.id);
        const points = getTaskPoints(task);
        const taskDiv = document.createElement('div');
        taskDiv.style.marginBottom = "15px";
        const likeBtnColor = currentReaction === 'like' ? '#22c55e' : '#ffcc00';
        const dislikeBtnColor = currentReaction === 'dislike' ? '#ef4444' : '#ffcc00';
        const likeTextColor = currentReaction === 'like' ? 'white' : '#1e293b';
        const dislikeTextColor = currentReaction === 'dislike' ? 'white' : '#1e293b';
        const versionBadge = task.version === 'novice'
            ? '<span style="background:#3b82f6; color:white; padding:2px 8px; border-radius:12px; font-size:0.7rem; margin-left:8px;">Novice</span>'
            : '<span style="background:#f59e0b; color:white; padding:2px 8px; border-radius:12px; font-size:0.7rem; margin-left:8px;">Experienced</span>';
        taskDiv.innerHTML = `
            <div style="border: 1px solid #e2e8f0; border-radius: 16px; background: white; box-shadow: 0 2px 4px rgba(0,0,0,0.02);">
                <div style="display: flex; align-items: center; padding: 15px;">
                    <div style="margin-right: 15px;">
                        <input type="checkbox" class="task-check" data-id="${task.id}" data-version="${task.version}"
                            style="width: 24px; height: 24px; cursor: pointer;">
                    </div>
                    <div style="flex-grow: 1;">
                        <div style="font-weight: 800; font-size: 1.05rem;">${task.task_title} ${versionBadge}</div>
                        <div style="font-size: 0.9rem; margin: 6px 0;">${task.displayDescription || ''}</div>
                        <div style="display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 8px;">
                            <span style="background:#22c55e; color:white; padding:2px 8px; border-radius:12px;">+${points}</span>
                            <span style="background:#3b82f6; color:white; padding:2px 8px; border-radius:12px;">${task.core_theme}</span>
                            <span style="background:#f1f7ff; color:#3b82f6; border:1px solid #dbeafe; padding:2px 8px; border-radius:12px;">${task.stage}</span>
                            <span style="background:#f3f0ff; color:#7c3aed; border:1px solid #ede9fe; padding:2px 8px; border-radius:12px;">${task.audience || '🌍 All'}</span>
                            <span style="background:#f0fdf4; color:#15803d; border:1px solid #dcfce7; padding:2px 8px; border-radius:12px;">${task.subcategory}</span>
                        </div>
                        <div style="font-size: 0.8rem; font-style: italic; color: #64748b;">
                            <strong>Impact :</strong> ${task.impact_value || 'N/A'}. 
                            <strong>Confidence :</strong> N/A.
                        </div>
                    </div>
                    <div style="display: flex; flex-direction: column; gap: 6px;">
                        <button class="react-btn" data-id="${task.id}" data-type="like" 
                            style="background:${likeBtnColor}; color:${likeTextColor}; border:none; padding:6px 16px; border-radius:10px;">👍 Like</button>
                        <button class="react-btn" data-id="${task.id}" data-type="dislike" 
                            style="background:${dislikeBtnColor}; color:${dislikeTextColor}; border:none; padding:6px 16px; border-radius:10px;">👎 Dislike</button>
                    </div>
                </div>
                <div style="padding: 10px 15px 15px 60px; border-top: 1px solid #f1f5f9;">
                    <div class="comments-list">${taskComments.map(c => `
                        <div id="comment-box-${c.id}" style="background:#fff; padding:8px 12px; border-radius:8px; margin-bottom:8px;">
                            <div>${c.comment_text}</div>
                            <div><button onclick="window.startEditComment('${c.id}', '${c.comment_text.replace(/'/g, "\\'")}')">Edit</button>
                            <button onclick="window.deleteComment('${c.id}')">Delete</button></div>
                        </div>
                    `).join('')}</div>
                    <div style="display: flex; gap: 10px; margin-top: 5px;">
                        <input type="text" class="comment-input" data-id="${task.id}" placeholder="Write a comment..." style="flex-grow:1; padding:8px; border:1px solid #e2e8f0; border-radius:8px;">
                        <button class="comment-btn" data-id="${task.id}" style="background:#1e293b; color:white; padding:8px 16px;">Post</button>
                    </div>
                </div>
            </div>
        `;
        container.appendChild(taskDiv);
    });
    container.querySelectorAll('.task-check').forEach(el => el.onchange = (e) => handleDone(e.target));
    container.querySelectorAll('.react-btn').forEach(el => el.onclick = (e) => handleReact(e.target));
    container.querySelectorAll('.comment-btn').forEach(el => el.onclick = (e) => handleComment(e.target));
}

async function getEngagementMultiplier(userId, taskGroup) {
    const { data: stats } = await supabase
        .from('user_task_group_stats')
        .select('total_completions')
        .eq('user_id', userId)
        .eq('task_group', taskGroup)
        .maybeSingle();
    const completions = stats?.total_completions || 0;
    const hasInfluence = (userProfile.referral_count || 0) > 0;
    if (completions === 0) return 1;
    if (completions >= 1 && completions <= 4) return hasInfluence ? 3 : 2;
    if (completions >= 5) return hasInfluence ? 6 : 4;
    return 1;
}

async function updateTaskGroupStats(userId, taskGroup, pointsEarned) {
    const { data: existing } = await supabase
        .from('user_task_group_stats')
        .select('*')
        .eq('user_id', userId)
        .eq('task_group', taskGroup)
        .maybeSingle();
    const now = new Date().toISOString();
    const updates = {
        user_id: userId,
        task_group: taskGroup,
        total_completions: (existing?.total_completions || 0) + 1,
        last_completion: now,
        nectar_earned: (existing?.nectar_earned || 0) + pointsEarned
    };
    if (!existing) updates.first_completion = now;
    await supabase
        .from('user_task_group_stats')
        .upsert(updates, { onConflict: 'user_id, task_group' });
}

async function handleDone(cb) {
    if (!cb.checked) return;
    const taskId = cb.dataset.id;
    const version = cb.dataset.version;
    const task = allTasks.find(t => t.id === taskId);
    if (!task) return;
    const basePoints = getTaskPoints(task);
    const multiplier = await getEngagementMultiplier(userProfile.id, task.task_group);
    const finalPoints = Math.round(basePoints * multiplier);
    const { error } = await supabase.from('user_tasks').insert([
        { user_id: userProfile.id, task_id: taskId, version, points_awarded: finalPoints }
    ]);
    if (error) {
        cb.checked = false;
        showToast('Failed to record completion', 'error');
        return;
    }
    if (version === 'novice') completedNovice.add(taskId);
    else completedExperienced.add(taskId);
    showToast(`+${finalPoints} points! (${basePoints} × ${multiplier})`, 'success');
    await updateTaskGroupStats(userProfile.id, task.task_group, finalPoints);
    let newExperience = (userProfile.experience || 0) + finalPoints;
    let newNectar = userProfile.nectar_points || 0;
    if (newExperience >= 100) {
        const nectarIncrease = Math.floor(newExperience / 100);
        newNectar += nectarIncrease;
        newExperience = newExperience % 100;
    }
    const { error: updateError } = await supabase.from('profiles')
        .update({ experience: newExperience, nectar_points: newNectar })
        .eq('id', userProfile.id);
    if (!updateError) {
        userProfile.experience = newExperience;
        userProfile.nectar_points = newNectar;
        updateProfileUI();
        await applyFiltersAndRender();
        await checkMilestones();
    } else {
        cb.checked = false;
        showToast('Failed to update points', 'error');
    }
}

async function handleReact(btn) {
    const { error } = await supabase
        .from('task_feedback')
        .upsert({
            user_id: userProfile.id,
            task_id: btn.dataset.id,
            reaction: btn.dataset.type
        }, { onConflict: 'user_id, task_id' });
    if (error) {
        console.error('Reaction error:', error);
        showToast('Failed to save reaction', 'error');
    } else {
        initProfile();
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
    initProfile();
}

window.startEditComment = (id, oldText) => {
    const box = document.getElementById(`comment-box-${id}`);
    box.innerHTML = `
        <input type="text" id="edit-input-${id}" value="${oldText}" style="width:100%; padding:5px; border:1px solid #3b82f6; border-radius:4px;">
        <div style="margin-top:5px;">
            <button onclick="window.saveEditComment('${id}')" style="background:#22c55e; color:white; border:none; padding:3px 8px; border-radius:4px;">Save</button>
            <button onclick="initProfile()" style="background:#64748b; color:white; border:none; padding:3px 8px; border-radius:4px;">Cancel</button>
        </div>
    `;
};
window.saveEditComment = async (id) => {
    const newText = document.getElementById(`edit-input-${id}`).value;
    if (!newText.trim()) return;
    await supabase.from('task_comments').update({ comment_text: newText }).eq('id', id);
    initProfile();
};
window.deleteComment = async (id) => {
    if (confirm("Delete this comment?")) {
        await supabase.from('task_comments').delete().eq('id', id);
        initProfile();
    }
};

// ----------------------------------------------------------------------
// Modal loaders
// ----------------------------------------------------------------------
function showModalLoader(modalId) {
    const modal = document.getElementById(modalId);
    if (!modal) return;
    const content = modal.querySelector('.modal-scroll');
    if (!content) return;
    content.innerHTML = '<div class="loader-overlay" style="position:relative; background:transparent;"><div class="loader-content"><div class="buffering-icon"></div><p>Loading...</p></div></div>';
}

async function loadCompletedTasks() {
    const modal = document.getElementById('completedModal');
    if (!modal) return;
    showModalLoader('completedModal');

    const { data: completed, error } = await supabase
        .from('user_tasks')
        .select(`
            task_id, version, points_awarded, completed_at,
            tasks ( task_title, novice_description, experienced_description, stage )
        `)
        .eq('user_id', userProfile.id)
        .order('completed_at', { ascending: false });

    const listDiv = document.getElementById('completedTasksList');
    if (!listDiv) return;

    if (error) {
        listDiv.innerHTML = '<p class="tiny muted">Error loading tasks.</p>';
        console.error(error);
        return;
    }
    if (!completed || completed.length === 0) {
        listDiv.innerHTML = '<p class="tiny muted">No completed tasks yet.</p>';
        return;
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
    listDiv.innerHTML = html;
}

async function loadPendingSigmaTasks() {
    const modal = document.getElementById('pendingSigmaModal');
    if (!modal) return;
    showModalLoader('pendingSigmaModal');

    const pendingTaskIds = Array.from(completedNovice).concat(Array.from(completedExperienced))
        .filter(id => !loggedSigmaTasks.has(id));
    if (pendingTaskIds.length === 0) {
        document.getElementById('pendingSigmaTasksList').innerHTML = '<p class="tiny muted">No pending reflections.</p>';
        return;
    }

    const { data: tasks, error } = await supabase
        .from('tasks')
        .select('id, task_title, novice_description, experienced_description, stage')
        .in('id', pendingTaskIds);
    if (error) {
        document.getElementById('pendingSigmaTasksList').innerHTML = '<p class="tiny muted">Error loading tasks.</p>';
        console.error(error);
        return;
    }

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
                <button class="btn tiny" style="background:var(--cta); white-space:nowrap;" onclick="window.openTaskSigmaModal('${task.id}', '${task.task_title.replace(/'/g, "\\'")}')">Add Reflection</button>
            </div>
        `;
    });
    document.getElementById('pendingSigmaTasksList').innerHTML = html;
}

async function loadAchievementsModal() {
    const container = document.getElementById('achievementsModalList');
    if (!container) return;
    container.innerHTML = '<div class="loader-overlay" style="position:relative; background:transparent;"><div class="loader-content"><div class="buffering-icon"></div><p>Loading...</p></div></div>';
    const { data: milestones, error } = await supabase
        .from('user_milestones')
        .select('milestone_id')
        .eq('user_id', userProfile.id);
    if (error) {
        console.error(error);
        container.innerHTML = '<p class="tiny muted">Error loading achievements.</p>';
        return;
    }
    if (!milestones || milestones.length === 0) {
        container.innerHTML = '<p class="tiny muted">No achievements yet. Keep going!</p>';
        return;
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
    container.innerHTML = html;
}

// ----------------------------------------------------------------------
// Mobile missions modal with loader
// ----------------------------------------------------------------------
let isMobileModalOpen = false;
window.openMissionsModal = async () => {
    isMobileModalOpen = true;
    const modal = document.getElementById('missionsModal');
    if (!modal) return;
    modal.style.display = 'flex';
    // Show loader inside modal
    const container = document.getElementById('mobileTasksContainer');
    if (container) container.innerHTML = '<div class="loader-overlay" style="position:relative; background:transparent;"><div class="loader-content"><div class="buffering-icon"></div><p>Loading tasks...</p></div></div>';
    await refreshMobileMissionModal();
};
function closeMissionsModal() {
    isMobileModalOpen = false;
    document.getElementById('missionsModal').style.display = 'none';
}

async function refreshMobileMissionModal() {
    const accessibleTasks = getAccessibleTasks();
    const themes = [...new Set(accessibleTasks.map(t => t.theme_id))];
    const unlockedStages = {};
    for (const themeId of themes) {
        unlockedStages[themeId] = {};
        if (accessibleTasks.some(t => t.theme_id === themeId && t.stage === '🌱 Sprout')) {
            const requiredTier = stageTierMap['🌱 Sprout'];
            const userTierRank = tierRank[userProfile.tier || 'free'];
            if (!requiredTier || userTierRank >= tierRank[requiredTier]) {
                unlockedStages[themeId].Sprout = await canUnlockStage(themeId, 'Sprout');
            } else {
                unlockedStages[themeId].Sprout = false;
            }
        }
        if (accessibleTasks.some(t => t.theme_id === themeId && t.stage === '🌸 Bloom')) {
            const requiredTier = stageTierMap['🌸 Bloom'];
            const userTierRank = tierRank[userProfile.tier || 'free'];
            if (!requiredTier || userTierRank >= tierRank[requiredTier]) {
                unlockedStages[themeId].Bloom = await canUnlockStage(themeId, 'Bloom');
            } else {
                unlockedStages[themeId].Bloom = false;
            }
        }
    }
    let allPossibleTasks;
    if (!showingExperienced) {
        allPossibleTasks = accessibleTasks.map(task => ({
            ...task,
            version: 'novice',
            displayDescription: task.novice_description || task.task_description
        }));
    } else {
        allPossibleTasks = accessibleTasks.map(task => ({
            ...task,
            version: 'experienced',
            displayDescription: task.experienced_description || task.task_description
        }));
    }
    const possibleAfterGuardrails = allPossibleTasks.filter(task => {
        if (task.stage === '🌱 Sprout' || task.stage === '🌸 Bloom') {
            const stageKey = task.stage === '🌱 Sprout' ? 'Sprout' : 'Bloom';
            const unlocked = unlockedStages[task.theme_id]?.[stageKey];
            if (!unlocked) return false;
        }
        return true;
    });

    // Compute totals for mobile progress bar
    const mobileTotalVisible = possibleAfterGuardrails.length;
    const mobileCompletedVisible = possibleAfterGuardrails.filter(task => {
        return (!showingExperienced && completedNovice.has(task.id)) ||
               (showingExperienced && completedExperienced.has(task.id));
    }).length;

    let tasksToShow = possibleAfterGuardrails.filter(task => {
        const isCompleted = (!showingExperienced && completedNovice.has(task.id)) ||
                            (showingExperienced && completedExperienced.has(task.id));
        return !isCompleted;
    });

    // Update mobile filter lists from desktop
    const mobileCoreList = document.getElementById('mobileCoreFilterList');
    const mobileStageList = document.getElementById('mobileStageFilterList');
    const mobileTagList = document.getElementById('mobileTagFilterList');
    const coreList = document.getElementById('coreFilterList');
    const stageList = document.getElementById('stageFilterList');
    const tagList = document.getElementById('tagFilterList');
    if (coreList && mobileCoreList) mobileCoreList.innerHTML = coreList.innerHTML;
    if (stageList && mobileStageList) mobileStageList.innerHTML = stageList.innerHTML;
    if (tagList && mobileTagList) mobileTagList.innerHTML = tagList.innerHTML;

    // Copy summaries
    const coreSummary = document.getElementById('coreFilterSummary');
    const mobileCoreSummary = document.getElementById('mobileCoreFilterSummary');
    if (coreSummary && mobileCoreSummary) mobileCoreSummary.innerText = coreSummary.innerText;
    const stageSummary = document.getElementById('stageFilterSummary');
    const mobileStageSummary = document.getElementById('mobileStageFilterSummary');
    if (stageSummary && mobileStageSummary) mobileStageSummary.innerText = stageSummary.innerText;
    const tagSummary = document.getElementById('tagFilterSummary');
    const mobileTagSummary = document.getElementById('mobileTagFilterSummary');
    if (tagSummary && mobileTagSummary) mobileTagSummary.innerText = tagSummary.innerText;

    // Setup dropdowns and filter checkboxes
    function setupMobileFilters() {
        const dropdowns = ['mobileCoreFilterDropdown', 'mobileStageFilterDropdown', 'mobileTagFilterDropdown'];
        dropdowns.forEach(id => {
            const container = document.getElementById(id);
            if (!container) return;
            const header = container.querySelector('.dropdown-header');
            if (!header) return;
            if (header._clickHandler) header.removeEventListener('click', header._clickHandler);
            const handler = (e) => {
                e.stopPropagation();
                const isOpen = container.classList.contains('open');
                document.querySelectorAll('.dropdown-container').forEach(d => d.classList.remove('open'));
                if (!isOpen) container.classList.add('open');
            };
            header.addEventListener('click', handler);
            header._clickHandler = handler;
        });
        const checkboxes = document.querySelectorAll('#mobileCoreFilterList input, #mobileStageFilterList input, #mobileTagFilterList input');
        checkboxes.forEach(cb => {
            if (cb._changeHandler) cb.removeEventListener('change', cb._changeHandler);
            const handler = () => {
                const coreChecked = Array.from(document.querySelectorAll('#mobileCoreFilterList input:checked')).map(c => c.value);
                const stageChecked = Array.from(document.querySelectorAll('#mobileStageFilterList input:checked')).map(c => c.value);
                const tagChecked = Array.from(document.querySelectorAll('#mobileTagFilterList input:checked')).map(c => c.value);
                activeFilters.core_theme = coreChecked;
                activeFilters.stage = stageChecked;
                activeFilters.subcategory = tagChecked;
                if (mobileCoreSummary) mobileCoreSummary.innerText = coreChecked.length ? `${coreChecked.length} Selected` : "All";
                if (mobileStageSummary) mobileStageSummary.innerText = stageChecked.length ? `${stageChecked.length} Selected` : "All";
                if (mobileTagSummary) mobileTagSummary.innerText = tagChecked.length ? `${tagChecked.length} Selected` : "All";
                refreshMobileMissionModal();
            };
            cb.addEventListener('change', handler);
            cb._changeHandler = handler;
        });
    }
    setupMobileFilters();

    const finalFiltered = tasksToShow.filter(task => {
        const matchTheme = activeFilters.core_theme.length === 0 || activeFilters.core_theme.includes(task.core_theme);
        const matchStage = activeFilters.stage.length === 0 || activeFilters.stage.includes(task.stage);
        const matchTag = activeFilters.subcategory.length === 0 || activeFilters.subcategory.includes(task.subcategory);
        return matchTheme && matchStage && matchTag;
    });

    // Update mobile progress bar
    const mobileProgressBar = document.getElementById('mobileProgressBar');
    const mobileProgressPct = document.getElementById('mobileProgressPct');
    if (mobileProgressBar && mobileProgressPct) {
        const pct = mobileTotalVisible ? Math.min(Math.round((mobileCompletedVisible / mobileTotalVisible) * 100), 100) : 0;
        mobileProgressBar.value = pct;
        mobileProgressPct.innerText = `${pct}% (${mobileCompletedVisible}/${mobileTotalVisible})`;
    }

    renderMobileTaskList(finalFiltered);
}

function renderMobileTaskList(tasks) {
    const container = document.getElementById('mobileTasksContainer');
    if (!container) return;
    container.innerHTML = tasks.length ? '' : '<p class="tiny muted" style="text-align:center; padding:20px;">No missions available.</p>';
    tasks.forEach(task => {
        const currentReaction = userReactions[task.id];
        const points = getTaskPoints(task);
        const versionBadge = task.version === 'novice'
            ? '<span style="background:#3b82f6; color:white; padding:2px 8px; border-radius:12px;">Novice</span>'
            : '<span style="background:#f59e0b; color:white; padding:2px 8px; border-radius:12px;">Experienced</span>';
        const taskDiv = document.createElement('div');
        taskDiv.style.marginBottom = "15px";
        taskDiv.innerHTML = `
            <div style="border:1px solid #e2e8f0; border-radius:16px; background:white; padding:12px;">
                <div style="display:flex; align-items:center; gap:10px;">
                    <input type="checkbox" class="task-check-mobile" data-id="${task.id}" data-version="${task.version}" style="width:20px; height:20px;">
                    <div style="flex-grow:1;">
                        <div style="font-weight:800;">${task.task_title} ${versionBadge}</div>
                        <div style="font-size:0.8rem; margin:4px 0;">${task.displayDescription || ''}</div>
                        <div class="mobile-task-tags" style="display:flex; flex-wrap:wrap; gap:4px;">
    <span style="background:#22c55e; color:white;">+${points}</span>
    <span style="background:#3b82f6; color:white;">${task.core_theme}</span>
    <span style="background:#f1f7ff; color:#3b82f6; border:1px solid #dbeafe;">${task.stage}</span>
</div>
                    </div>
                    <div style="display:flex; flex-direction:column; gap:4px;">
                        <button class="react-btn-mobile" data-id="${task.id}" data-type="like" style="background:${currentReaction === 'like' ? '#22c55e' : '#ffcc00'}; border:none; padding:4px 8px; border-radius:8px;">👍</button>
                        <button class="react-btn-mobile" data-id="${task.id}" data-type="dislike" style="background:${currentReaction === 'dislike' ? '#ef4444' : '#ffcc00'}; border:none; padding:4px 8px; border-radius:8px;">👎</button>
                    </div>
                </div>
                <div style="margin-top:8px; padding-top:8px; border-top:1px solid #f1f5f9;">
                    <div id="mobileCommentsList-${task.id}"></div>
                    <div style="display:flex; gap:8px; margin-top:6px;">
                        <input type="text" class="comment-input-mobile" data-id="${task.id}" placeholder="Add a comment..." style="flex-grow:1; padding:6px; border:1px solid #e2e8f0; border-radius:8px;">
                        <button class="comment-btn-mobile" data-id="${task.id}" style="background:#1e293b; color:white; padding:6px 12px; border-radius:8px;">Post</button>
                    </div>
                </div>
            </div>
        `;
        const commentsDiv = taskDiv.querySelector(`#mobileCommentsList-${task.id}`);
        const taskComments = userComments.filter(c => c.task_id === task.id);
        if (commentsDiv && taskComments.length) {
            commentsDiv.innerHTML = taskComments.map(c => `
                <div style="font-size:0.75rem; padding:4px 0; border-bottom:1px solid #f0f0f0;">${c.comment_text}</div>
            `).join('');
        }
        container.appendChild(taskDiv);
    });
    container.querySelectorAll('.task-check-mobile').forEach(el => el.onchange = (e) => handleDone(e.target));
    container.querySelectorAll('.react-btn-mobile').forEach(el => el.onclick = (e) => handleReact(e.target));
    container.querySelectorAll('.comment-btn-mobile').forEach(el => el.onclick = (e) => handleMobileComment(e.target));
}

async function handleMobileComment(btn) {
    const taskId = btn.dataset.id;
    const input = document.querySelector(`.comment-input-mobile[data-id="${taskId}"]`);
    if (!input || !input.value.trim()) return;
    await supabase.from('task_comments').insert([{
        user_id: userProfile.id,
        task_id: taskId,
        comment_text: input.value.trim()
    }]);
    initProfile();
    if (isMobileModalOpen) refreshMobileMissionModal();
}

function updateMobileStatsModal() {
    const points = userProfile.nectar_points || 0;
    const exp = userProfile.experience || 0;
    const rank = userProfile.member_tier || 0;
    const pointsSpan = document.getElementById('mobilePointsVal');
    const rankSpan = document.getElementById('mobileRankLevel');
    const expBar = document.getElementById('mobileExperienceBar');
    const expText = document.getElementById('mobileExpText');
    if (pointsSpan) pointsSpan.innerText = points;
    if (rankSpan) rankSpan.innerText = `#${rank}`;
    if (expBar) expBar.value = exp;
    if (expText) expText.innerText = `${exp}/100`;
}
window.updateMobileStatsModal = updateMobileStatsModal;

function setupLogout() {
    const logoutBtn = document.getElementById('logoutBtn');
    if (logoutBtn) {
        logoutBtn.addEventListener('click', async () => {
            Loader.show("Safely signing you out...");
            try {
                const { error } = await supabase.auth.signOut();
                if (error) throw error;
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
    if (!userProfile) return;
    const totalTasks = completedNovice.size + completedExperienced.size;
    const nectar = userProfile.nectar_points || 0;
    const referralCount = userProfile.referral_count || 0;
    const joinDate = userProfile.join_date ? new Date(userProfile.join_date) : new Date();
    const daysSinceJoin = Math.floor((Date.now() - joinDate) / (1000 * 60 * 60 * 24));
    const { count: sigmaCount, error: sigmaError } = await supabase
        .from('sigma_logs')
        .select('*', { count: 'exact', head: true })
        .eq('user_id', userProfile.id);
    const sigmaLogs = sigmaCount || 0;
    for (const milestone of MILESTONE_THRESHOLDS) {
        let achieved = false;
        switch (milestone.type) {
            case 'nectar': achieved = nectar >= milestone.threshold; break;
            case 'growth': achieved = totalTasks >= milestone.threshold; break;
            case 'member': achieved = daysSinceJoin >= milestone.threshold; break;
            case 'pollinator': achieved = referralCount >= milestone.threshold; break;
            case 'sigma': achieved = sigmaLogs >= milestone.threshold; break;
        }
        if (achieved) {
            await supabase
                .from('user_milestones')
                .upsert({ user_id: userProfile.id, milestone_id: milestone.id, achieved_at: new Date().toISOString() },
                        { onConflict: 'user_id, milestone_id' });
        }
    }
    await loadAchievementsModal();
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

    const addSigmaBtn = document.getElementById('addSigmaBtn');
    if (addSigmaBtn) {
        addSigmaBtn.addEventListener('click', () => {
            document.getElementById('sigmaModal').style.display = 'flex';
        });
    }
    const sigmaForm = document.getElementById('sigmaForm');
    if (sigmaForm) {
        sigmaForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const define = document.getElementById('sigmaDefine').value.trim();
            const measure = document.getElementById('sigmaMeasure').value.trim();
            const analysis = document.getElementById('sigmaAnalyse').value.trim();
            const improve = document.getElementById('sigmaImprove').value.trim();
            const control = document.getElementById('sigmaControl').value.trim();
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
                document.getElementById('sigmaModal').style.display = 'none';
                sigmaForm.reset();
                await checkMilestones();
            }
        });
    }

    const taskSigmaForm = document.getElementById('taskSigmaForm');
    if (taskSigmaForm) {
        taskSigmaForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const taskId = document.getElementById('taskSigmaTaskId').value;
            const define = document.getElementById('taskSigmaDefine').value.trim();
            const measure = document.getElementById('taskSigmaMeasure').value.trim();
            const analysis = document.getElementById('taskSigmaAnalyse').value.trim();
            const improve = document.getElementById('taskSigmaImprove').value.trim();
            const control = document.getElementById('taskSigmaControl').value.trim();
            const { error } = await supabase.from('task_sigma_logs').insert([{
                user_id: userProfile.id,
                task_id: taskId,
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
                loggedSigmaTasks.add(taskId);
                document.getElementById('taskSigmaModal').style.display = 'none';
                taskSigmaForm.reset();
                closePendingSigmaModal();
                updatePendingSigmaBadge();
                await applyFiltersAndRender();
                if (isMobileModalOpen) refreshMobileMissionModal();
            }
        });
    }
});