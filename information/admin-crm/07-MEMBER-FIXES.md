# 07 — MEMBER-FACING FIXES AND ADMIN ADDENDA

Owner requests of 2026-10-13, appended to the CRM brief. Companion to
`06-CRM-AUDIT-AND-GAP-ANALYSIS.md`. All changes are local-only and unpushed.

## A4 — Profile reflections: Pending and Submitted (DONE)

**Asked:** the profile reflection area should have *Pending* (reflections not yet
submitted — what the notification count shows) and *Submitted* (everything
submitted), with an eye icon to view a submitted reflection and edit it.

**Before:** `generatePendingSigmaHtml()` (profile.js) listed only tasks completed
with no `task_sigma_logs` row. Submitted reflections were invisible in the UI and
there was **no edit path anywhere** — a submitted reflection was immutable.

**After, in `public/js/profile.js`:**

- `generatePendingSigmaHtml()` now loads both sides: the pending set as before,
  plus the member's own `task_sigma_logs` rows (newest first, `order by
  created_at desc`) with task titles resolved.
- The sheet renders two tabs — `#reflTabs` (`data-refl-tab="pending"` /
  `"submitted"`), counts in the labels — over `#reflPanePending` and
  `#reflPaneSubmitted`. Pending keeps the existing card + *Reflect* button.
- Submitted rows carry the same eye affordance as the completed-task list
  (`.eye-btn`, `fas fa-eye`, 44 px circle, `data-refl-view="<log id>"`) plus an
  *Edit* button (`data-refl-edit`).
- `wireReflectionTabs(root)` binds tabs, eye and edit. It re-runs after a save
  because the sheet body is rebuilt in place.
- `openReflectionDetail(logId)` is the read-only view: task title, submit date,
  all five answers, and *Edit this reflection*.
- `openTaskSigmaModal(taskId, taskTitle, editLogId)` gained a third argument. On
  edit it pre-fills the five fields, titles the sheet *Edit reflection: …*, labels
  the button *Save Changes*, and **updates** (`update(answers).eq('id', editLogId)`)
  instead of inserting. After an edit the sheet reopens on the Submitted tab.
- The pending count still drives `#pendingSigmaCountBadge` /
  `#mobilePendingSigmaBadge` — that behaviour is unchanged, so the number the
  member sees still means "reflections not yet submitted".

**Security note (fixed):** `task_sigma_logs` had **RLS disabled with zero
policies**, so any signed-in client could read and rewrite every member's
reflections. Migration 06 enables RLS with owner-only policies. The new edit path
is the first client-side `update` this table has ever had, so closing it was part
of the change rather than an extra.

## A3 — The message icon that stayed for 24 hours (DONE)

**Asked:** after a new communication was pushed, a message-like icon stayed for
24 hours.

**Cause:** `public/js/comms.js` → `renderFilterPills(posts)`. The pill row was
built only from post types with a post **younger than 24 hours**
(`const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000)`), and each pill
renders an icon (`fa-bell` for a type with no mapping). So publishing a
communication in a fresh category added a pill *with its icon*, which then
vanished on its own a day later when the post aged out.

**Fix:** the pill set is now derived from **every** post type present in the
feed, with no age gate, so the filter bar matches the board and never changes
behind the member's back. The comment left in place records why.

**Not the cause:** `public/js/notification.js` (67 lines, floating
`#messenger-buzz` bubble, 24 h window at its line 6/11) is **dead code — no page
loads it** and none of its DOM targets exist. Verified against the repo and the
live site (`www.hivenectar.earth/the-meadow.html`, `/board.html`). The same is
true of `comms.js:updateMessengerBadge()` (`#messengerBadge` /
`.messenger-circle`) and `app.js:initHomeNotifications()` (`#homeNotifSection`).
Those three remain dormant; they are the only remaining 24 h cutoffs in the tree.

## A1 — Upload token and milestone images from the CRM (DONE)

**Asked:** an admin must be able to upload an image for a token and for a
milestone from the CRM, so nobody ever has to open the Supabase dashboard.

**What the live database already had (checked, not assumed):**

- `tokens.icon_url`, `milestones.icon_url`, `badges.icon_url` are `text` holding a
  **full public Storage URL** — e.g. `…/storage/v1/object/public/Token/Reflective/Seed/Mirror.svg`
  and `…/storage/v1/object/public/Badges/Nectar%20Progession/Worker10.png` —
  both confirmed resolving `200` live. Nothing prepends a base path; the member
  pages assign the stored value straight to `img.src`.
- `admin_save_token(p_data jsonb)` and `admin_save_milestone(p_data jsonb)`
  **already read `icon_url`** in both their update and insert branches, so no RPC
  and no new column was needed. The key is just part of `p_data`.
- Buckets (all `public: true`): `Token`, `Badges`, `Jar`, `Policies`, `Theme image`, `avatars`.
- `themes.bucket_folder` referenced by the old admin UI **does not exist live**
  (PostgREST `42703`); the real folder layout is by theme *name*.

