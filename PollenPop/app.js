// app.js - unified logic with live updates and design-matched rendering (V2.9-EMAIL-CHECK-RTDB-SESSION)

const OUTBOX_KEY = 'poc:outbox';
const UID_KEY = 'poc:uid';
const NAME_KEY_PREFIX = 'poc:done:';
const VOTES_KEY_PREFIX = 'poc:votes:';
const COMMENT_KEY_PREFIX = 'poc:comments:'; 
const VERSION = '2.9-EMAIL-CHECK-RTDB-SESSION'; // Updated Version
const SESSION_TIMEOUT_MS = 1 * 60 * 1000; // 1 minute in milliseconds

/* ---------------- Firebase Setup ---------------- */
// For Firebase JS SDK v7.20.0 and later, measurementId is optional
const firebaseConfig = {
  apiKey: "AIzaSyA0DJBS3xYmuDgZhQNSco4jA5uUCPtgPss",
  authDomain: "testwebtracker.firebaseapp.com",
  databaseURL: "https://testwebtracker-default-rtdb.firebaseio.com",
  projectId: "testwebtracker",
  storageBucket: "testwebtracker.firebasestorage.app",
  messagingSenderId: "323598600436",
  appId: "1:323598600436:web:9e46d8ed047685775db6a1",
  measurementId: "G-75N92JTRSY"
};

let db = null;
if (typeof firebase !== 'undefined' && !firebase.apps.length) {
  firebase.initializeApp(firebaseConfig);
  db = firebase.database();
} else if (typeof firebase !== 'undefined') {
  db = firebase.database();
}

/* ---------------- Configuration Update ---------------- */
const FEEDBACK_FORM_URL = 'https://docs.google.com/forms/d/e/1FAIpQLSdofOkktqnShUm4emsW-ZdOhxfyycKfg4TVsryWo-tsYi6NVQ/viewform?usp=header';
const STAGE_SCORES = {
    "🌰 Seeds": 2,
    "🌱 Sprout": 4,
    "🌸 Bloom": 9
};

/* ---------------- utilities ---------------- */
const $ = s => document.querySelector(s);
const $$ = s => document.querySelectorAll(s);
const safeGet = (k, fallback = null) => {
  try { const raw = localStorage.getItem(k); return raw ? JSON.parse(raw) : fallback; }
  catch (e) { console.warn('safeGet', k, e); return fallback; }
};
const safeSet = (k, v) => {
  try { localStorage.setItem(k, JSON.stringify(v)); return true; }
  catch (e) { console.error('safeSet', e); return false; }
};
const uid = () => {
  try { return localStorage.getItem(UID_KEY) || crypto.randomUUID(); }
  catch { return localStorage.getItem(UID_KEY) || 'p_' + Math.random().toString(36).slice(2, 10); }
};
let TESTER_ID = localStorage.getItem(UID_KEY) || uid();
localStorage.setItem(UID_KEY, TESTER_ID);

const toastWrap = document.createElement('div');
toastWrap.className = 'toastWrap';
document.body.appendChild(toastWrap);

function toast(msg, opts = {}) {
  const el = document.createElement('div');
  el.className = 'toast ' + (opts.type === 'error' ? 'error' : opts.type === 'success' ? 'success' : '');
  el.textContent = msg;
  toastWrap.appendChild(el);
  setTimeout(() => el.remove(), opts.duration || 2000); 
}

/**
 * NEW: Generic modal for simple confirmation or error messages.
 * Replaces the old showConfirm with a more useful generic modal.
 * @param {string} message - The HTML content of the message.
 * @returns {Promise<boolean>} Resolves when the modal is closed.
 */
function showModalMessage(message, isError = false) {
    return new Promise(resolve => {
        // Use existing showConfirm styles
        const style = document.createElement('style');
        style.textContent = `.custom-modal-backdrop{position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,.6);display:flex;justify-content:center;align-items:center;z-index:9999}.custom-modal-content{background:white;padding:25px;border-radius:12px;box-shadow:0 4px 12px rgba(0,0,0,.3);max-width:90%;width:300px;text-align:center}.custom-modal-actions{margin-top:15px}.custom-modal-content p{margin:0 0 15px;font-weight:600}`;
        document.head.appendChild(style);

        const modal = document.createElement('div');
        modal.className = 'custom-modal-backdrop';

        const closeModal = () => {
            document.body.removeChild(modal);
            document.head.removeChild(style);
            resolve(true);
        };

        modal.innerHTML = `
        <div class="custom-modal-content" style="${isError ? 'border-top: 5px solid var(--danger);' : ''}">
            <p>${message}</p>
            <div class="custom-modal-actions">
            <button id="modalConfirm" class="btn ${isError ? 'error-btn' : ''}">OK</button>
            </div>
        </div>
        `;

        document.body.appendChild(modal);
        const confirmButton = modal.querySelector('#modalConfirm');

        confirmButton.addEventListener('click', closeModal);
    });
}


/* ---------------- event queue ---------------- */
function queueEvent(evt) {
  const box = safeGet(OUTBOX_KEY, []);
  box.push({ ...evt, tester_id: TESTER_ID, ua: navigator.userAgent, version: VERSION, ts: Date.now() });
  safeSet(OUTBOX_KEY, box);
  // flushOutbox().catch(e => console.warn(e)); 
}


/* ---------------- Tasks / Persistence ---------------- */

let TASKS = []; 
let ALLOCATED_TASKS = []; 
let TESTER_MAP = {}; 
let USER_TASK_STATUS = {}; 


function getDoneTasks() {
    const doneMap = {};
    for (const taskId in USER_TASK_STATUS) {
        if (isTaskDone(taskId)) {
            doneMap[taskId] = true; 
        }
    }
    return doneMap;
}

function isTaskDone(taskId) {
    const taskStatus = USER_TASK_STATUS[taskId];
    return (taskStatus && taskStatus.done === true) || taskStatus === 'done';
}

function setTaskDone(taskId, isDone) {
    const currentComment = getTaskComment(taskId); 
    
    // --- RTDB Logic ---
    if (!db) {
        // Fallback to local storage (omitted for brevity, keep only RTDB logic for clarity)
        return toast('Error: Database not available.', { type: 'error' });
    }

    const taskRef = db.ref(`users/${TESTER_ID}/tasks/${taskId}`);
    
    if (isDone) {
        const existingStatus = USER_TASK_STATUS[taskId] || {};
        USER_TASK_STATUS[taskId] = {...existingStatus, done: true};
        taskRef.update({ done: true })
            .then(() => toast(`Task completed! (Saved to DB).`, { type: 'success', duration: 1500 }))
            .catch(e => { console.error("RTDB write error:", e); toast('Error saving done status to DB.', { type: 'error' }); });
    } else {
        if (USER_TASK_STATUS[taskId]) {
            delete USER_TASK_STATUS[taskId].done;
            if (Object.keys(USER_TASK_STATUS[taskId]).length === 0) {
                delete USER_TASK_STATUS[taskId]; 
                taskRef.remove()
                    .then(() => toast(`Task marked incomplete. (Status cleared from DB).`, { duration: 1500 }))
                    .catch(e => console.error("RTDB write error:", e));
            } else {
                taskRef.update({ done: null })
                    .then(() => toast(`Task marked incomplete. (Status cleared from DB).`, { duration: 1500 }))
                    .catch(e => console.error("RTDB write error:", e));
            }
        } else {
           toast(`Task marked incomplete. (No status found to clear).`, { duration: 1500 });
        }
    }
    
    queueEvent({
        type: 'completion',
        task_id: taskId,
        status: isDone ? 'completed' : 'incomplete',
        comment: currentComment || undefined 
    });

    updateProgress();
    applyFilters();
    resetActivityTimer(); // Reset timer on interaction
}

