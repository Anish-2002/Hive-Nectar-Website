// app.js - unified logic with live updates and dropdown filters (V1.4-MODAL-FIXED)

const OUTBOX_KEY = 'poc:outbox';
const UID_KEY = 'poc:uid';
const NAME_KEY_PREFIX = 'poc:done:';
const VOTES_KEY_PREFIX = 'poc:votes:';
const VERSION = '1.4-MODAL-FIXED'; 
const ENDPOINT = ''; // optional server endpoint
const TASK_DATA_FILE = 'tasks_master.json'; // External JSON file name (MUST EXIST)

/* ---------------- Configuration Update ---------------- */
const FEEDBACK_FORM_URL = 'https://docs.google.com/forms/d/e/1FAIpQLSdofOkktqnShUm4emsW-ZdOhxfyycKfg4TVsryWo-tsYi6NVQ/viewform?usp=header';

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
  catch { return localStorage.getItem(UID_KEY) || 'p_' + Math.random().toString(36).slice(2,10); }
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
  setTimeout(() => el.remove(), opts.duration || 3000);
}

// Custom modal implementation (FIXED for reliable pop-up appearance)
function showConfirm(message) {
  return new Promise(resolve => {
    const modal = document.createElement('div');
    modal.className = 'custom-modal-backdrop';
    
    // CSS definition for the modal pop-up appearance
    const style = document.createElement('style');
    style.textContent = `
      .custom-modal-backdrop { 
          position: fixed; 
          top: 0; left: 0; 
          width: 100%; height: 100%; 
          background: rgba(0, 0, 0, 0.6); 
          display: flex; 
          justify-content: center; 
          align-items: center; 
          z-index: 9999; /* High z-index for visibility */
      }
      .custom-modal-content { 
          background: white; 
          padding: 25px; 
          border-radius: 12px; 
          box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3); 
          max-width: 90%; 
          width: 300px; 
          text-align: center; 
          /* Optional: Animate modal entry */
          transform: scale(1);
          animation: modal-in 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275);
      }
      @keyframes modal-in {
        from { transform: scale(0.7); opacity: 0; }
        to { transform: scale(1); opacity: 1; }
      }
      .custom-modal-actions { 
          margin-top: 15px; 
      }
      .custom-modal-content p { 
          margin: 0 0 15px; 
          font-weight: 600; 
      }
    `;
    document.head.appendChild(style);

    const closeModal = () => {
      document.body.removeChild(modal);
      document.head.removeChild(style);
    };

    modal.innerHTML = `
      <div class="custom-modal-content">
        <p>${message}</p>
        <div class="custom-modal-actions">
          <button id="modalConfirm" class="btn">OK</button>
        </div>
      </div>
    `;

    document.body.appendChild(modal);
    const confirmButton = modal.querySelector('#modalConfirm');
    
    confirmButton.addEventListener('click', () => {
      resolve(true); 
      closeModal();
    });
  });
}


/* ---------------- event queue ---------------- */
function queueEvent(evt) {
  const box = safeGet(OUTBOX_KEY, []);
  box.push({ ...evt, tester_id: TESTER_ID, ua: navigator.userAgent, version: VERSION, ts: Date.now() });
  safeSet(OUTBOX_KEY, box);
  // flushOutbox().catch(e => console.warn(e)); 
}


/* ---------------- tasks / filtering / scoring ---------------- */

// Scoring system
const STAGE_MULTIPLIER = {
    'seeds': 1,
    'sprout': 2,
    'bloom': 3,
};

const ENGAGEMENT_MULTIPLIER = {
    'easy': 1,
    'medium': 2,
    'hard': 3,
};

let TASKS = []; 

/**
 * Normalizes the raw task data by cleaning up emoji-laden fields 
 * for internal filtering/scoring and providing cleaned display fields.
 */
