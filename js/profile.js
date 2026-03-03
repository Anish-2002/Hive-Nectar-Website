import { supabase } from './supabase-config.js';

let allTasks = [];
let completedIds = [];
let userProfile = null;
let userReactions = {}; 
let userComments = [];

let activeFilters = { 
    core_theme: [], 
    stage: [], 
    subcategory: [] 
};

export async function initProfile() {
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) { window.location.replace('login.html'); return; }

    const [profileRes, tasksRes, userTasksRes, feedbackRes, commentsRes] = await Promise.all([
        supabase.from('profiles').select('*').eq('id', user.id).single(),
        supabase.from('tasks').select('*'),
        supabase.from('user_tasks').select('task_id').eq('user_id', user.id),
        supabase.from('task_feedback').select('task_id, reaction').eq('user_id', user.id),
        supabase.from('task_comments').select('*').eq('user_id', user.id).order('created_at', { ascending: false })
    ]);

    userProfile = profileRes.data;
    allTasks = tasksRes.data || [];
    completedIds = userTasksRes.data.map(t => t.task_id);
    userComments = commentsRes.data || [];
    
    userReactions = {};
    feedbackRes.data?.forEach(f => {
        userReactions[f.task_id] = f.reaction;
    });

    updateProfileUI();
    setupMultiFilters();
    applyFiltersAndRender();
    setupLogout();
}

function updateProfileUI() {
    const currentLevel = userProfile.current_level || 0;
    const levelTasks = allTasks.filter(t => t.required_level === currentLevel);
    const completedInLevel = levelTasks.filter(t => completedIds.includes(t.id));

    document.getElementById('userNameDisplay').innerText = `${userProfile.first_name} ${userProfile.last_name}`;
    document.getElementById('pointsVal').innerText = userProfile.nectar_points || 0;
    document.getElementById('rankLevel').innerText = `#${currentLevel}`;
    
    const pct = Math.min(Math.round((completedInLevel.length / 10) * 100), 100);
    document.getElementById('progressBar').value = pct;
    document.getElementById('progressPct').innerText = `${pct}% (${completedInLevel.length}/10)`;

    if (completedInLevel.length >= 10) {
        handleLevelUp(currentLevel);
    }
}

// --- CUSTOM THEMED MODAL ---
function showCustomLevelModal(level, onConfirm) {
    const modalOverlay = document.createElement('div');
    modalOverlay.style = `
        position: fixed; top: 0; left: 0; width: 100%; height: 100%;
        background: rgba(15, 23, 42, 0.75); display: flex; align-items: center;
        justify-content: center; z-index: 10000; backdrop-filter: blur(6px);
        font-family: sans-serif;
    `;

    modalOverlay.innerHTML = `
        <div style="background: white; width: 90%; max-width: 400px; padding: 40px 30px; border-radius: 28px; text-align: center; box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.25);">
            <div style="font-size: 60px; margin-bottom: 20px;">🏆</div>
            <h2 style="margin: 0 0 10px; color: #1e293b; font-size: 1.75rem; font-weight: 800;">Level Up!</h2>
            <p style="color: #64748b; font-size: 1rem; line-height: 1.6; margin-bottom: 30px;">
                Amazing work! You've successfully earned the <br><strong style="color: #1e293b;">Level ${level} Badge</strong>.
            </p>
            <div style="display: flex; flex-direction: column; gap: 12px;">
                <button id="modalConfirm" style="background: #22c55e; color: white; border: none; padding: 14px; border-radius: 14px; font-weight: 700; cursor: pointer; font-size: 1rem; transition: transform 0.2s;">
                    Unlock New Tasks
                </button>
                <button id="modalClose" style="background: transparent; color: #94a3b8; border: none; padding: 10px; cursor: pointer; font-size: 0.9rem; font-weight: 600;">
                    Dismiss
                </button>
            </div>
        </div>
    `;

    document.body.appendChild(modalOverlay);

    document.getElementById('modalConfirm').onclick = () => {
        document.body.removeChild(modalOverlay);
        onConfirm();
    };

    document.getElementById('modalClose').onclick = () => {
        document.body.removeChild(modalOverlay);
    };
}

async function handleLevelUp(completedLevel) {
    showCustomLevelModal(completedLevel, async () => {
        const nextLevel = completedLevel + 1;
        const nextNectar = (userProfile.nectar_points || 0) + 1;

        const { error } = await supabase.from('profiles')
            .update({ current_level: nextLevel, nectar_points: nextNectar })
            .eq('id', userProfile.id);

        if (!error) initProfile();
    });
}