function handleTaskCompletion(event) {
    const checkbox = event.currentTarget;
    const taskId = checkbox.dataset.taskId;
    const isDone = checkbox.checked;

    setTaskDone(taskId, isDone);
}


/* ---------------- Votes ---------------- */
function getTaskVote(taskId) {
    const voteValue = USER_TASK_STATUS[taskId]?.vote;
    if (voteValue === 1) return 'like';
    if (voteValue === -1) return 'dislike';
    return null; 
}

function setTaskVote(taskId, voteType) {
    let voteValue = null; 
    let toastMsg = 'Vote cleared.';

    if (voteType === 'like') {
        voteValue = 1;
        toastMsg = 'Vote recorded: liked.';
    } else if (voteType === 'dislike') {
        voteValue = -1;
        toastMsg = 'Vote recorded: disliked.';
    }
    
    queueEvent({ 
        type: 'vote', 
        task_id: taskId, 
        vote: voteValue === null ? 0 : voteValue 
    });
    
    if (!db) {
        toast('Error: Database not available.', { type: 'error' });
        return;
    }

    const taskRef = db.ref(`users/${TESTER_ID}/tasks/${taskId}`);
    
    if (!USER_TASK_STATUS[taskId]) {
        USER_TASK_STATUS[taskId] = {};
    }

    if (voteValue === null) {
        delete USER_TASK_STATUS[taskId].vote;
    } else {
        USER_TASK_STATUS[taskId].vote = voteValue;
    }

    if (Object.keys(USER_TASK_STATUS[taskId]).length === 0) {
         taskRef.remove()
            .then(() => toast(toastMsg + ' (Saved to DB).', { duration: 1500 }))
            .catch(e => { console.error("RTDB write error:", e); toast('Error clearing vote in DB.', { type: 'error' }); });
    } else {
        taskRef.update({ vote: voteValue })
            .then(() => toast(toastMsg + ' (Saved to DB).', { type: 'success', duration: 1500 }))
            .catch(e => { console.error("RTDB write error:", e); toast('Error saving vote to DB.', { type: 'error' }); });
    }

    applyFilters(); 
    resetActivityTimer(); // Reset timer on interaction
}

function handleVote(event) {
    const button = event.currentTarget;
    const taskItem = button.closest('.task-item');
    if (!taskItem) return;
    
    const taskId = taskItem.dataset.taskId;
    const voteType = button.dataset.voteType; 
    
    if (!taskId || !voteType) return;

    const currentVote = getTaskVote(taskId);
    
    if (currentVote === voteType) {
        setTaskVote(taskId, 'none');
    } else {
        setTaskVote(taskId, voteType);
    }
}

/* ---------------- Comments ---------------- */

function getTaskComment(taskId) {
    return USER_TASK_STATUS[taskId]?.comment || ''; 
}

function setTaskComment(taskId, commentText) {
    const trimmedComment = String(commentText).trim();
    const commentValue = trimmedComment || null; 

    queueEvent({ 
        type: 'comment', 
        task_id: taskId, 
        comment: trimmedComment
    });
    
    if (!db) {
        if (commentValue) {
            toast('Comment saved (Local Storage).', { type: 'success', duration: 1500 });
        } else {
            toast('Comment cleared (Local Storage).', { duration: 1500 });
        }
        applyFilters();
        resetActivityTimer(); // Reset timer on interaction
        return;
    }
    
    const taskRef = db.ref(`users/${TESTER_ID}/tasks/${taskId}`);

    if (!USER_TASK_STATUS[taskId]) {
        USER_TASK_STATUS[taskId] = {};
    }
    
    if (commentValue === null) {
        delete USER_TASK_STATUS[taskId].comment;
    } else {
        USER_TASK_STATUS[taskId].comment = commentValue;
    }

    if (Object.keys(USER_TASK_STATUS[taskId]).length === 0) {
         taskRef.remove()
            .then(() => toast(`Comment cleared (Saved to DB).`, { duration: 1500 }))
            .catch(e => { console.error("RTDB write error:", e); toast('Error clearing comment in DB.', { type: 'error' }); });
    } else {
        taskRef.update({ comment: commentValue })
            .then(() => {
                if (commentValue) {
                    toast('Comment saved (Saved to DB).', { type: 'success', duration: 1500 });
                } else {
                    toast('Comment cleared (Saved to DB).', { duration: 1500 });
                }
            })
            .catch(e => { console.error("RTDB write error:", e); toast('Error saving comment to DB.', { type: 'error' }); });
    }

    applyFilters(); 
    resetActivityTimer(); // Reset timer on interaction
}

function handleCommentSave(event) {
    const button = event.currentTarget;
    const taskItem = button.closest('.task-item');
    if (!taskItem) return;
    
    const taskId = taskItem.dataset.taskId;
    const commentInput = taskItem.querySelector('.task-comment-input');
    
    if (!taskId || !commentInput) return;

    setTaskComment(taskId, commentInput.value);
}

/* ---------------- tasks / filtering / scoring / Data Loading ---------------- */

function normalizeTasks(rawTasks) {
    const CORE_MAP = {
        '🌱 Connecting / Belonging': 'connectingbelonging',
        '⚡ Acting / Motivating': 'actingmotivating',
        '🌙 Reflecting / Learning': 'reflectinglearning',
        '✨ Creating / Circularity': 'creatingcircularity'
    };
    const STAGE_MAP = {
        '🌰 Seeds': { internal: 'seeds', display: '🌰 Seeds' },
        '🌱 Sprout': { internal: 'sprout', display: '🌱 Sprout' },
        '🌸 Bloom': { internal: 'bloom', display: '🌸 Bloom' }
    };
    const cleanTag = (tag) => {
        if (!tag) return '';
        return tag.replace(/[^a-zA-Z0-9\s]/g, '').toLowerCase().trim().replace(/\s+/g, '');
    };

    return rawTasks.map(t => {
        const rawStage = t.stage || '🌰 Seeds';
        const stageData = STAGE_MAP[rawStage] || { internal: 'seeds', display: rawStage };
        const rawCoreTheme = t.core_theme || '';
        const internalCore = CORE_MAP[rawCoreTheme] || cleanTag(rawCoreTheme);

        const rawSubcategory = t.subcategory || '';
        const displayTags = rawSubcategory ? [rawSubcategory] : [];
        const internalTags = rawSubcategory ? [cleanTag(rawSubcategory)] : [];
        const score = STAGE_SCORES[rawStage] || 0;

        return {
            ...t,
            score: score, 
            primary_core_display: rawCoreTheme,
            stage_display: stageData.display,
            audience_display: t.audience,
            tags_display: displayTags,
            primary_core: internalCore,
            stage: stageData.internal,
            tags: internalTags,
        };
    });
}

