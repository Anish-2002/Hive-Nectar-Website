#!/usr/bin/env node
/* Re-runnable proof. Needs the dev-only jsdom dep:
     cd "<repo>" && npm i -D jsdom        (once)
     node verification/verify_mobile_sheet_stack.cjs
*/
/* Runtime proof of the nested bottom-sheet stack (the mobile task-reflection /
   completed-task eye fix).

   The EVALUATED CODE IS NOT A REWRITE: sheet-block-plain.js is sliced byte-for-byte
   out of the shipped public/js/profile.js (section "BOTTOM SHEET"), and the two CSS
   rules are sliced out of the shipped public/style.css. jsdom gives the real DOM so
   the real close handlers, the real Escape handler and the real classes are exercised.
*/
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

/* optional argv[2] = another tree to run the same assertions against */
const REACT = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve(__dirname, '..');
console.log('tree under test: ' + REACT);
/* the React tree serves the legacy pages from public/, a plain static tree keeps
   the same files at the root - accept both layouts */
const pick = (a, b) => { if (fs.existsSync(a)) return a; if (fs.existsSync(b)) return b; throw new Error('not found: ' + a); };
const profilePath = pick(path.join(REACT, 'public/js/profile.js'), path.join(REACT, 'js/profile.js'));
const stylePath = pick(path.join(REACT, 'public/style.css'), path.join(REACT, 'style.css'));
console.log('profile: ' + profilePath);
const profileSrc = fs.readFileSync(profilePath, 'utf8');
const styleSrc = fs.readFileSync(stylePath, 'utf8');

function slice(src, fromMarker, toMarker, label) {
  const lines = src.split('\n');
  let start = -1, end = -1;
  lines.forEach((l, i) => {
    if (start === -1 && l.startsWith(fromMarker)) start = i;
    else if (start !== -1 && end === -1 && l.startsWith(toMarker)) end = i;
  });
  if (start === -1 || end === -1) throw new Error('slice failed: ' + label);
  return lines.slice(start, end).join('\n');
}

const sheetBlock = slice(profileSrc, '// ======================== BOTTOM SHEET', '// ======================== TASK HELPER', 'BOTTOM SHEET');
const cssBlock = slice(styleSrc, '/* --- BOTTOM SHEET', '/* --- PENDING SIGMA BADGE', 'BOTTOM SHEET css');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra !== undefined ? '  -> ' + JSON.stringify(extra) : '')); }
};