function setupMultiFilters() {
    const buildDropdown = (id, listId, field, summaryId) => {
        const uniqueValues = [...new Set(allTasks.map(t => t[field]))];
        const listContainer = document.getElementById(listId);
        const summarySpan = document.getElementById(summaryId);
        const dropdownContainer = document.getElementById(id);

        listContainer.innerHTML = uniqueValues.map(val => `
            <label class="filter-item" style="display:flex; align-items:center; gap:10px; padding:10px; cursor:pointer; border-bottom:1px solid #e2e8f0; font-size:0.8rem;">
                <input type="checkbox" value="${val}">
                <span>${val}</span>
            </label>
        `).join('');

        dropdownContainer.querySelector('.dropdown-header').onclick = (e) => {
            e.stopPropagation();
            const isOpen = dropdownContainer.classList.contains('open');
            document.querySelectorAll('.dropdown-container').forEach(d => d.classList.remove('open'));
            if (!isOpen) dropdownContainer.classList.add('open');
        };

        listContainer.querySelectorAll('input').forEach(cb => {
            cb.onchange = () => {
                const checked = Array.from(listContainer.querySelectorAll('input:checked')).map(c => c.value);
                activeFilters[field] = checked;
                summarySpan.innerText = checked.length > 0 ? `${checked.length} Selected` : "All";
                applyFiltersAndRender();
            };
        });
    };

    buildDropdown('coreFilterDropdown', 'coreFilterList', 'core_theme', 'coreFilterSummary');
    buildDropdown('stageFilterDropdown', 'stageFilterList', 'stage', 'stageFilterSummary');
    buildDropdown('tagFilterDropdown', 'tagFilterList', 'subcategory', 'tagFilterSummary');

    window.onclick = () => document.querySelectorAll('.dropdown-container').forEach(d => d.classList.remove('open'));
}

function applyFiltersAndRender() {
    const currentLevel = userProfile.current_level || 0;
    const filtered = allTasks.filter(task => {
        const matchLevel = task.required_level === currentLevel;
        const matchTheme = activeFilters.core_theme.length === 0 || activeFilters.core_theme.includes(task.core_theme);
        const matchStage = activeFilters.stage.length === 0 || activeFilters.stage.includes(task.stage);
        const matchTag = activeFilters.subcategory.length === 0 || activeFilters.subcategory.includes(task.subcategory);
        return matchLevel && matchTheme && matchStage && matchTag;
    });
    renderTaskList(filtered);
}