/**
 * NEW: Checks the entered email against the RTDB's list of approved testers.
 * @param {string} email - The email entered by the user.
 * @returns {Promise<string|null>} The tester_id if found, otherwise null.
 */
async function checkTesterEmail(email) {
    if (!db) {
        console.warn('DB not available for email check. Skipping security check.');
        // Fallback: If DB is down, assume success if a name was entered.
        return 'FALLBACK_TESTER'; 
    }
    
    try {
        // Normalize the email to lowercase for consistent key lookup
        const normalizedEmail = email.toLowerCase().replace(/\./g, ','); // RTDB keys cannot contain '.', so replace with ','
        
        // Query the approved_emails node directly for the key
        const emailRef = db.ref(`approved_emails/${normalizedEmail}`);
        const snapshot = await emailRef.once('value');
        
        const testerId = snapshot.val(); 

        return testerId; // Returns the tester_id string or null
        
    } catch (e) {
        console.error("Error checking tester email:", e);
        toast('Database error during email check.', { type: 'error' });
        return null; // Treat any error as failed lookup
    }
}

async function initData() {
    USER_TASK_STATUS = {}; 

    if (!db) {
        toast('Firebase Database not initialized. Falling back to local files.', { type: 'error' });
        await loadFallbackData(); 
        return;
    }

    try {
        const dataSnapshot = await db.ref('/').once('value');
        const data = dataSnapshot.val();

        if (!data || !data.tasks || !data.tester_mapping) {
            toast('RTDB is missing required data (tasks/tester_mapping). Falling back to local files.', { type: 'error' });
            await loadFallbackData();
            return;
        }

        // 1. Process Tasks
        const rawTasks = Object.values(data.tasks); 
        TASKS = normalizeTasks(rawTasks); 

        // 2. Process Tester Mapping
        const currentTesterMap = data.tester_mapping[TESTER_ID];
        if (currentTesterMap) {
            TESTER_MAP = currentTesterMap;
        } else {
            TESTER_MAP = { allocated_task_ids: [], preferred_cores: [], preferred_categories: [] };
            // Note: This toast is now less likely to happen as TESTER_ID comes from the email check
            toast(`Tester ID ${TESTER_ID} not found in mapping. Displaying all tasks.`, { duration: 3000 });
        }
        
        // 3. Process User Data
        const userSnapshot = await db.ref(`users/${TESTER_ID}`).once('value');
        const userData = userSnapshot.val();
        
        USER_TASK_STATUS = (userData && userData.tasks) || {};
        
        // 4. Set allocated tasks 
        ALLOCATED_TASKS = getAllocatedTasks(); 

        $('#saveMsg').textContent = 'Data loaded from Firebase.'; 
        toast('Data loaded from Firebase.', { type: 'success' });

    } catch (e) {
        console.error("Error loading data from Firebase:", e);
        toast('Failed to connect or load data from Firebase. Falling back to local files.', { type: 'error' });
        await loadFallbackData();
    }
}

async function loadFallbackData() {
    try {
        const tasksResponse = await fetch('tasks_master.json');
        const rawTasks = tasksResponse.ok ? await tasksResponse.json() : [];
        TASKS = normalizeTasks(rawTasks);
        
        const mapResponse = await fetch('tester_mapping.json');
        if (mapResponse.ok) {
            const mapping = await mapResponse.json();
            TESTER_MAP = mapping.find(m => m.tester_id === TESTER_ID) || {};
        }
        
        // Load user progress from local storage (legacy)
        const doneTasks = safeGet(`${NAME_KEY_PREFIX}${TESTER_ID}`, {});
        const localUserStatus = {};
        for (const taskId in doneTasks) {
            localUserStatus[taskId] = { done: true };
        }
        USER_TASK_STATUS = localUserStatus;
        
        ALLOCATED_TASKS = getAllocatedTasks();
        toast('Loaded data from local files (Fallback).', { type: 'warning' });

    } catch (err) {
        console.error('Error loading fallback data:', err);
    }
}

function getAllocatedTasks() {
    let allocatedTasks = TASKS;
    
    if (TESTER_MAP.allocated_task_ids && TESTER_MAP.allocated_task_ids.length > 0) {
        const allocated = new Set(TESTER_MAP.allocated_task_ids);
        allocatedTasks = TASKS.filter(t => allocated.has(t.id));
    }
    
    return allocatedTasks;
}

function updateProgress() {
    const allocatedTasks = ALLOCATED_TASKS; 
    const doneTasks = getDoneTasks(); 
    
    const doneCount = allocatedTasks.filter(t => doneTasks[t.id]).length;
    const totalCount = allocatedTasks.length;
    const totalPoints = allocatedTasks
        .filter(t => doneTasks[t.id])
        .reduce((sum, t) => sum + t.score, 0); 

    const progressPct = totalCount > 0 ? Math.round((doneCount / totalCount) * 100) : 0;

    $('#progressBar').value = progressPct;
    $('#progressPct').textContent = `${doneCount}/${totalCount} (${progressPct}%)`; 
    
    const scoreElement = $('#score');
    if (scoreElement) {
        scoreElement.innerHTML = `Total Points: <span id="totalPoints">+${totalPoints}</span>`;
    }
    
    if (progressPct === 100 && totalCount > 0) {
        if (!safeGet('poc:completed:notified', false)) {
             toast('Congratulations! All assigned tasks completed!', { type: 'success', duration: 4000 });
             safeSet('poc:completed:notified', true);
        }
    } else {
         safeSet('poc:completed:notified', false);
    }
}


/* ---------------- task rendering & filters ---------------- */

let currentFilters = {
    core: new Set(),
    stage: new Set(),
    tags: new Set(),
};

function toggleDropdownPanel(event) {
    const button = event.currentTarget;
    const multiSelectEl = button.closest('.custom-multi-select');
    const panel = multiSelectEl ? multiSelectEl.querySelector('.dropdown-panel') : null;
    
    if (panel) {
        $$('.dropdown-panel:not(.hide)').forEach(openPanel => {
            if (openPanel !== panel) {
                openPanel.classList.add('hide');
            }
        });
        panel.classList.toggle('hide');
    }
    resetActivityTimer(); // Reset timer on interaction
}