function normalizeTasks(rawTasks) {
    // Maps display names to internal names
    const CORE_MAP = {
        '🌱 Connecting / Belonging': 'connectingbelonging', 
        '⚡ Acting / Motivating': 'actingmotivating', 
        '🌙 Reflecting / Learning': 'reflectinglearning', 
        '✨ Creating / Circularity': 'creatingcircularity'
    };
    const STAGE_MAP = {
        '🌰 Seeds': { internal: 'seeds', level: 'easy' }, 
        '🌱 Sprout': { internal: 'sprout', level: 'medium' }, 
        '🌸 Bloom': { internal: 'bloom', level: 'hard' }
    };
    
    const cleanTag = (tag) => {
        if (!tag) return '';
        return tag.replace(/[^a-zA-Z0-9\s]/g, '').toLowerCase().trim().replace(/\s+/g, '');
    };
    
    return rawTasks.map(t => {
        const stageData = STAGE_MAP[t.stage] || { internal: 'seeds', level: 'easy' };
        
        // Ensure core_theme exists before accessing
        const rawCoreTheme = t.core_theme || '';
        const internalCore = CORE_MAP[rawCoreTheme] || cleanTag(rawCoreTheme);

        // Tags are derived from the 'subcategory' field
        const rawSubcategory = t.subcategory || '';
        const displayTags = rawSubcategory ? [rawSubcategory] : [];
        const internalTags = rawSubcategory ? [cleanTag(rawSubcategory)] : [];
        
        return {
            ...t,
            // Display fields (using raw data from JSON)
            primary_core_display: rawCoreTheme,
            stage_display: t.stage,
            audience_display: t.audience,
            tags_display: displayTags, 
            
            // Internal fields (cleaned for logic)
            primary_core: internalCore,
            stage: stageData.internal,
            engagement_level: stageData.level, 
            tags: internalTags, 
        };
    });
}

/**
 * Asynchronously loads task data from the external JSON file.
 */