**What was missing:** the storage policies and any upload control in the CRM.

**Migration `sql/2026-10-13-06-storage-and-reflections.sql` (applied, verified):**

- Replaced the over-permissive `badges_admin_insert` — it had an **empty
  `with check` and no `bucket_id` filter**, i.e. any signed-in member could upload
  to **any** bucket — with bucket-scoped `badges_admin_insert` /
  `_update` / `_delete` guarded by `storage_admin()`.
- Added `insert` / `update` / `delete` policies scoped to `Jar`, `Policies` and
  `Theme image` for `storage_admin()`, so artwork can be replaced, not only added
  (upsert needs the UPDATE policy; a new upload into an existing path needs it too).
- `Token` already had correctly scoped `token_admin_insert/update/delete`; left alone.

**CRM changes:**

- `src/admin/api.js`: `slugifyFile(name)` and
  `uploadPublic(bucket, path, file)` — `storage.from(bucket).upload(path, file,
  { upsert: true })` then `getPublicUrl(path)`, returning the same URL shape the
  member site already reads. This mirrors the proven helper in the retired
  `admin-portal.js`.
- `src/admin/sections.jsx`: new `file` field type in `FieldInput` — thumbnail of
  the stored image, file picker, and a line stating that the upload happens on
  save. `save()` uploads every chosen file **before** the save RPC runs, so a
  storage failure is reported instead of writing a row that points at nothing.
- Tokens and milestones now use it (`bucket: 'Token'` / `'Badges'`). The upload
  path is derived from the row's existing `icon_url` folder when there is one, so
  a replacement lands beside its siblings; otherwise
  `Token/<theme name>/<stage>/<file>` or `Badges/<category>/<file>`.
- Themes are now loaded for the tokens section too, because the upload folder
  needs the theme *name*.

## A2 — "manage the whole website from the CRM, never log into Supabase"

The direction, stated as the delivery rule for the remaining modules: **every
routine operation must have a CRM control backed by an admin RPC.** A page that
merely looks complete does not count. Concretely that means the remaining
sections of the brief (Support Inbox, CMS/media library, settings, admin team,
audit log) each ship with their SQL + their wiring + a verifier, in that order,
mirroring migrations 01–06.

Currently **no routine operation requires the Supabase dashboard** for tasks,
themes, tokens, milestones, badges, members, tiers, subscriptions, site content,
communications, or artwork uploads. Still dashboard-only (documented, not hidden):
creating a new Storage bucket, deploying edge functions, and anything needing the
`service_role` key, which by rule is never placed in the repo or the browser.

## Defects found during this pass (recorded, not silently fixed)

1. **`get_all_config()` does not exist.** `public/js/config.js` and
   `src/lib/supabase.js` both call it; every call 404s, so the config store
   (`app_config`: `notification_email`, `notify_broadcast`, `site_url`) is inert
   and the callers silently fall back to hardcoded defaults. Harmless today only
   because each consumer has a `|| default`. Adding the missing reader is a small
   additive RPC — flagged for approval because it would begin to *apply* stored
   config to member behaviour (welcome-email subject/sender, contact routing).
2. **Outbound email is dead.** `send-email` (and `check-renewals`) edge functions
   return 404, so the signup welcome mail, the contact-form notification and the
   broadcast notice all fail. A real delivery path is a hard prerequisite of the
   Support Centre module.
3. **Mobile reflection tile opens the wrong sheet. — FIXED 2026-10-14 (see
   §A5).** `profile.js` bound `#mobileMissionsBtn` — the button labelled *Tasks
   Reflection*, carrying the reflection badge — to `openMissionsModal()`, while the
   reflection binding at the adjacent line looks up `#mobilePendingSigmaBtn`, which
   exists in no page. It is now `openPendingSigmaModal()`, matching the label. The
   note that this button was the **only** mobile entry point to Missions was wrong:
   only `.desktop-only-grid` is hidden on mobile, so the sidebar row
   `#desktopMissionsBtn` ("Go to Missions") is still there, and the sidebar stacks
   *above* the feed (`body.page-profile .left{order:1}`). No route lost, no new UI.
4. `#tabReflectionCount` is updated by `updateTabCounts()` but exists in no page
   — a no-op, harmless.

## Verification performed

| Check | Result |
| --- | --- |
| `apply_verify_migration06.py` — policies, scoping, RLS state, live denial tests | **20 PASS / 0 FAIL** |
| `verify_reflections_flow.py` — member create / edit own / cannot touch others / anon denied / rollback held | **6 PASS / 0 FAIL** |
| `node --check` on `public/js/profile.js` and `public/js/comms.js` | syntax OK |
| `npx oxlint src/admin` | 0 issues |
| `npm run build` | clean; `dist/js/profile.js` = 175,033 B (the edited file) |
| Live-site check that no page loads `notification.js` | confirmed dead code |