function updateFilterBadges() {
    ['core', 'stage', 'tags'].forEach(filterType => {
        const container = $(`#${filterType}Filter`); 
        if (!container) return;
        const button = container.querySelector('.select-btn');
        if (!button) return;
        const badge = button.querySelector('.count-badge');
        if (!badge) return;
        
        const count = currentFilters[filterType].size;
        
        if (count > 0) {
            badge.textContent = `${count} selected`;
            badge.classList.remove('hide');
            button.classList.add('active'); 
        } else {
            badge.classList.add('hide');
            button.classList.remove('active');
        }
    });
}

function renderFilters() {
    const allTasks = TASKS; 
    const allocatedInternalValues = {
        core: new Set(ALLOCATED_TASKS.map(t => t.primary_core)),
        stage: new Set(ALLOCATED_TASKS.map(t => t.stage)),
        tags: new Set(ALLOCATED_TASKS.flatMap(t => t.tags))
    };

    const coreFilterContainer = $('#coreFilter');
    const stageFilterContainer = $('#stageFilter');
    const tagFilterContainer = $('#tagsFilter'); 

    if (!coreFilterContainer || !stageFilterContainer || !tagFilterContainer) return;

    const generateDropdownItemHtml = (display, internal, filterType) => {
        const id = `filter-${filterType}-${internal}`;
        const isChecked = currentFilters[filterType].has(internal);
        const checkedAttr = isChecked ? 'checked' : '';
        
        const isAvailable = allocatedInternalValues[filterType].has(internal);
        const unavailableClass = isAvailable ? '' : 'unavailable';
        const disabledAttr = isAvailable ? '' : 'disabled';
        
        return `
            <div class="dropdown-item ${unavailableClass}">
                <input type="checkbox" id="${id}" data-filter-type="${filterType}" data-filter-value="${internal}" class="filter-checkbox" ${checkedAttr} ${disabledAttr}>
                <label for="${id}">${display}</label>
            </div>
        `;
    };
    
    const renderDropdown = (containerEl, map, filterType, filterNameDisplay) => {
        const panelEl = containerEl.querySelector('.dropdown-panel');
        const buttonEl = containerEl.querySelector('.select-btn');
        const filterNameEl = buttonEl.querySelector('.filter-name');

        if (!panelEl || !filterNameEl) return;
        
        filterNameEl.textContent = filterNameDisplay;
        panelEl.innerHTML = '';
        
        Array.from(map).sort((a, b) => {
            const displayA = Array.isArray(a) ? a[0] : a;
            const displayB = Array.isArray(b) ? b[0] : b;
            return displayA.localeCompare(displayB);
        }).forEach(item => {
            const [display, internal] = Array.isArray(item) ? item : [item, item];
            panelEl.innerHTML += generateDropdownItemHtml(display, internal, filterType);
        });

        if (buttonEl) {
            buttonEl.removeEventListener('click', toggleDropdownPanel);
            buttonEl.addEventListener('click', toggleDropdownPanel);
        }
    };

    // 1. Core Filter
    const coreThemes = new Map(allTasks.map(t => [t.primary_core_display, t.primary_core]));
    renderDropdown(coreFilterContainer, coreThemes, 'core', 'Core Theme');
    
    // 2. Stage Filter
    const stages = new Map(allTasks.map(t => [t.stage_display, t.stage]));
    renderDropdown(stageFilterContainer, stages, 'stage', 'Stage');

    // 3. Tag Filter (Subcategory)
    const tags = new Set(allTasks.flatMap(t => t.tags_display).filter(t => t && t.trim() !== '')); 
    const tagMap = Array.from(tags).map(tag => {
        const internalTag = normalizeTasks([{subcategory: tag}])[0].tags[0];
        return [tag, internalTag];
    });
    renderDropdown(tagFilterContainer, tagMap, 'tags', 'Sub Category');

    $$('.filter-checkbox').forEach(checkbox => {
        checkbox.removeEventListener('change', handleFilterChange);
        checkbox.addEventListener('change', handleFilterChange);
    });

    updateFilterBadges();
    
    document.removeEventListener('click', handleDocumentClick);
    document.addEventListener('click', handleDocumentClick);
}

function handleDocumentClick(event) {
    const isClickInsideDropdown = event.target.closest('.custom-multi-select');
    if (!isClickInsideDropdown) {
        $$('.dropdown-panel').forEach(panel => {
            panel.classList.add('hide');
        });
    }
}

function handleFilterChange(event) {
    const checkbox = event.currentTarget;
    if (checkbox.disabled) {
        event.preventDefault(); 
        return;
    }
    
    const filterType = checkbox.dataset.filterType;
    const filterValue = checkbox.dataset.filterValue;

    if (filterType && filterValue) {
        if (checkbox.checked) {
            currentFilters[filterType].add(filterValue);
        } else {
            currentFilters[filterType].delete(filterValue);
        }
    }
    updateFilterBadges(); 
    applyFilters();
    resetActivityTimer(); // Reset timer on interaction
}

function applyFilters() {
    
    const allocatedTasks = ALLOCATED_TASKS; 
    const filteredTasks = filterTasks(allocatedTasks, currentFilters);

    renderTasks(filteredTasks);

    updateURLState();
}

function updateURLState() {
    const rawUrlParams = new URLSearchParams();
    
    if (currentUserName) {
        rawUrlParams.set('name', currentUserName);
    }
    // CRITICAL FIX: Ensure TESTER_ID is always present in URL state
    if (TESTER_ID) {
        rawUrlParams.set('tester_id', TESTER_ID);
    }
    
    if (currentFilters.core.size > 0) {
        rawUrlParams.set('core', Array.from(currentFilters.core).join(','));
    }
    if (currentFilters.stage.size > 0) {
        rawUrlParams.set('stage', Array.from(currentFilters.stage).join(','));
    }
    if (currentFilters.tags.size > 0) {
        rawUrlParams.set('tags', Array.from(currentFilters.tags).join(','));
    }

    const newUrl = `${location.pathname}?${rawUrlParams.toString()}`;
    window.history.replaceState(null, '', newUrl);
}

function filterTasks(tasks, filters) {
    let filtered = tasks;
    
    if (filters.core.size > 0) {
        filtered = filtered.filter(t => filters.core.has(t.primary_core));
    }

    if (filters.stage.size > 0) {
        filtered = filtered.filter(t => filters.stage.has(t.stage));
    }
    
    if (filters.tags.size > 0) {
        filtered = filtered.filter(t => {
            return t.tags.some(tag => filters.tags.has(tag));
        });
    }

    return filtered;
}