async function loadTasks() {
    try {
        const response = await fetch(TASK_DATA_FILE);
        
        if (!response.ok) {
            console.error(`Failed to fetch master task file: ${TASK_DATA_FILE}. Status: ${response.status}`);
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        
        const rawTasks = await response.json();
        
        TASKS = normalizeTasks(rawTasks);

    } catch (error) {
        console.error('Error loading or parsing tasks:', error);
        toast(`Failed to load tasks from ${TASK_DATA_FILE}. Check file and console.`, { type: 'error' });
        TASKS = []; // Ensure TASKS is an empty array on failure
    }
}


/**
 * Removes emojis and any leading/trailing whitespace from a string for filtering/comparison.
 */
function cleanTagValue(str) {
    if (!str) return '';
    const shortName = str.includes('/') ? str.split('/')[0].trim() : str.trim();
    const cleaned = shortName.replace(/[^a-zA-Z0-9\s]/g, '').toLowerCase().trim().replace(/\s+/g, '');
    return cleaned;
}

/**
 * Debounce utility function (250ms delay).
 */
function debounce(func, delay) {
    let timeoutId;
    return function(...args) {
        clearTimeout(timeoutId);
        timeoutId = setTimeout(() => {
            func.apply(this, args);
        }, delay);
    };
}

/**
 * Calculates the total score based on completed tasks using the multiplier logic.
 */
function calculateTotalScore(name) {
    const done = safeGet(NAME_KEY_PREFIX + name, {});
    let totalScore = 0;
    
    TASKS.forEach(t => {
        if (done[t.id]) {
            const stageMult = STAGE_MULTIPLIER[t.stage] || 1; 
            const engagementMult = ENGAGEMENT_MULTIPLIER[t.engagement_level] || 1; 
            const taskScore = stageMult * engagementMult;
            totalScore += taskScore;
        }
    });
    return totalScore;
}

function updateScoreDisplay(name) {
    const score = calculateTotalScore(name);
    const scoreDisplay = $('#scoreDisplay');
    if (scoreDisplay) {
        scoreDisplay.textContent = `Total Points: +${score}`; 
    }
}

/**
 * Filters the task list based on the global currentFilter state (OR within, AND between).
 */
let currentFilter = { core: [], stage: [], tag: [] }; 
function filterTasks(allTasks) {
  const { core: selectedCores, stage: selectedStages, tag: selectedTags } = currentFilter;

  const hasCoreFilter = selectedCores.length > 0;
  const hasStageFilter = selectedStages.length > 0;
  const hasTagFilter = selectedTags.length > 0;

  if (!hasCoreFilter && !hasStageFilter && !hasTagFilter) {
    return allTasks;
  }
  
  return allTasks.filter(task => {
    let coreMatch = !hasCoreFilter || selectedCores.includes(task.primary_core);
    let stageMatch = !hasStageFilter || selectedStages.includes(task.stage);
    
    // Check if task.tags array contains any of the selectedTags (using the cleaned internal tags)
    let tagMatch = !hasTagFilter || (task.tags && task.tags.some(taskTag => selectedTags.includes(taskTag)));
    
    return coreMatch && stageMatch && tagMatch;
  });
}

const debouncedRenderTasks = debounce((name) => {
    renderTasks(name, filterTasks(TASKS));
}, 250);


/* ---------------- DOM refs and UI setup ---------------- */
const nameInput = $('#name');
const loginForm = $('#loginForm');
const loginCard = $('#loginCard');
const appCard = $('#appCard');
const greeting = $('#greeting');
const tasksEl = $('#tasks');
const saveMsg = $('#saveMsg');
const progressBar = $('#progressBar');
const progressPct = $('#progressPct');
const qrBox = $('#qrcode');
const qrHint = $('#qrHint');
const feedbackBtn = $('#feedbackBtn');

const coreFilterDropdown = $('#coreFilterDropdown');
const stageFilterDropdown = $('#stageFilterDropdown');
const tagFilterDropdown = $('#tagFilterDropdown'); 

const filterGroups = {
    core: { id: 'core', container: coreFilterDropdown, summary: $('#coreFilterSummary'), inputList: $('#coreFilterList') },
    stage: { id: 'stage', container: stageFilterDropdown, summary: $('#stageFilterSummary'), inputList: $('#stageFilterList') },
    tag: { id: 'tag', container: tagFilterDropdown, summary: $('#tagFilterSummary'), inputList: $('#tagFilterList') }
};

/**
 * Populates the UI with checkboxes and attaches change listeners.
 */
function populateFilterUI() {
    // These options must match the display names in the normalized TASKS data
    const options = {
        core: [
            { raw: '🌱 Connecting / Belonging', cleaned: 'connectingbelonging' },
            { raw: '⚡ Acting / Motivating', cleaned: 'actingmotivating' },
            { raw: '🌙 Reflecting / Learning', cleaned: 'reflectinglearning' },
            { raw: '✨ Creating / Circularity', cleaned: 'creatingcircularity' },
        ],
        stage: [
            { raw: '🌰 Seeds', cleaned: 'seeds' },
            { raw: '🌱 Sprout', cleaned: 'sprout' },
            { raw: '🌸 Bloom', cleaned: 'bloom' },
        ],
        tag: [] 
    };
    
    // Collect unique tags from the raw tag list (tags_display)
    const uniqueTags = new Set();
    TASKS.forEach(t => {
        // Collect tags from the display field (derived from subcategory)
        (t.tags_display || []).forEach(tag => uniqueTags.add(tag));
    });
    
    Array.from(uniqueTags).sort().forEach(tag => {
        // Use the cleaned value for the checkbox value
        const cleanedValue = cleanTagValue(tag);
        if (cleanedValue && !options.tag.find(o => o.cleaned === cleanedValue)) {
             options.tag.push({ raw: tag, cleaned: cleanedValue });
        }
    });
    
    for (const key in filterGroups) {
        const group = filterGroups[key];
        if (!group.inputList) continue; // Safety check
        group.inputList.innerHTML = ''; 
        
        options[key].forEach(opt => {
            const checkboxItem = document.createElement('label');
            checkboxItem.className = 'filter-item';
            
            // Use the CLEANED value for the input's 'value' attribute for filtering logic
            const filterValue = opt.cleaned;

            checkboxItem.innerHTML = `
                <input type="checkbox" name="${key}" value="${filterValue}" data-display-value="${opt.raw}">
                <span>${opt.raw}</span>
            `;
            group.inputList.appendChild(checkboxItem);
        });

        // Toggle dropdown visibility
        const header = group.container ? group.container.querySelector('.dropdown-header') : null;
        if (header) {
            header.addEventListener('click', (e) => {
                for (const otherKey in filterGroups) {
                    if (otherKey !== key && filterGroups[otherKey].container) {
                        filterGroups[otherKey].container.classList.remove('open');
                    }
                }
                group.container.classList.toggle('open');
                e.stopPropagation();
            });
        }

        // Listen for checkbox changes inside the list
        group.inputList.addEventListener('change', applyFilters);
    }
    
    // Close dropdown on outside click
    document.addEventListener('click', (e) => {
        if (!e.target.closest('.filter-dropdown')) {
            $$('.filter-dropdown').forEach(d => d.classList.remove('open'));
        }
    });
}

let currentUserName = '';

// Reinstating the login form handler
loginForm.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const name = nameInput.value.trim();
  if (!name) { nameInput.focus(); toast('Please enter a name', { type: 'error' }); return; }
  await start(name);
});