function boot() {
  const dom = new JSDOM(
    `<!doctype html><html><head><style>${cssBlock}</style></head><body>
     <div class="bottom-sheet-overlay" id="editProfileSheet" data-static="true">
       <div class="bottom-sheet"><div class="bottom-sheet-header"><h3>Edit Profile</h3>
       <button class="bottom-sheet-close">&times;</button></div>
       <div class="bottom-sheet-content"></div></div>
     </div></body></html>`,
    { runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://127.0.0.1:5210/profile.html' }
  );
  const w = dom.window, d = w.document;
  const api = new Function('document', 'window', 'setTimeout', 'clearTimeout', 'console',
    sheetBlock + '\nreturn { showBottomSheet, closeAllBottomSheets, topBottomSheet, closeBottomSheet, bottomSheetStack };'
  )(d, w, w.setTimeout.bind(w), w.clearTimeout.bind(w), console);
  return { w, d, api };
}

const dyn = d => Array.from(d.querySelectorAll('.bottom-sheet-overlay:not([data-static])'));
const titleOf = o => (o.querySelector('.bottom-sheet-header h3') || {}).textContent;
const wait = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  console.log('--- shipped source boundaries ---');
  console.log('  sheet block bytes:', sheetBlock.length, '| css block bytes:', cssBlock.length);
  ok('sliced block contains the stack primitives',
    /const bottomSheetStack = \[\]/.test(sheetBlock) && /function topBottomSheet/.test(sheetBlock)
    && /function closeBottomSheet/.test(sheetBlock) && /function syncBottomSheetStack/.test(sheetBlock));
  ok('showBottomSheet no longer deletes the open sheet',
    !/existing\.remove\(\)/.test(sheetBlock) && /bottomSheetStack\.push\(overlay\)/.test(sheetBlock));
  ok('css has the inert-parent rule', /\.bottom-sheet-overlay\.sheet-behind \{ pointer-events:none; \}/.test(cssBlock));

  /* ---------- 1. parent: "Tasks Reflection" ---------- */
  console.log('\n--- T1: parent sheet opens ---');
  let { w, d, api } = boot();
  const parent = api.showBottomSheet('Tasks Reflection', '<button class="eye-btn" data-refl-view="log-1">eye</button>');
  ok('one dynamic sheet in the DOM', dyn(d).length === 1, dyn(d).length);
  ok('parent is the top sheet', parent.classList.contains('sheet-top') && !parent.classList.contains('sheet-behind'));
  ok('body scroll locked', d.body.style.overflow === 'hidden', d.body.style.overflow);
  ok('static Edit Profile sheet untouched', !!d.getElementById('editProfileSheet') &&
    !d.getElementById('editProfileSheet').classList.contains('sheet-behind'));
  ok('parent clickable', w.getComputedStyle(parent).pointerEvents !== 'none');

  /* ---------- 2. the eye: child sheet on top of the parent ---------- */
  console.log('\n--- T2: eye opens the history on top (was: overlaps + killed the parent) ---');
  const child = api.showBottomSheet('Your Reflection', '<p>reflection history</p>');
  ok('parent SURVIVES the child opening (old bug: removed)', d.contains(parent));
  ok('two dynamic sheets are stacked', dyn(d).length === 2, dyn(d).map(titleOf));
  ok('child has the higher z-index', Number(child.style.zIndex) > Number(parent.style.zIndex),
    { child: child.style.zIndex, parent: parent.style.zIndex });
  ok('parent is recessed/inert (.sheet-behind)', parent.classList.contains('sheet-behind'));
  ok('parent takes no pointer events (no button-sheet overlap)',
    w.getComputedStyle(parent).pointerEvents === 'none', w.getComputedStyle(parent).pointerEvents);
  ok('child is the live sheet', child.classList.contains('sheet-top') && !child.classList.contains('sheet-behind'));
  ok('child clickable', w.getComputedStyle(child).pointerEvents !== 'none');

  /* ---------- 3. closing the child returns to the parent, in order ---------- */
  console.log('\n--- T3: closing the detail unwinds ONE level ---');
  child.querySelector('.bottom-sheet-close').click();
  ok('child is gone from the stack immediately', api.bottomSheetStack.indexOf(child) === -1);
  ok('parent is the live sheet again', parent.classList.contains('sheet-top') && !parent.classList.contains('sheet-behind'));
  ok('parent clickable again', w.getComputedStyle(parent).pointerEvents !== 'none');
  ok('body stays locked (parent still open)', d.body.style.overflow === 'hidden', d.body.style.overflow);
  await wait(400);
  ok('child removed from the DOM', !d.contains(child) && dyn(d).length === 1, dyn(d).length);
  ok('parent still in the DOM', d.contains(parent));

  /* ---------- 4. closing the parent ends it ---------- */
  console.log('\n--- T4: closing the parent ends the sequence ---');
  parent.querySelector('.bottom-sheet-close').click();
  await wait(400);
  ok('no dynamic sheets left', dyn(d).length === 0, dyn(d).length);
  ok('body scroll released', d.body.style.overflow === '', d.body.style.overflow);

  /* ---------- 5. Escape pops only the top sheet ---------- */
  console.log('\n--- T5: Escape pops one level, never the main sheet ---');
  ({ w, d, api } = boot());
  const p2 = api.showBottomSheet('Tasks Reflection', 'x');
  const c2 = api.showBottomSheet('Your Reflection', 'y');
  d.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await wait(20);
  ok('Escape closed the child only', api.bottomSheetStack.indexOf(c2) === -1 && d.contains(p2));
  ok('parent is live again after Escape', p2.classList.contains('sheet-top'));

  /* ---------- 6. backdrop click + nested deep stack ---------- */
  console.log('\n--- T6: backdrop click + three-level stack ---');
  api.closeAllBottomSheets();
  await wait(400);
  ok('T6 starts from a clean page', dyn(d).length === 0, dyn(d).length);
  const t1 = api.showBottomSheet('Level 1', 'a');
  const t2 = api.showBottomSheet('Level 2', 'b');
  const t3 = api.showBottomSheet('Level 3', 'c');
  ok('three sheets stacked', dyn(d).length === 3, dyn(d).map(titleOf));
  ok('z-index ascends with depth',
    Number(t1.style.zIndex) < Number(t2.style.zIndex) && Number(t2.style.zIndex) < Number(t3.style.zIndex),
    [t1.style.zIndex, t2.style.zIndex, t3.style.zIndex]);
  ok('only the top is live',
    w.getComputedStyle(t1).pointerEvents === 'none' && w.getComputedStyle(t2).pointerEvents === 'none' &&
    w.getComputedStyle(t3).pointerEvents !== 'none');
  t3.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await wait(400);
  ok('backdrop click closes only the top sheet', dyn(d).length === 2 && d.contains(t2) && d.contains(t1));
  ok('sheet below is promoted to live', t2.classList.contains('sheet-top') && !t2.classList.contains('sheet-behind'));

  /* ---------- 7. closeAllBottomSheets keeps static sheets ---------- */
  console.log('\n--- T7: closeAllBottomSheets (blocked-task jump) ---');
  api.closeAllBottomSheets();
  ok('dynamic sheets all gone', dyn(d).length === 0, dyn(d).length);
  ok('static sheet hidden, not removed', !!d.getElementById('editProfileSheet') &&
    d.getElementById('editProfileSheet').style.visibility === 'hidden');
  ok('scroll released', d.body.style.overflow === '', d.body.style.overflow);
  ok('stack emptied', api.bottomSheetStack.length === 0, api.bottomSheetStack.length);

  /* ---------- 8. a sheet built by another module is still found ---------- */
  console.log('\n--- T8: topBottomSheet() fallback for foreign sheets (trial.js) ---');
  ({ w, d, api } = boot());
  const foreign = d.createElement('div');
  foreign.className = 'bottom-sheet-overlay active';
  foreign.innerHTML = '<div class="bottom-sheet"><div class="bottom-sheet-header"><h3>Contact</h3>' +
    '<button class="bottom-sheet-close">&times;</button></div><div class="bottom-sheet-content"></div></div>';
  d.body.appendChild(foreign);
  ok('stack is empty yet the foreign sheet is found', api.bottomSheetStack.length === 0 && api.topBottomSheet() === foreign);
  const over = api.showBottomSheet('Tasks Reflection', 'x');
  ok('a profile sheet opens above the foreign sheet', over.style.zIndex === '10010' && dyn(d).length === 2, over.style.zIndex);

  /* ---------- 9. mobile entry points ---------- */
  console.log('\n--- T9: mobile tiles open the sheet they are labelled with ---');
  const htmlPath = pick(path.join(REACT, 'src/legacy/profile.html'), path.join(REACT, 'profile.html'));
  const html = fs.readFileSync(htmlPath, 'utf8');
  console.log('  profile.html: ' + htmlPath);
  ok('the "Tasks Reflection" tile is bound to the reflection list',
    profileSrc.includes('mobileMissions.onclick = () => openPendingSigmaModal();'));
  ok('the old misbinding (reflection tile -> Daily Tasks) is gone',
    !profileSrc.includes('mobileMissions.onclick = () => openMissionsModal();'));
  ok('the reflection tile keeps the pending-reflection badge',
    /id="mobileMissionsBtn"[\s\S]{0,220}?id="mobilePendingSigmaBadge"/.test(html));
  ok('the tile labelled "Tasks Reflection" still exists',
    /id="mobileMissionsBtn"[\s\S]{0,220}?Tasks Reflection/.test(html));
  ok('the completed-tasks tile still opens the completed list',
    profileSrc.includes("mobileCompleted.onclick = () => openCompletedModal();"));
  ok('Missions keeps a mobile route (sidebar entry is wired)',
    profileSrc.includes("getElementById('pendingSigmaSection')") &&
    profileSrc.includes("addEventListener('click', () => openMissionsModal())"));

  console.log('\nRESULT  ' + pass + ' PASS / ' + fail + ' FAIL');
  process.exit(fail === 0 ? 0 : 1);
})();