function renderTaskList(tasks) {
    const container = document.getElementById('tasks');
    container.innerHTML = tasks.length ? '' : `<p class="tiny muted" style="padding:20px;">No more missions for Level ${userProfile.current_level}.</p>`;

    tasks.forEach(task => {
        const isDone = completedIds.includes(task.id);
        const currentReaction = userReactions[task.id];
        const taskComments = userComments.filter(c => c.task_id === task.id);
        
        const taskDiv = document.createElement('div');
        taskDiv.style.marginBottom = "15px";

        // Logic for Dynamic Button Colors
        const likeBtnColor = currentReaction === 'like' ? '#22c55e' : '#ffcc00';      
        const dislikeBtnColor = currentReaction === 'dislike' ? '#ef4444' : '#ffcc00'; 
        const likeTextColor = currentReaction === 'like' ? 'white' : '#1e293b';
        const dislikeTextColor = currentReaction === 'dislike' ? 'white' : '#1e293b';

        taskDiv.innerHTML = `
            <div style="border: 1px solid #e2e8f0; border-radius: 16px; background: white; box-shadow: 0 2px 4px rgba(0,0,0,0.02); font-family: sans-serif; overflow: hidden;">
                <div style="display: flex; align-items: center; padding: 15px;">
                    <div style="margin-right: 15px;">
                        <input type="checkbox" class="task-check" data-id="${task.id}" 
                            ${isDone ? 'checked disabled' : ''} 
                            style="width: 24px; height: 24px; cursor: pointer;">
                    </div>

                    <div style="flex-grow: 1;">
                        <div style="font-weight: 800; font-size: 1.05rem; color: #1e293b; margin-bottom: 6px;">${task.task_title}</div>
                        
                        <div style="display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 8px; align-items: center;">
                            <span style="background: #22c55e; color: white; padding: 2px 8px; border-radius: 12px; font-size: 0.75rem; font-weight: bold;">+4</span>
                            <span style="background: #3b82f6; color: white; padding: 2px 12px; border-radius: 20px; font-size: 0.75rem;">${task.core_theme}</span>
                            <span style="background: #f1f7ff; color: #3b82f6; border: 1px solid #dbeafe; padding: 2px 10px; border-radius: 20px; font-size: 0.7rem;">${task.stage}</span>
                            <span style="background: #f3f0ff; color: #7c3aed; border: 1px solid #ede9fe; padding: 2px 10px; border-radius: 20px; font-size: 0.7rem;">${task.audience || '🌍 All'}</span>
                            <span style="background: #f0fdf4; color: #15803d; border: 1px solid #dcfce7; padding: 2px 10px; border-radius: 20px; font-size: 0.7rem;">${task.subcategory}</span>
                        </div>

                        <div style="font-size: 0.8rem; font-style: italic; color: #64748b;">
                            <strong style="color: #475569; font-style: normal;">Impact :</strong> ${task.impact_value || 'N/A'}. 
                            <strong style="color: #475569; font-style: normal; margin-left: 8px;">Confidence :</strong> N/A.
                        </div>
                    </div>

                    <div style="display: flex; flex-direction: column; gap: 6px; margin-left: 20px;">
                        <button class="react-btn" data-id="${task.id}" data-type="like" 
                            style="background: ${likeBtnColor}; color: ${likeTextColor}; border: none; padding: 6px 16px; border-radius: 10px; font-weight: 600; cursor: pointer; font-size: 0.85rem; min-width: 90px; transition: background 0.3s;">
                            👍 Like
                        </button>
                        <button class="react-btn" data-id="${task.id}" data-type="dislike" 
                            style="background: ${dislikeBtnColor}; color: ${dislikeTextColor}; border: none; padding: 6px 16px; border-radius: 10px; font-weight: 600; cursor: pointer; font-size: 0.85rem; min-width: 90px; transition: background 0.3s;">
                            👎 Dislike
                        </button>
                    </div>
                </div>

                <div style="padding: 10px 15px 15px 60px; border-top: 1px solid #f1f5f9; background: #fafafa;">
                    <div class="comments-list">
                        ${taskComments.map(c => `
                            <div id="comment-box-${c.id}" style="background: #fff; padding: 8px 12px; border-radius: 8px; font-size: 0.8rem; border: 1px solid #e2e8f0; border-left: 3px solid #cbd5e1; margin-bottom: 8px;">
                                <div style="color: #475569;">${c.comment_text}</div>
                                <div style="margin-top: 4px;">
                                    <button onclick="window.startEditComment('${c.id}', '${c.comment_text.replace(/'/g, "\\'")}')" style="background:none; border:none; color:#3b82f6; cursor:pointer; font-size:0.7rem;">Edit</button>
                                    <button onclick="window.deleteComment('${c.id}')" style="background:none; border:none; color:#ef4444; cursor:pointer; font-size:0.7rem; margin-left:8px;">Delete</button>
                                </div>
                            </div>
                        `).join('')}
                    </div>
                    <div style="display: flex; gap: 10px; margin-top: 5px;">
                        <input type="text" class="comment-input" data-id="${task.id}" placeholder="Write a comment..." style="flex-grow: 1; padding: 8px 10px; border: 1px solid #e2e8f0; border-radius: 8px; font-size: 0.85rem; outline: none;">
                        <button class="comment-btn" data-id="${task.id}" style="background: #1e293b; color: white; border: none; padding: 8px 16px; border-radius: 8px; cursor: pointer; font-size: 0.85rem; font-weight: 600;">Post</button>
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

window.startEditComment = (id, oldText) => {
    const box = document.getElementById(`comment-box-${id}`);
    box.innerHTML = `
        <input type="text" id="edit-input-${id}" value="${oldText}" style="width: 100%; padding: 5px; border: 1px solid #3b82f6; border-radius: 4px; font-size:0.8rem;">
        <div style="margin-top:5px;">
            <button onclick="window.saveEditComment('${id}')" style="background:#22c55e; color:white; border:none; padding:3px 8px; border-radius:4px; cursor:pointer; font-size:0.7rem;">Save</button>
            <button onclick="initProfile()" style="background:#64748b; color:white; border:none; padding:3px 8px; border-radius:4px; cursor:pointer; font-size:0.7rem; margin-left:5px;">Cancel</button>
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

async function handleComment(btn) {
    const taskId = btn.dataset.id;
    const input = document.querySelector(`.comment-input[data-id="${taskId}"]`);
    if (!input.value.trim()) return;
    await supabase.from('task_comments').insert([{ user_id: userProfile.id, task_id: taskId, comment_text: input.value.trim() }]);
    initProfile();
}

async function handleDone(cb) {
    if (!cb.checked) return;
    const { error } = await supabase.from('user_tasks').insert([{ user_id: userProfile.id, task_id: cb.dataset.id }]);
    if (error) { cb.checked = false; return; }
    initProfile();
}

async function handleReact(btn) {
    await supabase.from('task_feedback').upsert({
        user_id: userProfile.id, task_id: btn.dataset.id, reaction: btn.dataset.type
    }, { onConflict: 'user_id, task_id' });
    initProfile();
}

function setupLogout() {
    document.getElementById('logoutBtn')?.addEventListener('click', async () => {
        await supabase.auth.signOut();
        window.location.replace('index.html');
    });
}