async function start(name) {
  // 1. Load tasks first (This must complete successfully)
  await loadTasks(); 
  
  if (TASKS.length === 0) {
      // Show an error and stay on the login screen if tasks failed to load
      if (loginCard) loginCard.classList.remove('hide');
      if (appCard) appCard.classList.add('hide');
      toast('Setup failed. Could not load tasks.', { type: 'error' });
      return; 
  }

  safeSet('poc:name', name);
  currentUserName = name;
  const key = NAME_KEY_PREFIX + name;
  if (!safeGet(key)) safeSet(key, {});

  // Update greeting with user's name
  if (greeting) {
    greeting.textContent = `Hi ${name.split(' ')[0]}, here are your tasks:`;
  }
  
  // Transition to the app view
  if (loginCard) loginCard.classList.add('hide');
  if (appCard) appCard.classList.remove('hide');

  // Setup and apply filters
  populateFilterUI(); 
  initFiltersFromURL();
  updateScoreDisplay(name);

  const filteredTasks = filterTasks(TASKS);
  renderTasks(name, filteredTasks);
  
  await updateQR(name);
  toast('App ready!', { type: 'success', duration: 1200 });
}


function initFiltersFromURL() {
  const params = new URLSearchParams(location.search);
  const newCurrentFilter = { core: [], stage: [], tag: [] };

  for (const key in filterGroups) {
    const group = filterGroups[key];
    const urlParamValue = params.get(key) || ''; 
    const selectedValues = urlParamValue ? urlParamValue.split(',').map(v => v.trim()) : [];
    
    if (group.inputList) {
      group.inputList.querySelectorAll(`input[type="checkbox"]`).forEach(checkbox => {
        // We use the 'value' attribute here, which is the internal, cleaned filter name
        const filterValue = checkbox.value; 
        const isChecked = selectedValues.includes(filterValue);
        checkbox.checked = isChecked;

        if (isChecked) {
          newCurrentFilter[key].push(filterValue);
        }
      });
    }
  }

  currentFilter = newCurrentFilter;
  updateFilterSummaries(); 
}


/**
 * Updates the summary text for each dropdown (e.g., "3 selected" or "All").
 */
function updateFilterSummaries() {
    for (const key in filterGroups) {
        const group = filterGroups[key];
        const count = currentFilter[key].length;
        // Count total checkboxes within the filter list
        const total = group.inputList ? group.inputList.querySelectorAll('input[type="checkbox"]').length : 0;
        
        let summaryText;
        if (count === 0) {
             summaryText = 'Select';
        } else if (count === total) {
             summaryText = 'All'; // Show 'All' if everything is selected
        } else {
             summaryText = `${count} selected`;
        }

        if (group.summary) {
            group.summary.textContent = summaryText;
        }

        // Add 'active' class to header if a filter is applied
        const header = group.container ? group.container.querySelector('.dropdown-header') : null;
        if (header) {
            header.classList.toggle('active', count > 0 && count !== total);
        }
    }
}


function applyFilters(event) {
    const newCurrentFilter = { core: [], stage: [], tag: [] };
    const rawUrlParams = new URLSearchParams();

    for (const key in filterGroups) {
        const group = filterGroups[key];
        const selectedCleanedValues = [];

        if (group.inputList) {
             group.inputList.querySelectorAll(`input[type="checkbox"]:checked`).forEach(checkbox => {
                // We use the 'value' attribute here, which is the internal, cleaned filter name
                selectedCleanedValues.push(checkbox.value);
            });
        }

        newCurrentFilter[key] = selectedCleanedValues;

        if (selectedCleanedValues.length > 0) {
            rawUrlParams.set(key, selectedCleanedValues.join(',')); 
        }
    }

    currentFilter = newCurrentFilter;
    updateFilterSummaries();

    if (currentUserName) { rawUrlParams.set('name', currentUserName); }
    const newUrl = `${location.pathname}?${rawUrlParams.toString()}`;
    window.history.replaceState(null, '', newUrl);

    debouncedRenderTasks(currentUserName);
}