function generateTaskHtml(task) {
    const isDone = isTaskDone(task.id);
    const taskVote = getTaskVote(task.id);
    const taskComment = getTaskComment(task.id); 
    const likeActive = taskVote === 'like' ? 'active' : '';
    const dislikeActive = taskVote === 'dislike' ? 'active' : '';
    const completedClass = isDone ? 'task-done' : '';
    const checkedAttr = isDone ? 'checked' : '';
    
    let coreColorClass = '';
    if (task.primary_core === 'connectingbelonging') coreColorClass = 'core-connect';
    else if (task.primary_core === 'actingmotivating') coreColorClass = 'core-act';
    else if (task.primary_core === 'reflectinglearning') coreColorClass = 'core-reflect';
    else if (task.primary_core === 'creatingcircularity') coreColorClass = 'core-create';

    let stageColorClass = '';
    if (task.stage === 'seeds') { stageColorClass = 'stage-seeds'; }
    else if (task.stage === 'sprout') { stageColorClass = 'stage-sprout'; }
    else if (task.stage === 'bloom') { stageColorClass = 'stage-bloom'; }


    const tagsHtml = task.tags_display.map(tag =>
        `<span class="pill tag-pill">${tag}</span>`
    ).join('');
    
    const audienceHtml = task.audience_display ? `<span class="pill audience-pill">${task.audience_display}</span>` : '';
    
    const commentHtml = `
        <div class="task-comment-wrap">
            <label for="comment-input-${task.id}" class="comment-label">Your Comment</label>
            <div class="comment-input-group">
                <input 
                    type="text" 
                    id="comment-input-${task.id}" 
                    class="task-comment-input" 
                    placeholder="Enter your thoughts..." 
                    value="${taskComment}" 
                />
                <button 
                    class="btn comment-save-btn" 
                    data-task-id="${task.id}" 
                    type="button"
                >
                    Save
                </button>
            </div>
        </div>
    `;


    return `
        <div class="task-item card ${completedClass}" data-task-id="${task.id}" role="listitem">
            
            <div class="task-checkbox-wrap-outer">
                <input type="checkbox" data-task-id="${task.id}" ${checkedAttr} class="task-done-checkbox" id="checkbox-${task.id}">
            </div>

            <div class="task-content">
                <div class="task-title-score-wrap">
                    <label for="checkbox-${task.id}" class="task-text">${task.text}</label>
                </div>

                <div class="task-pills-wrap">
                    <div class="task-score-green">+${task.score}</div>
                    <span class="pill ${coreColorClass}">${task.primary_core_display}</span>
                    <span class="pill ${stageColorClass}">${task.stage_display}</span>
                    ${audienceHtml}
                    ${tagsHtml}
                </div>
                
                <div class="task-details">
                    <p><strong>Impact:</strong> ${task.impactValue || 'N/A'}</p>
                    <p><strong>Source:</strong> ${task.source || 'N/A'}</p>
                    <p><strong>Confidence:</strong> ${task.confidence || 'N/A'}</p>
                </div>

                ${commentHtml} </div>
            
            <div class="task-actions">
                <button class="vote-btn like-btn ${likeActive}" data-vote-type="like" aria-label="Like this task">
                    <span>👍 Like</span>
                </button>
                <button class="vote-btn downvote-btn ${dislikeActive}" data-vote-type="dislike" aria-label="Dislike this task">
                    <span>👎 Dislike</span>
                </button>
            </div>
        </div>
    `;
}

function renderTasks(tasksToRender) {
    const tasksContainer = $('#tasks');
    const noMatchMessage = $('#noMatchMessage');
    const progressWrap = $('#progressWrap');
    if (!tasksContainer || !noMatchMessage || !progressWrap) return;

    if (tasksToRender.length === 0) {
        tasksContainer.innerHTML = '';
        progressWrap.classList.add('hide'); 
        
        noMatchMessage.innerHTML = `
            <h3>No tasks match these filters.</h3>
            <p>Try clearing or adjusting your filter selections.</p>
        `;
        noMatchMessage.classList.remove('hide');

    } else {
        progressWrap.classList.remove('hide'); 
        noMatchMessage.classList.add('hide');
        noMatchMessage.innerHTML = '';

        tasksContainer.innerHTML = tasksToRender.map(task => 
            generateTaskHtml(task)
        ).join('');
        
        tasksContainer.querySelectorAll('.vote-btn').forEach(button => {
            button.removeEventListener('click', handleVote); 
            button.addEventListener('click', handleVote);
        });
        
        tasksContainer.querySelectorAll('.comment-save-btn').forEach(button => {
            button.removeEventListener('click', handleCommentSave); 
            button.addEventListener('click', handleCommentSave);
        });

        tasksContainer.querySelectorAll('.task-done-checkbox').forEach(checkbox => {
            checkbox.removeEventListener('change', handleTaskCompletion); 
            checkbox.addEventListener('change', handleTaskCompletion);
        });
    }
    
    updateProgress(); 
    $('#saveMsg').textContent = `Tasks loaded/synced. Last update: ${new Date().toLocaleTimeString()}`;
}

/* ---------------- session / login / local state ---------------- */
let currentUserName = safeGet('poc:name');
let currentUserEmail = safeGet('poc:email'); 
const infoCard = document.getElementById('infoCard');
const loginForm = $('#loginForm');
const loginCard = $('#loginCard');
const appCard = $('#appCard');
const greeting = $('#greeting');
const nameInput = $('#name');
const emailInput = $('#email'); 
const feedbackBtn = $('#feedbackBtn');

// New global variables for session management
let sessionTimeoutId;
let lastActivityTime = Date.now();
// ADDED: List of events that reset the activity timer for robust tracking
const activityEvents = ['mousemove', 'keypress', 'scroll', 'click', 'touchstart']; 

// Utility function to reset the UI to the login screen
function resetAppToLogin() {
    // FIX: Remove all activity listeners on logout to prevent memory leaks and redundant timers
    activityEvents.forEach(event => { 
        document.removeEventListener(event, resetActivityTimer); 
    });
    
    clearTimeout(sessionTimeoutId);
    
    // Check if the app is currently visible before resetting
    if (appCard && !appCard.classList.contains('hide')) {
        toast('Session expired due to inactivity. Please log in again.', { type: 'warning', duration: 3000 });
        
        // CRITICAL FIX: Clear local storage to enforce re-login
        localStorage.removeItem('poc:name');
        localStorage.removeItem('poc:email');
        localStorage.removeItem(UID_KEY); // UID_KEY is 'poc:uid'
        
        // Reset global state
        currentUserName = null;
        currentUserEmail = null;
    }
    
    // Hide app, show login
    if (loginCard) loginCard.classList.remove('hide');
    if (infoCard) infoCard.classList.remove('hide'); // Show info card
    if (appCard) appCard.classList.add('hide');
    
    // The form inputs will automatically be populated from localStorage on next load
}

// Function to handle activity and reset the timer
function resetActivityTimer() {
    if (appCard && appCard.classList.contains('hide')) {
        // Don't start/reset the timer if the user isn't logged in
        return;
    }
    
    lastActivityTime = Date.now();
    clearTimeout(sessionTimeoutId);
    
    sessionTimeoutId = setTimeout(resetAppToLogin, SESSION_TIMEOUT_MS);
}

