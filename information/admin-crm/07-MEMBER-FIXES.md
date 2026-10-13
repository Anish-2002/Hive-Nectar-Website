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
3. **Mobile reflection tile opens the wrong sheet.** `profile.js` binds
   `#mobileMissionsBtn` — the button labelled *Tasks Reflection*, carrying the
   reflection badge — to `openMissionsModal()`, while the reflection binding at
   the adjacent line looks up `#mobilePendingSigmaBtn`, which does not exist in
   `profile.html`. Left as-is deliberately: on mobile that button is the **only**
   entry point to Missions, so rebinding it to reflections would remove Missions
   from mobile. Needs a product decision (either add a Missions entry to the
   mobile tab bar first, or accept the swap).
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