function renderTasks(name, tasksToRender = TASKS) {
  const key = NAME_KEY_PREFIX + name;
  const done = safeGet(key, {});
  if (tasksEl) tasksEl.innerHTML = '';

  if (tasksToRender.length === 0) {
      if (tasksEl) {
        tasksEl.innerHTML = '<div style="padding: 20px; text-align: center; color: var(--muted); font-weight: 600;">No tasks match these filters. Try clearing filters.</div>';
      }
      updateProgress(done); 
      return;
  }
    
  tasksToRender.forEach(t => {
    const row = document.createElement('div');
    row.className = 'task'; 
    row.setAttribute('role', 'listitem');

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !!done[t.id];
    cb.setAttribute('aria-label', `Mark ${t.text} as done`);

    const content = document.createElement('div');
    
    const title = document.createElement('div');
    title.className = 'taskTitle';
    title.textContent = t.text;
    
    // --- META LINE 1: PILLS ---
    const meta = document.createElement('div');
    meta.className = 'meta';

    // 1. Points Reward
    const stageMult = STAGE_MULTIPLIER[t.stage] || 1; 
    const engagementMult = ENGAGEMENT_MULTIPLIER[t.engagement_level] || 1; 
    const points = stageMult * engagementMult;

    const pointsPill = document.createElement('span');
    pointsPill.className = 'pill points-pill'; 
    pointsPill.textContent = `+${points}`;
    meta.appendChild(pointsPill);

    // 2. Core Theme Pill (uses raw display name)
    if (t.primary_core_display) {
      const corePill = document.createElement('span');
      corePill.className = 'pill core-pill'; 
      corePill.textContent = t.primary_core_display;
      meta.appendChild(corePill);
    }

    // 3. Stage Pill (uses raw display name)
    if (t.stage_display) {
      const stagePill = document.createElement('span');
      stagePill.className = 'pill stage-pill'; 
      stagePill.textContent = t.stage_display; 
      meta.appendChild(stagePill);
    }
    
    // 4. Audience/Context Pill
    if (t.audience_display) {
        const audiencePill = document.createElement('span');
        audiencePill.className = 'pill audience-pill'; 
        audiencePill.textContent = t.audience_display; 
        meta.appendChild(audiencePill);
    }
    
    // 5. Subcategory Tags Pills
    if (t.tags_display && t.tags_display.length > 0) {
        t.tags_display.forEach(tag => {
            const tagPill = document.createElement('span');
            tagPill.className = 'pill tag-pill'; 
            tagPill.textContent = tag;
            meta.appendChild(tagPill);
        });
    }
    
  // --- META LINE 2: IMPACT/SOURCE/CONFIDENCE (The requested line) ---
    const impactLine = document.createElement('div');
    impactLine.className = 'meta impact-line';
    
    // Ensure all fields are available before trying to display them
    const impactValue = t.impactValue || 'N/A';
    const source = t.source || 'N/A';
    const confidence = t.confidence || 'N/A';

    const impactTextHTML = `<b>Impact</b>: ${impactValue}, ${source}.<br><b>Confidence</b>: ${confidence}.`;
    
    // Use innerHTML to render the HTML tags (<b> and <br>).
    impactLine.innerHTML = impactTextHTML; 

    content.appendChild(title);
    content.appendChild(meta);
    content.appendChild(impactLine);

    const actions = document.createElement('div');
    actions.className = 'votes';
    
    const likeBtn = document.createElement('button');
    likeBtn.className = 'btn ghost like'; 
    likeBtn.type = 'button';
    likeBtn.setAttribute('aria-label', 'like task');
    likeBtn.textContent = '👍 Like';
    const dislikeBtn = document.createElement('button');
    dislikeBtn.className = 'btn ghost dislike'; 
    dislikeBtn.type = 'button';
    dislikeBtn.setAttribute('aria-label', 'dislike task');
    dislikeBtn.textContent = '👎 Dislike';
    const stat = document.createElement('div');
    stat.className = 'stat';
    stat.setAttribute('data-stat', '');

    actions.appendChild(likeBtn);
    actions.appendChild(dislikeBtn);
    actions.appendChild(stat);

    row.appendChild(cb);
    row.appendChild(content);
    row.appendChild(actions);
    if (tasksEl) tasksEl.appendChild(row);

    // handlers
    cb.addEventListener('change', () => {
      const map = safeGet(key, {});
      map[t.id] = cb.checked;
      safeSet(key, map);
      
      queueEvent({ name, action: cb.checked ? 'done' : 'undone', task_id: t.id, 
            tags: t.tags_display || [], primary_core: t.primary_core_display || '', 
            stage: t.stage_display || '', score: points 
      });
      tick();
      updateScoreDisplay(name); 
      updateProgress(map); 
    });

    const vkey = VOTES_KEY_PREFIX + name;
    
    function refreshVotes(currentVotes) {
      const v = currentVotes[t.id] || 0;
      likeBtn.classList.toggle('active', v === 1);
      dislikeBtn.classList.toggle('active', v === -1);
      stat.textContent = v === 1 ? 'You liked this' : v === -1 ? 'You disliked this' : '';
    }
    
    likeBtn.addEventListener('click', () => {
      const currentVotes = safeGet(vkey, {});
      const newVote = currentVotes[t.id] === 1 ? 0 : 1;
      currentVotes[t.id] = newVote;
      safeSet(vkey, currentVotes);
      refreshVotes(currentVotes);
      queueEvent({ name, action: newVote === 1 ? 'like' : 'clear_vote', task_id: t.id, vote_value: newVote });
      tick();
    });
    
    dislikeBtn.addEventListener('click', () => {
      const currentVotes = safeGet(vkey, {});
      const newVote = currentVotes[t.id] === -1 ? 0 : -1;
      currentVotes[t.id] = newVote;
      safeSet(vkey, currentVotes);
      refreshVotes(currentVotes);
      queueEvent({ name, action: newVote === -1 ? 'dislike' : 'clear_vote', task_id: t.id, vote_value: newVote });
      tick();
    });
    
    refreshVotes(safeGet(vkey, {}));
  });

  updateProgress(safeGet(NAME_KEY_PREFIX + name, {})); 
}