// Function to attach listeners for activity (runs once on successful login)
function setupActivityListeners() {
    // FIX: Use the new comprehensive list of events including 'click' and 'touchstart'
    activityEvents.forEach(event => {
        document.removeEventListener(event, resetActivityTimer); // Ensure no duplicates
        document.addEventListener(event, resetActivityTimer);
    });
    
    // Immediately start the first timer
    resetActivityTimer(); 
}


/**
 * The main function to transition from login to app view.
 */
async function start(name, email) {
    
    // 1. NEW: Check if email is in the approved tester list
    let requiredTesterId = new URLSearchParams(location.search).get('tester_id');
    const lookupEmail = email.toLowerCase();

    // Only perform the email check if we don't have a pre-defined tester_id from the URL
    if (!requiredTesterId || requiredTesterId === 'FALLBACK_TESTER') {
        const foundTesterId = await checkTesterEmail(lookupEmail);
        
        if (!foundTesterId) {
            // FAILED LOGIN: Show error pop up and halt
            const contactEmail = 'contact@pollenpop.com'; // Placeholder contact email
            await showModalMessage(
                `We could not find an account for <strong>${email}</strong>.<br><br>Please reach out to ${contactEmail} to register for the trial.`, 
                true
            );
            loginForm.reset(); // Clear the form
            return; 
        }
        requiredTesterId = foundTesterId;
    }
    
    // 2. Set the global TESTER_ID and save locally/in session
    TESTER_ID = requiredTesterId;
    localStorage.setItem(UID_KEY, TESTER_ID);

    // 3. Load all tasks and user progress based on the confirmed TESTER_ID
    await initData(); 

    if (TASKS.length === 0) {
        if (loginCard) loginCard.classList.remove('hide');
        if (appCard) appCard.classList.add('hide');
        toast('Setup failed. Could not load tasks. Check data source.', { type: 'error' });
        return; 
    }
    
    // 4. Update local storage and RTDB for the successful login
    safeSet('poc:name', name);
    safeSet('poc:email', lookupEmail);
    currentUserName = name;
    currentUserEmail = lookupEmail;
    
    if (db) {
        const userRef = db.ref(`users/${TESTER_ID}`);
        userRef.update({
            name: name,
            email: lookupEmail,
            testerId: TESTER_ID,
            lastLogin: Date.now()
        }).catch(e => console.error("RTDB user data write error:", e));
    }

    // 5. Update URL state and UI
    const currentParams = new URLSearchParams(location.search);
    currentParams.set('name', name);
    currentParams.set('tester_id', TESTER_ID);
    const newUrl = `${location.pathname}?${currentParams.toString()}`;
    window.history.replaceState(null, '', newUrl);

    if (greeting) {
      greeting.textContent = `Hi ${name.split(' ')[0]}, here are your tasks:`;
    }
    
    if (loginCard) loginCard.classList.add('hide');
    if (infoCard) infoCard.classList.add('hide'); // Hide info card on tasks page
    if (appCard) appCard.classList.remove('hide');

    renderFilters(); 
    initFiltersFromURL(); 
    applyFilters(); 
    
    // Setup the activity timer after successful login
    setupActivityListeners(); 

    await updateQR(name);
    toast('App ready!', { type: 'success', duration: 1200 });
}


loginForm.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const name = nameInput.value.trim();
    const email = emailInput.value.trim(); 
    
    if (name && email) {
        // IMPORTANT: Start function now handles the email check and ID assignment
        await start(name, email); 
    } else {
        toast('Please enter your name and email.', { type: 'error' });
    }
});

function initFiltersFromURL() {
    const params = new URLSearchParams(location.search);
    
    const getFilterSetFromURL = (param) => {
        const value = params.get(param);
        return value ? new Set(value.split(',').filter(v => v.trim() !== '')) : new Set();
    };

    currentFilters.core = getFilterSetFromURL('core');
    currentFilters.stage = getFilterSetFromURL('stage');
    currentFilters.tags = getFilterSetFromURL('tags');
    
    renderFilters();
}

async function updateQR(name) {
  const qrContainer = $('#qrcode');
  if (!qrContainer) return;

  const url = window.location.href; 

  qrContainer.innerHTML = '';
  try {
    const libReady = await ensureQRLib();
    if (libReady) {
      new QRCode(qrContainer, {
        text: url,
        width: 128,
        height: 128,
        colorDark: '#000000',
        colorLight: '#ffffff',
        correctLevel: QRCode.CorrectLevel.H,
      });
      $('#qrHint').textContent = 'Scan to open this page and your saved session.';
    } else {
      qrContainer.textContent = 'QR Code library failed to load.';
    }
  } catch (err) {
    console.error('updateQR', err);
  }
}

function ensureQRLib(timeout = 4000) {
  if (window.QRCode) return Promise.resolve(true);
  return new Promise((resolve) => {
    const check = () => {
      if (window.QRCode) return resolve(true);
      if (Date.now() - start > timeout) return resolve(false);
      setTimeout(check, 120);
    };
    const start = Date.now();
    setTimeout(check, 120);
  });
}

feedbackBtn.addEventListener('click', async () => {
  const confirmed = await showModalMessage('You are being redirected to a **trail Form** to submit feedback.');
  
  if (confirmed) {
    window.open(FEEDBACK_FORM_URL, '_blank');
    toast('Opening trail Form...', { type: 'success' });
  }
  resetActivityTimer(); // Reset timer on interaction
});

// Initial Load Logic
const params = new URLSearchParams(location.search);
const initialName = params.get('name') || safeGet('poc:name');
const initialEmail = safeGet('poc:email'); 
const initialTesterId = params.get('tester_id'); 

if (initialTesterId) {
    TESTER_ID = initialTesterId;
    localStorage.setItem(UID_KEY, TESTER_ID);
}

if (initialName && initialEmail) {
    nameInput.value = initialName;
    emailInput.value = initialEmail;
    
    // When re-loading the page, we allow the session to start immediately based on local storage
    // The main email check is skipped here, assuming the user was already authenticated.
    // However, if the URL has a tester_id, the app uses that.
    start(initialName, initialEmail); 
} else {
    // Show login card
    if (loginCard) loginCard.classList.remove('hide');
    if (infoCard) infoCard.classList.remove('hide'); // Show info card on login page
    if (appCard) appCard.classList.add('hide');
}


/* ---------------- NEW FEEDBACK FORM LOGIC ---------------- */

// Helper function to safely get data from existing global state
function getAutofillData() {
    // These global variables are already populated by the login logic in this app.js
    const testerId = TESTER_ID || 'UNKNOWN';
    const userName = currentUserName || `Tester (${testerId})`;
    const userEmail = currentUserEmail || 'N/A';
    
    return { testerId, userName, userEmail };
}

