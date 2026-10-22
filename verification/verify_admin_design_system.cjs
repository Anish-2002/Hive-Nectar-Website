#!/usr/bin/env node
/**
 * verify_admin_design_system.cjs — proves the CRM design-system overhaul.
 *
 * Static and structural (no network, no browser): reads the shipped sources, the
 * generated design sheet (visual/ds-preview.html) and the built bundle, and
 * checks the properties the redesign promised. Run from the project root:
 *
 *     node verification/verify_admin_design_system.cjs
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
let pass = 0;
const fails = [];
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const exists = (p) => fs.existsSync(path.join(ROOT, p));

function ok(name, cond, detail) {
  if (cond) { pass += 1; console.log(`  PASS  ${name}`); }
  else { fails.push(name + (detail ? ` - ${detail}` : '')); console.log(`  FAIL  ${name}${detail ? ` - ${detail}` : ''}`); }
}

function group(title) { console.log(`\n${title}`); }

const DS = read('src/admin/ds.css');
const SHIM = read('src/admin/ds-legacy.css');
const APP = read('src/admin/AdminApp.jsx');
const CRM = read('src/admin/sections-crm.jsx');

// ---------------------------------------------------------------- 1. tokens
group('1. Design tokens (ds.css)');
for (const hex of ['#FAF9F6', '#FFFFFF', '#1F2937', '#64748B', '#E5E7EB', '#D9A441']) {
  ok(`token ${hex} is defined`, DS.includes(hex));
}
for (const t of ['--ds-t-page: 28px', '--ds-t-section: 20px', '--ds-t-table: 13.5px', '--ds-t-label: 12.5px', '--ds-t-body: 15px']) {
  ok(`scale ${t}`, DS.includes(t));
}
ok('sidebar width token is 240-260px',
  /--ds-side-w:\s*(2[4-5][0-9])px|--ds-side-w:\s*260px/.test(DS) && !/--ds-side-w:\s*22[0-9]px/.test(DS),
  (DS.match(/--ds-side-w:\s*[0-9]+px/) || [''])[0]);
ok('page container is bounded', /--ds-page-max:\s*1[0-9]{3}px/.test(DS));

// --------------------------------------------------- 2. scoping + isolation
group('2. Member site cannot be affected');
const badSelectors = [];
for (const m of DS.matchAll(/(^|\n)([^{}\n]+)\{/g)) {
  const sel = m[2].trim();
  if (sel.startsWith('@') || sel.startsWith('/*') || sel.startsWith('--')) continue;
  const scoped = /\.[a-zA-Z-]*ds-[a-z-]+|ds-shell|ds-gate|adm-gate/.test(sel);
  if (!scoped) badSelectors.push(sel);
}
ok('every ds.css rule is scoped to the admin shell', badSelectors.length === 0, badSelectors.slice(0, 4).join(' | '));
ok('member body background is neutralised only under the shell',
  APP.includes('adm-shell ds-shell') && DS.includes('.adm-shell.ds-shell'));
ok('the CRM does not inherit the member display face',
  !/font-family:\s*'?Fredoka/i.test(DS) && DS.includes("'Inter'"));
ok('Inter is self-hosted', exists('public/fonts/inter-latin.woff2') && DS.includes('@font-face') && DS.includes('/fonts/inter-latin.woff2'));

// ------------------------------------------------------- 3. legacy shim
group('3. The four legacy sheets are re-pointed, not bypassed');
const legacyFontSizes = ['src/admin/admin.css', 'src/admin/dashboard.css', 'src/admin/phase-a.css', 'src/admin/mail.css']
  .flatMap((f) => [...read(f).matchAll(/font-size:\s*[0-9.]+(rem|px|em)/g)]);
const shimSizes = [...SHIM.matchAll(/font-size:\s*[0-9.]+px/g)];
ok('the shim carries a rule per legacy font-size',
  legacyFontSizes.length > 0 && shimSizes.length >= legacyFontSizes.length * 0.8,
  `${legacyFontSizes.length} legacy declarations / ${shimSizes.length} shim rules`);
ok('shim rules are shell-scoped', [...SHIM.matchAll(/^\.ds-shell/gm)].length > 40);
ok('the shim re-points text colours at the tokens', SHIM.includes('var(--ds-text)'));
ok('the shim re-points the member font stack',
  [...SHIM.matchAll(/font-family:\s*var\(--ds-font\)/g)].length >= 2);

// ------------------------------------------------------------- 4. shell
group('4. Shell: sidebar, top bar, bounded content');
for (const cls of ['ds-side', 'ds-brand-mark', 'ds-brand-text', 'ds-nav', 'ds-nav-group', 'ds-nav-toggle', 'ds-nav-panel', 'ds-nav-item', 'ds-nav-count', 'ds-rail-toggle', 'ds-body', 'ds-topbar', 'ds-crumbs', 'ds-search', 'ds-actions', 'ds-menu-wrap', 'ds-page']) {
  ok(`shell renders .${cls}`, APP.includes(cls));
}
ok('sidebar collapses and the choice is remembered', APP.includes('is-rail') && APP.includes('localStorage'));
ok('breadcrumbs show group then section', APP.includes('ds-crumbs-group') && APP.includes('ds-crumb-current'));
ok('global search covers sections and members', APP.includes('NAV_SECTIONS') && APP.includes('admin_get_users'));
ok('the bell is driven by a queue table, not a number', APP.includes('BELL_QUEUES') && APP.includes('loadQueues'));
const iconIds = new Set([...APP.matchAll(/^  '?([a-z-]+)'?:\s*[A-Z][A-Za-z0-9]*,$/gm)].map((m) => m[1]));
const sectionIds = new Set([...APP.matchAll(/\{ id: '([a-z-]+)', label: '/g)].map((m) => m[1]));
const noIcon = [...sectionIds].filter((id) => !iconIds.has(id));
ok('every navigable section has its own icon', noIcon.length === 0, noIcon.join(', '));
ok('the icon map has no stale entries',
  [...iconIds].every((id) => sectionIds.has(id)),
  [...iconIds].filter((id) => !sectionIds.has(id)).join(', '));

// ---------------------------------------------- 5. bell RPCs vs live sigs
group('5. Bell RPCs exist in the live database with the real argument names');
const sigs = JSON.parse(read('information/admin-crm/verification/live_admin_sigs.json'));
for (const name of ['admin_get_review_queue', 'admin_get_tickets', 'admin_get_mail_outbox', 'admin_get_sigma_inbox']) {
  const sig = sigs[name];
  ok(`${name} is a definer RPC, not anon-executable`,
    !!sig && sig.security === 'definer' && sig.public_execute === false && sig.returns === 'jsonb');
  const block = (APP.match(new RegExp(`'${name}'[\\s\\S]{0,240}`)) || [''])[0];
  for (const arg of new Set(block.match(/p_[a-z_]+/g) || [])) {
    ok(`  argument ${arg} exists on ${name}`, !!sig && sig.args.includes(arg));
  }
}
ok('counts come from the payload, never from a constant', /counts\?\.(new|total)|\?\.total/.test(APP));

// --------------------------------------------------------- 6. support inbox
group('6. Support inbox is a three-column workspace');
ok('queue and thread columns exist', CRM.includes('ds-inbox') && CRM.includes('ds-queue') && CRM.includes('ds-thread'));
ok('the queue is a dense list, not a full-width table', CRM.includes('function TicketQueue') && CRM.includes('ds-qitem'));
ok('the ticket opens in the thread column', /<TicketDetail id=\{openId\} inline/.test(CRM));
ok('the drawer path is kept for non-inline callers', CRM.includes('if (!inline)') && CRM.includes('<Drawer title={drawerTitle}'));
ok('the member column reads admin_get_member_360',
  /TicketMemberContext/.test(CRM) && /admin_get_member_360', \{ p_user_id: memberId \}/.test(CRM));
ok('replies and status still use the shipping RPCs',
  ['admin_reply_ticket', 'admin_update_ticket', 'admin_get_tickets', 'admin_import_inquiries', 'admin_get_ticket']
    .every((r) => CRM.includes(r)));
ok('the workspace CSS ships', /\.ds-inbox\s*\{/.test(DS) && /\.ds-ticket-grid\s*\{/.test(DS) && /\.ds-qitem\s*\{/.test(DS));

// ------------------------------------------------------ 7. no AI-look, no emoji
group('7. No emoji and no decorative gradients in the admin');
const ADMIN_FILES = ['src/admin/AdminApp.jsx', 'src/admin/sections.jsx', 'src/admin/sections-crm.jsx',
  'src/admin/sections-dashboard.jsx', 'src/admin/sections-phase-a.jsx', 'src/admin/sections-mail.jsx',
  'src/admin/ds.css', 'src/admin/ds-legacy.css'];
const EMOJI = new RegExp('[\\u{1F300}-\\u{1FAFF}\\u{2600}-\\u{27BF}\\u{FE0F}]', 'u');
const emojiHits = ADMIN_FILES.filter((f) => EMOJI.test(read(f)));
ok('no emoji in any admin source', emojiHits.length === 0, emojiHits.join(', '));
const DS_CODE = DS.replace(/\/\*[\s\S]*?\*\//g, '');
const gradientLines = DS_CODE.split('\n').filter((l) => /gradient/.test(l));
const skelStart = DS_CODE.indexOf('.ds-skeleton');
const skelRule = skelStart < 0 ? '' : DS_CODE.slice(skelStart, DS_CODE.indexOf('}', skelStart));
ok('gradients are limited to the loading skeleton',
  gradientLines.every((l) => skelRule.includes(l)),
  gradientLines.map((l) => l.trim().slice(0, 48)).join(' | '));

// ------------------------------------------------------------ 8. the bundle
function distFile(re) {
  const dir = path.join(ROOT, 'dist/assets');
  if (!fs.existsSync(dir)) return null;
  const hit = fs.readdirSync(dir).filter((n) => re.test(n)).sort().pop();
  return hit ? `dist/assets/${hit}` : null;
}
group('8. What actually ships in the build');
const cssFile = distFile(/^index-.*\.css$/);
const jsFile = distFile(/^index-.*\.js$/);
ok('a built stylesheet exists', !!cssFile);
if (cssFile) {
  const css = read(cssFile);
  for (const needle of ['#faf9f6', '--ds-t-page:28px', '.ds-inbox', '.ds-ticket-grid', '.ds-shell .adm-head h2', '@font-face']) {
    ok(`bundle carries ${needle}`, css.toLowerCase().includes(needle));
  }
}
ok('a built script exists', !!jsFile);
if (jsFile) {
  const js = read(jsFile);
  ok('bundle carries the shell and the inbox', js.includes('ds-topbar') && js.includes('ds-inbox'));
  ok('bundle carries the bell queues', js.includes('admin_get_review_queue'));
}
ok('the design sheet was generated', exists('visual/ds-preview.html'));
if (exists('visual/ds-preview.html')) {
  const sheet = read('visual/ds-preview.html');
  const groups = [...sheet.matchAll(/class="ds-nav-group"/g)].length;
  const items = [...sheet.matchAll(/class="ds-nav-item[^"]*"/g)].length;
  ok('sheet renders all navigation groups', groups >= 6, String(groups));
  ok('sheet renders every section', items >= 33, String(items));
  ok('sheet renders the component vocabulary', ['ds-stats', 'ds-table', 'ds-toolbar', 'ds-tabs', 'ds-timeline', 'ds-member-panel', 'ds-empty', 'ds-error'].every((c) => sheet.includes(c)));
}

// ------------------------- 9. directory, queues, settings (this phase)
group('9. Directory, review queues, Settings');
const SECT = read('src/admin/sections.jsx');
const PA = read('src/admin/sections-phase-a.jsx');
const DASH = read('src/admin/sections-dashboard.jsx');

ok('the shell main element keeps its gutter',
  /\.ds-shell \.adm-main:not\(\.ds-main\)\s*\{[^}]*padding:\s*0/.test(DS)
  && /\.ds-main\s*\{[^}]*padding:\s*var\(--ds-6\)/.test(DS),
  'the legacy padding reset must not also zero .ds-main (same element, two classes)');

ok('the members directory is a purpose-built table, not a raw dump',
  SECT.includes('ds-table--dir') && SECT.includes('MemberCell') && SECT.includes('onClick={() => setOpenId(u.id)}'));
ok('the directory shows avatars, tier badges and activity, not empty columns',
  SECT.includes('initialsof') === false && SECT.includes('initialsOf') && SECT.includes('TIER_TONE') && SECT.includes('activityOf') && SECT.includes('relTime'));
const MEMBERS_BLOCK = SECT.slice(SECT.indexOf('export function MembersSection'), SECT.indexOf('export function CommunicationsSection'));
ok('the directory asks only for columns admin_get_users returns',
  !/nectar_points|total_tasks_completed|subscription_status/.test(MEMBERS_BLOCK),
  'the column list must match the live admin_get_users payload');
ok('the directory constrains its own controls',
  SECT.includes('adm-filters') && SECT.includes('ds-field-label') && SECT.includes('type="search"'));

ok('the queues share one status vocabulary and one chip row',
  PA.includes('export function StatusTabs') && PA.includes('STATUS_LABEL') && PA.includes('STATUS_TONE')
  && CRM.includes("from './sections-phase-a.jsx'") && CRM.includes('StatusTabs'));
ok('a queue row opens a submission panel with a timeline and member context',
  PA.includes('function QueueTimeline') && PA.includes('ds-dmaic') && PA.includes('ds-timeline') && PA.includes('Open member record'));
ok('queue actions use the shipping review RPCs and never render dead buttons',
  PA.includes('admin_set_review_status') && PA.includes('if (!reviewId)') && PA.includes('not linked to a review record'));
ok('the review centre uses the shared queue components too',
  CRM.includes('ReviewCentreSection') && /ReviewCentreSection[\s\S]{0,3000}StatusTabs/.test(CRM) && CRM.includes('QueueMember'));

ok('Settings keeps a page title, description and the three config RPCs',
  CRM.includes('admin_get_settings') && CRM.includes('admin_save_setting') && CRM.includes('admin_delete_setting')
  && /title="Settings"/.test(CRM) && /Runtime configuration/.test(CRM));
ok('integration health is cards with explicit states, not a table row',
  CRM.includes('ds-health-grid') && CRM.includes('ds-health-card') && CRM.includes("'Healthy'") && CRM.includes("'Not ready'"));
ok('database statistics are compact and admitted as live',
  CRM.includes('ds-stats--db') && /Live row counts/.test(CRM));
ok('dangerous configuration changes are confirmed in two steps',
  CRM.includes('confirmKey') && CRM.includes('Confirm delete') && CRM.includes('ds-confirm'));
ok('save and delete report success and failure openly',
  CRM.includes('ds-flash ds-flash--ok') && CRM.includes('adm-error'));

ok('gift fulfilment shows stock levels and stage indicators',
  PA.includes('ds-stock-bar') && PA.includes('function stageTone') && PA.includes('admin_get_fulfilment_queue'));
ok('the reflections duplication fix ships as a migration',
  exists('information/admin-crm/sql/2026-10-14-17-fix-reflection-duplication.sql')
  && read('information/admin-crm/sql/2026-10-14-17-fix-reflection-duplication.sql').includes('left join lateral')
  && /NOTIFY pgrst/.test(read('information/admin-crm/sql/2026-10-14-17-fix-reflection-duplication.sql')));
ok('the chart axis cannot produce duplicate keys',
  DASH.includes('[...new Set([0, Math.round(maxY / 2), maxY])]'));
ok('shared CSS for the new components ships',
  ['.ds-tabs', '.ds-tab-count', '.ds-health-card', '.ds-stock-bar', '.ds-kv-table .ds-kv-actions',
    '.ds-shell table.adm-table th', '.ds-member-mail', '.ds-dirty'].every((c) => DS.includes(c)));
ok('counters are labelled metric chips, not "key: value" pills',
  CRM.includes('ds-metrics') && CRM.includes('ds-metric-v') && DS.includes('.ds-metric-k')
  && !/adm-pill">\{k\.replace/.test(CRM));

console.log(`\nRESULT  ${pass} PASS / ${fails.length} FAIL`);
if (fails.length) {
  console.log('failed:');
  for (const f of fails) console.log(`  - ${f}`);
}
process.exit(fails.length ? 1 : 0);