// FIX: Update updateProgress to use the currently filtered list
function updateProgress(doneMap) {
    const filteredTasks = filterTasks(TASKS);
    const total = filteredTasks.length;
    
    if (total === 0) {
        if (progressBar) progressBar.value = 0;
        if (progressPct) progressPct.textContent = '0%';
        return;
    }
    
    // Count how many of the currently filtered tasks are marked as done
    const completed = filteredTasks.filter(t => doneMap[t.id]).length;
    
    const pct = Math.round((completed / total) * 100);
    if (progressBar) progressBar.value = pct;
    if (progressPct) progressPct.textContent = pct + '%';
}


function tick() {
  if (saveMsg) saveMsg.textContent = 'Saved locally ✓';
  clearTimeout(tick._t);
  tick._t = setTimeout(() => (saveMsg.textContent = ''), 1200);
}

// QR code generation
async function updateQR(name) {
  try {
    if (qrBox) qrBox.innerHTML = '';
    const baseUrl = window.location.origin + window.location.pathname;
    // Note: This URL does not include filters, only the user's name
    const shareUrl = `${baseUrl}?name=${encodeURIComponent(name)}`; 

    const ok = await ensureQRLib(4000);
    if (ok && window.QRCode) {
      try {
        if (qrBox) new QRCode(qrBox, { text: shareUrl, width: 128, height: 128 });
        if (qrHint) qrHint.textContent = 'Scan to open this exact page and your name.';
      } catch (err) {
        console.warn('qrcode draw failed', err);
        if (qrHint) qrHint.textContent = 'QR generation failed — check console.';
      }
    } else {
      if (qrHint) qrHint.textContent = 'QR not available (offline or blocked).';
    }
  } catch (err) {
    console.error('updateQR', err);
  }
}

// Fallback for qrcode.js dependency check
function ensureQRLib(timeout = 4000) {
  if (window.QRCode) return Promise.resolve(true);
  return new Promise((resolve) => {
    // simplified script injection/check logic 
    const check = () => {
      if (window.QRCode) return resolve(true);
      if (Date.now() - start > timeout) return resolve(false);
      setTimeout(check, 120);
    };
    const start = Date.now();
    setTimeout(check, 120);
  });
}

/* ---------------- Event listener for the feedback button (FIXED) ---------------- */
feedbackBtn.addEventListener('click', async () => {
  // 1. Show the confirmation modal with the new custom text
  const confirmed = await showConfirm('You are being redirected to a **trail Form** to submit feedback.');
  
  if (confirmed) {
    // 2. Perform the redirection after confirmation
    window.open(FEEDBACK_FORM_URL, '_blank');
    // 3. Use the toast only as a secondary notification
    toast('Opening trail Form...', { type: 'success' });
  }
});


/* ---------------- auto start ---------------- */
const params = new URLSearchParams(location.search);
const initialName = params.get('name') || '';
const storedName = safeGet('poc:name', '') || '';
const nameToStart = initialName || storedName; 

// Auto start is now async to wait for tasks to load
if (nameToStart) setTimeout(() => start(nameToStart), 180);
window.addEventListener('load', () => {
    // Force a check on refresh to make sure the card isn't wider than the window
    const card = document.querySelector('.card');
    if (card && card.offsetWidth > window.innerWidth) {
        card.style.maxWidth = (window.innerWidth - 20) + 'px';
        card.style.overflowX = 'hidden';
    }
});