// Function to handle the Firebase submission for the feedback form
function handleFeedbackSubmit(e) {
    e.preventDefault();
    
    const statusElement = document.getElementById('feedbackStatus');
    const formEl = document.getElementById('feedbackForm');
    const submitBtn = document.getElementById('submitFeedbackBtn');
    
    // Disable form and show status
    statusElement.style.color = 'var(--fg)';
    statusElement.textContent = 'Submitting...';
    submitBtn.disabled = true;

    const testerId = document.getElementById('feedbackTesterId').value;
    const name = document.getElementById('feedbackName').value;
    const email = document.getElementById('feedbackEmail').value;
    const message = document.getElementById('feedbackMessage').value;

    if (!message || message.trim() === '') {
        statusElement.style.color = 'var(--danger)';
        statusElement.textContent = 'Feedback message cannot be empty.';
        submitBtn.disabled = false;
        return;
    }

    const feedbackData = {
        testerId: testerId || 'UNKNOWN',
        name: name || 'N/A',
        email: email || 'N/A',
        message: message.trim(),
        timestamp: firebase.database.ServerValue.TIMESTAMP,
        version: VERSION 
    };

    // Save to a dedicated 'session_feedback' node
    const dbRef = firebase.database().ref('session_feedback'); 
    
    dbRef.push(feedbackData)
        .then(() => {
            statusElement.style.color = 'var(--success)';
            statusElement.textContent = 'Thank you! Your feedback has been submitted successfully.';
            document.getElementById('feedbackMessage').value = ''; 
            submitBtn.textContent = 'Feedback Submitted';
            submitBtn.style.backgroundColor = 'var(--success)'; 
            // Prevent re-submission by removing the listener
            formEl.removeEventListener('submit', handleFeedbackSubmit);
        })
        .catch((error) => {
            console.error("Error writing feedback: ", error);
            statusElement.style.color = 'var(--danger)';
            statusElement.textContent = 'Submission failed. Please try again.';
            submitBtn.disabled = false;
            submitBtn.textContent = 'Submit Feedback'; 
        });
}


/* ---------------- Modal content and Display Logic (Modified) ---------------- */

// Modal content data structure with cleaned content
const modalContent = {
    faqModal: {
        title: "Tester FAQ",
        body: `
            <h3>1. How do I log in?</h3>
            <p>You will receive a unique tester link or QR code connected to your Tester ID. Use that link only. Do not share it. If the link breaks, contact us through the Support Form on the website.</p>

            <h3>2. I forgot my Tester ID. What do I do?</h3>
            <p>Your Tester ID appears: in your onboarding email and at the top of your task dashboard. If you lose it, submit a support request. We can verify and resend it.</p>

            <h3>3. I can’t access the site. What should I check?</h3>
            <p>Run through this quick checklist: Refresh your browser, try an alternative browser (Chrome/Safari recommended), ensure you’re using your correct unique link, check your Wi-Fi/data connection. If the issue persists, send a direct email to admin@hivenectar.earth.</p>
            
            <h3>4. How do I complete a task?</h3>
            <p>Each task opens in your dashboard. Follow these steps: Read the task description, complete the action, submit the task via the Task Form (linked inside the dashboard). Your points and progress update automatically within the system.</p>

            <h3>5. My task didn’t register. Why?</h3>
            <p>Likely causes: Task form submitted without the correct Tester ID, duplicate or incomplete form, slow syncing between the Task Form → Database → Dashboard. If your task hasn’t appeared after 24 hours, submit a support form.</p>

            <h3>6. What if the task seems unclear or confusing?</h3>
            <p>Submit a support form or contact send an email to: admin@hivenectar.earth</p>
            
            <h3>7. Can I redo or repeat tasks?</h3>
            <p>No. Each task is tied to a unique prompt ID and counts once, so for the scoring system, you can only account for once. Yes. You can redo the task yourself to build a habit and please share the experience with us. If you submitted incorrectly, submit a support request and we will review the entry.</p>

            <h3>8. How are points calculated?</h3>
            <p>Your points are based on: The Stage of the task and the difficulty – The level of involvement and how you influence the idea to your peers. The system applies this automatically. You cannot manually adjust points.</p>

            <h3>9. Where can I see my progress?</h3>
            <p>Your dashboard includes: Total points, completed tasks, last activity date, and Impact summary. This updates automatically once your task form is synced. For the trial, you are only required to perform 5 tasks to be considered completed, but feel free to do other tasks if you’re enjoying it. Please share the experience.</p>
            
            <h3>10. I found a bug. What do I do?</h3>
            <p>Click “Report a Bug” in the footer or dashboard menu. Please include: What you were trying to do, what went wrong, and a screenshot if possible. We prioritise bugs affecting task submission and scoring.</p>

            <h3>11. Can I switch devices?</h3>
            <p>Yes. Your link is tied to your Tester ID, not your device. Just use the same link on any phone, tablet, or computer.</p>

            <h3>12. What if my link stops working?</h3>
            <p>Submit a support request. We can reissue a secure version of your link and lock the old one.</p>
            
            <h3>13. How long will the trial run?</h3>
            <p>The trial runs in controlled phases. Your dashboard will show your phase timeline. We will notify testers directly before any major update.</p>

            <h3>14. Can I invite other testers?</h3>
            <p>No. Please do not share your link, dashboard, or tasks publicly. This trial is closed and invitation-only to protect data quality. You can direct other testers to our official trial enrolment form, if the trial is still open for participants.</p>

            <h3>15. Who do I contact for support?</h3>
            <p>Use the Support Form on the trial website. Messages related to tasks, bugs, login issues, or clarification will be prioritised. For urgent matters, please send an email directly to admin@hivenectar.earth.</p>
        `
    },
    trailDataModal: {
        title: "TRAIL DATA",
        body: `
            <p>By participating in The Hive Nectar Trial, you acknowledge that your data is collected for the trial's operation, specifically:</p>
            <ul>
                <li>Your Tester ID, task submissions, timestamps and interaction data will be collected to operate the trial.</li>
                <li>Data flows through Tally Forms, Google Sheets, and our internal dashboards.</li>
                <li>Points, task validation and progress updates are automated processes.</li>
                <li>Your data helps us identify bugs, refine clarity, and improve overall system design.</li>
                <li>Your personal link is unique to you. Do not share it.</li>
                <li>All trial data is confidential and used only for internal improvement.</li>
            </ul>
            <p>For full details, please refer to our Privacy Policy.</p>
        `
    },
    privacyModal: {
        title: "PRIVACY POLICY SUMMARY",
        body: `
            <p>This Privacy Policy applies to all personal information collected by The Hive Nectar via our public website and our tester-only trial website, apps, forms and dashboards (the Platform). By accessing or using any part of the Platform, you consent to the practices described in this policy.</p>
            
            <h3>Information We Collect</h3>
            <p>We may collect personal information (Name, Email address, Tester ID, Task submissions) and Usage & Behavioural Information (Tasks viewed, Submission timestamps, Points earned, Interaction patterns, Log data) to analyse performance, improve task clarity, and refine the trial system.</p>
            
            <h3>Purpose of Collection</h3>
            <p>We collect personal information to provide access to the Platform, manage Tester IDs, process task submissions, calculate points, perform analytics, identify bugs, communicate updates, and improve functionality.</p>
            
            <h3>Data Security & Retention</h3>
            <p>We take reasonable steps to protect your data. Trial data may be stored for up to 12 months for analysis. Personal information for record-keeping may be retained for up to 7 years.</p>
            
            <h3>Access & Contact</h3>
            <p>You may request access to or correction of personal information we hold about you. For questions or requests, please contact: <strong>admin@hivenectar.earth</strong>.</p>
        `
    },
    contactModal: {
        title: "Contact Information",
        body: `
            <p>For all urgent communication during the trial, please use the email below:</p>
            
            <h3>Primary Support Email:</h3>
            <p><strong>admin@hivenectar.earth</strong></p>
            <p>Use for: Login issues, Tester ID problems, urgent access concerns, or errors preventing task submission.</p>
            <p>Response Time: 24–48 hours. Access-related issues are prioritised.</p>
            
            <p><strong>Important:</strong> Please do not send task responses, ideas, or non-urgent feedback via email. Use the designated forms (or the Support link) to ensure your input is processed correctly.</p>
        `
    },
    supportModal: {
        title: "Need Support?",
        body: `
            <p>For technical help, bug reports, or clarification on tasks, please use the Support Form (link usually on the dashboard).</p>
            
            <h3>Support Form is for:</h3>
            <ul>
                <li>Reporting bugs</li>
                <li>Requesting clarification on unclear tasks</li>
                <li>General technical issues (e.g., scoring discrepancies)</li>
            </ul>
            <p>Using the form helps us track and resolve problems faster.</p>

            <h3>Urgent Email Support</h3>
            <p>For urgent matters, such as login issues or errors preventing task submission, please use the primary email: <strong>admin@hivenectar.earth</strong></p>
        `
    },
    // Modified body to serve as a placeholder for dynamic content injection
    endSessionFeedbackModal: {
        title: "End-of-Session Feedback",
        body: `<p>Loading feedback form...</p>` 
    }
};