**Not verified by the agent:** clicking the new UI with a real signed-in member or
admin session — this environment has no credentials and the vault cannot prompt
over Telegram. The reflection behaviour is therefore proven at the database and
source level, not by a browser round trip.

## A5 — Mobile bottom-sheet stacking: the eye no longer eats its parent (DONE)

**Asked (owner, 2026-10-14, verbatim):** *"On mobile view when I click on task
reflection daily task opens up. And when I click on eye icon on both task
reflection and completed task it overlaps the button sheet and when closed closes
the task reflection / completed task. It should be task reflection > eye >
reflection history and when closing it should close back in order rather closing
the main bottom sheet. Fix this for both task reflection and completed tasks."*

**Root cause.** `showBottomSheet()` was a **single slot**: every call began with
`const existing = document.querySelector('.bottom-sheet-overlay.active:not([data-static])'); if (existing) existing.remove();`.
Opening a detail sheet therefore *destroyed* the sheet it was opened from — the
reflection list (eye on a *Tasks Reflection* row → *Your Reflection*) and the
completed-task list (eye on a *Completed Tasks* row → that task's full card).
Because the parent was removed while still on screen, the two sheets overlapped
for the length of the exit animation, the parent's buttons stayed clickable, and
closing the detail left the member on the bare page instead of back on the list.

Two more places assumed the single slot, so they silently looked at the wrong
sheet: `document.querySelector('.bottom-sheet-overlay')` returns the **first**
overlay in document order — the static *Edit Profile* sheet — so the mobile
Daily-Tasks refresh after saving and the post-submit refresh of the *Tasks
Reflection* list never fired.

**After (both trees: `The Meadows react./public/js/profile.js` and
`Hive-Nectar-Website-02-aug2026/js/profile.js`, plus the two `style.css` files):**

- Sheets are a **stack** (`bottomSheetStack`). `showBottomSheet()` pushes; it
  never deletes anything.
- `topBottomSheet()` = the innermost connected sheet (falls back to the last
  `.bottom-sheet-overlay.active:not([data-static])` in the DOM so a sheet built by
  another module, e.g. `trial.js`, is still found).
- `syncBottomSheetStack()` marks the top sheet `.sheet-top` and the ones below
  `.sheet-behind`, and owns `document.body.style.overflow`.
- `closeBottomSheet(target)` pops exactly one sheet; the one underneath becomes
  live again immediately. `Escape` (new) closes the innermost sheet only.
- Nested sheets get `z-index: 10000 + 10 * depth`.
- CSS: `.bottom-sheet-overlay.sheet-behind { pointer-events:none }` plus a small
  recess (`translateY(16px) scale(.985)`) — the sheet underneath is visible as the
  step back but cannot be clicked, so it can no longer overlap the active sheet.
- The four "which sheet is open" lookups now use `topBottomSheet()`.

**Verification:** `verification/verify_mobile_sheet_stack.cjs` (new, in-repo,
re-runnable) slices the shipped `BOTTOM SHEET` block and the shipped CSS rules
byte-for-byte, runs them in jsdom and drives the real handlers — **43 PASS / 0
FAIL on both trees**, exit 0. It asserts the reported symptoms specifically: the
parent survives the child opening, the parent is inert, the child is on top, one
close unwinds exactly one level, body scroll stays locked while a parent is open
and is released only at the end, `Escape` pops one level, `closeAllBottomSheets()`
still hides — not removes — the static sheets, and (T9) the mobile tiles open the
sheet they are labelled with.
Run: `cd "The Meadows react." && node verification/verify_mobile_sheet_stack.cjs`
(dev-only `jsdom` devDependency added for this; an optional second argument runs
the same assertions against another tree).

**Second bug in the same report — "when I click on task reflection daily task
opens up":** `#mobileMissionsBtn` is the mobile tile labelled **Tasks Reflection**
and carries the pending-reflection badge `#mobilePendingSigmaBadge`, but it was
bound to `openMissionsModal()` (the *Daily Tasks* sheet). The markup has no
`#mobilePendingSigmaBtn`, so the reflection list had **no** mobile tile at all; it
was reachable only through the sidebar row `#pendingSigmaSection` (the sidebar
stacks above the feed on mobile, so it is visible). Fix in both trees'
`profile.js`: the tile now calls `openPendingSigmaModal()`, matching its label.
Missions keeps its own mobile entry — the sidebar "Go to Missions"
(`#desktopMissionsBtn`, wired at the same place) — so no route was lost and no
new UI was added.

**Not verified by the agent:** a click-through on a real phone with a signed-in
member — no credentials in this environment. The proof is DOM-level against the
shipped source, not a device round trip.

**Known remaining gap (deliberately untouched):** `public/js/trial.js` has its own
`showBottomSheet()` with the same single-slot delete (line 9). It is a different
page's flow, so it was left alone rather than changed without being asked.