// --- Modal Display Logic (Modified) ---

// Elements
const modalOverlay = document.getElementById('modalOverlay');
const modalTitle = document.getElementById('modalTitle');
const modalBody = document.getElementById('modalBody');
const modalCloseBtn = document.querySelector('.modal-close-btn');

// Show Modal function (Modified to handle the dynamic feedback form)
function showModal(id) {
    const content = modalContent[id];

    if (!content) {
        modalTitle.textContent = "Information Not Found";
        modalBody.innerHTML = "<p>The content for this section is currently unavailable.</p>";
    } else {
        modalTitle.textContent = content.title;
        
        // --- START NEW FEEDBACK FORM LOGIC ---
        if (id === 'endSessionFeedbackModal') {
            const { testerId, userName, userEmail } = getAutofillData();
            
            // Form HTML structure - Autofill is done via the 'value' attribute here.
            // Inline styles used to ensure minimal impact on existing CSS and maintain consistency.
            const feedbackFormHTML = `
                <form id="feedbackForm" style="text-align: left; padding: 10px;">
                    <p style="margin-top: 0; color: var(--fg);">Thank you for participating! Please use the form below to submit your end-of-session feedback.</p>
                    
                    <div style="margin-bottom: 15px;">
                        <label for="feedbackName" style="display: block; font-weight: bold; margin-bottom: 5px; color: var(--fg);">Name:</label>
                        <input type="text" id="feedbackName" name="name" required readonly 
                               value="${userName}"
                               style="width: 100%; padding: 10px; border: 1px solid #ccc; border-radius: 8px; box-sizing: border-box; background-color: #f0f0f0; color: var(--muted); font-weight: 600;">
                    </div>
                    
                    <div style="margin-bottom: 15px;">
                        <label for="feedbackEmail" style="display: block; font-weight: bold; margin-bottom: 5px; color: var(--fg);">Email:</label>
                        <input type="email" id="feedbackEmail" name="email" required readonly 
                               value="${userEmail}"
                               style="width: 100%; padding: 10px; border: 1px solid #ccc; border-radius: 8px; box-sizing: border-box; background-color: #f0f0f0; color: var(--muted); font-weight: 600;">
                    </div>
                    
                    <div style="margin-bottom: 15px;">
                        <label for="feedbackMessage" style="display: block; font-weight: bold; margin-bottom: 5px; color: var(--fg);">Your Feedback (required):</label>
                        <textarea id="feedbackMessage" name="message" rows="5" required 
                                  placeholder="Enter your thoughts on the session here..."
                                  style="width: 100%; padding: 10px; border: 1px solid #ccc; border-radius: 8px; box-sizing: border-box; resize: vertical;"></textarea>
                    </div>
                    
                    <input type="hidden" id="feedbackTesterId" name="testerId" value="${testerId}">
                    
                    <button type="submit" id="submitFeedbackBtn" class="btn" style="width: 100%; max-width: none; margin-top: 5px; background-color: var(--cta); color: white; font-weight: 700; font-size: 16px; border: none; border-radius: 10px; padding: 10px 20px; cursor: pointer; transition: background-color 0.2s;">
                        Submit Feedback
                    </button>
                </form>
                <p id="feedbackStatus" style="margin-top: 10px; font-weight: bold; text-align: center; color: var(--fg); min-height: 1.5em;"></p>
            `;
            
            modalBody.innerHTML = feedbackFormHTML;

            // Attach submit listener *after* injection.
            setTimeout(() => {
                const formEl = document.getElementById('feedbackForm');
                if (formEl) {
                    // Remove any potential previous listeners to prevent multiple submissions
                    formEl.removeEventListener('submit', handleFeedbackSubmit);
                    formEl.addEventListener('submit', handleFeedbackSubmit);
                }
            }, 0); 
            
        } else {
            // Original logic for other modals
            modalBody.innerHTML = content.body;
        }
        // --- END NEW FEEDBACK FORM LOGIC ---
    }

    // Show the modal
    modalOverlay.classList.remove('hide');
    // For accessibility: trap focus inside the modal
    modalCloseBtn.focus();
}

// Hide Modal function
function hideModal() {
    modalOverlay.classList.add('hide');
}

// Event Listeners for opening and closing
document.addEventListener('click', (e) => {
    // Check if a footer link was clicked
    if (e.target.matches('.footer-links a')) {
        e.preventDefault();
        const modalId = e.target.getAttribute('data-modal-id');
        showModal(modalId);
    }
    
    // Check if the close button was clicked
    if (e.target.matches('.modal-close-btn')) {
        hideModal();
    }
});

// Event Listener for clicking outside the modal to close it (on the overlay)
if (modalOverlay) {
    modalOverlay.addEventListener('click', (e) => {
        // Only close if the click is directly on the overlay, not on the modal content
        if (e.target === modalOverlay) {
            hideModal();
        }
    });
}

// Event Listener for the ESC key to close modal
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !modalOverlay.classList.contains('hide')) {
        hideModal();
    }
});