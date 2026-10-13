# The Meadow — Hive Nectar: Complete System Guide

**Document:** the single authoritative reference for the Hive Nectar / "The Meadow" application — every page, every game rule, the earning maths, the token and badge system, invitations, collaboration, the Honey Jar, the communication board and the admin back-office.

**Build documented:** `The Meadows react.` (React/Vite port, 2026-10-13)
**Backend:** Supabase project `gxboojbfmpejbjolfmjq` (`https://gxboojbfmpejbjolfmjq.supabase.co`, PostgreSQL 17)
**Live site:** https://www.hivenectar.earth
**Verification date:** 13 October 2026

> **Update, 13 October 2026 — the admin surface has been replaced.** Administration is now a
> single route in the React app, `/admin`, built on the same gated `admin_*` RPCs. The five
> legacy pages described in section 16 and in Part 2 (`CRM.html`, `admin-crm.html`,
> `admin_comms.html`, `admin_inbox.html`, `admin-achievements.html`) now redirect there, so
> every statement below about "no admin page calls the admin RPC layer" describes the tree
> **before** that replacement and is retained as the audit record of what was wrong with it.
> Section 23 documents the replacement.

## How the facts in this document were obtained

Nothing here is guesswork. Every number, literal and rule below was read from one of two sources:

1. **The production database** — read-only SQL probes against the live Supabase project. Counts, column lists, check-constraint literals, RLS policies and the full body of every scoring/awarding function were dumped and inspected. Function bodies quoted in this document are verbatim SQL.
2. **The front-end source** — the 24 page files and the JavaScript modules that drive them, in `The Meadows react.` (`src/legacy/*.html` for pages, `public/js/*.js` for behaviour).

Where the database and the front-end disagree — there are a few real cases, listed in section 22 — the document says so explicitly rather than papering over it.

Two conventions used throughout:

- **Canonical literals are shown exactly as stored**, including emoji where the database literal itself contains one (for example the stage value `🌰 Seeds`). These are data values that the code compares byte-for-byte, not decoration. Do not "clean" them in code.
- **Never** treat a displayed value as the stored value. The application deliberately displays cleaned text (see the no-emoji display layer, section 21).

---

## Contents

Part 1 — The rules and the data
1. Executive overview
2. Platform architecture
3. Vocabulary — the canonical literals
4. Membership, tiers and billing
5. Themes
6. Stages and the maturity guardrails
7. The task engine (catalogue, fetching, the 24-hour sequential unlock, completing, filters)
8. Points, levels and impact maths
9. Tokens
10. Milestones
11. Badges
12. The Honey Jar
13. Collaboration and invitations
14. The social layer and privacy
15. The Communication Board
16. Admin and the privilege model
17. Database security model
18. Complete function inventory (91 signatures)
19. Integrations (storage, email, payments)
20. Configuration reference
21. Design and display rules that affect behaviour
22. Known gaps, inconsistencies and current risks

Part 2 — The pages and the flows
2.1 Site shell and entry point
2.2 Member area (profile, board, collaboration invite, honey jar)
2.3 The Honey Jar details
2.4 Administration surfaces
2.5 Support scripts
2.6 End-to-end journeys
2.7 Operator playbooks — where to change what
2.8 Glossary
2.9 Verification commands used

## 1. Executive overview

Hive Nectar is a membership web application that turns small personal sustainability and wellbeing actions into a long-running, social, collectible game. The metaphor is a hive: members are bees, the shared space is the Meadow, effort produces **nectar**, and nectar plus consistency produces **tokens** (collectible, bee-themed artefacts), **milestones**, **badges** and a **Honey Jar** in which those collectibles are physically arranged.

The product's core loop:

1. A member picks a task from a theme (for example "Had a short walk for at least 15 minutes" in the Connecting theme).
2. Completing the task awards nectar, advances theme progress and may unlock the next task in the theme after a cooldown.
3. Enough completions in a theme + stage award a **token**. Tokens, milestone awards and badges can be placed in the **Honey Jar**, which can be exported as an image.
4. Nectar accumulates: it sets the member's **level** (Novice → Experienced) and **engagement level** (Seed → Sprout → Bloom → Harvest), and appears on a leaderboard.
5. Membership tier (free, or one of three paid plans) decides how much of the game is visible: which stages, which themes, and whether collaboration — partnering with another member on the same task list — is available at all.
6. The **Communication Board** is the hive's shared noticeboard; the **messenger** is the private channel; the **TRail** section is the member's library of policy briefs, gardening tips, planners and video content.

The application is deliberately low-pressure: no streak-shaming, no shrinking denominators, no loss states. Progress is always shown as `completed / total` with an animated bar, and rewards are only ever added, never removed.

### Live data at verification time

| Entity | Rows | Notes |
|---|---|---|
| Members (`profiles`) | 20 | 1 profile marked public |
| Tasks (`tasks`) | 150 | 15 theme×stage buckets of 10 |
| Themes (`themes`) | 5 | T01–T05 |
| Tokens (`tokens`) | 70 | 60 active, 10 deliberately inactive |
| Tokens held (`user_tokens`) | 51 | |
| Milestone definitions (`milestones`) | 32 | |
| Badges / badge stages | 5 / 20 | 4 stages each |
| Theme guardrails | 10 | 2 per theme (Sprout, Bloom) |
| Impact conversion factors | 11 | CO₂e per unit |
| Products / prices | 3 / 3 | Hive+ 10, Steward 20, Collective 25 per month |
| Communication posts | 6 | |
| Collaborations | 1 | |
| Admins (`admin_users`) | 1 | `anhishgautam@gmail.com` |
| Tables in `public` schema | 42 | 37 with row-level security, 70 policies |
| Stored functions | 91 signatures / 88 names | 3 overloaded pairs |

---

## 2. Platform architecture

### 2.1 Front-end

The React application is a thin shell around faithfully-mounted original pages.

- `src/legacy/*.html` — the 24 original pages, kept byte-identical to the production static site.
- `src/components/LegacyPage.jsx` plus `src/lib/legacy.js` — mounts a legacy page as a live, script-executing region (not an iframe), with `legacyHtmlFallback()` for graceful degradation.
- `public/js/*.js` — 22 behaviour modules (task engine, jar, board, admin, social, notification, emoji display filter, and so on).
- Routing: real `.html` paths are served, so links such as `the-meadow.html`, `profile.html` or `decorator.html` work exactly as they did on the static site.
- Build: Vite. Dev server `npm run dev` → `http://127.0.0.1:5210`; production build `npm run build` → `dist/`; `npm run preview` → `http://127.0.0.1:5211`.
- Deployment description lives in `vercel.json` (framework `vite`, output `dist`, `*.html` rewrite). No server-side code and no secret keys: the only environment inputs are `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`, both public by design.

### 2.2 Back-end

Single Supabase project. Everything the application does is either a table read/write (governed by row-level security) or a call to a stored function. There is no separate API service.

- Auth: Supabase email/password. Auto-confirm is enabled on the project, so registration does not require an email round trip.
- Storage: public-read buckets hold token art, badge art and theme imagery (section 20).
- Email: transactional mail is sent through Brevo SMTP, configured at the project level. An `app_config` row records the notification address (`follydevs@gmail.com`) and the site URL (`https://www.hivenectar.earth`).
- Payments: Stripe, via edge functions (section 20.3).

---

## 3. Vocabulary — the canonical literals

These strings are stored verbatim and compared byte-for-byte by the code. Changing them in one place without changing them everywhere silently breaks gating.

**Stages** (task and progress stage; the four growth stages of the metaphor):

| Display | Stored literal | Meaning |
|---|---|---|
| Seeds | `🌰 Seeds` | The entry stage. The only stage every member sees. |
| Sprout | `🌱 Sprout` | Second stage. Requires member tier ≥ 1. |
| Bloom | `🌸 Bloom` | Third stage. Requires member tier ≥ 2. |
| Harvest | `🌾 Harvest` | Fourth stage. Requires member tier 3. Currently no tasks exist in this stage. |

A second, separate stage vocabulary is used by the progress engine's day counters and by badge stages, where the values are plain words: `Seed`, `Sprout`, `Bloom`, `Harvest` (used by `calculate_points` engagement multipliers and `update_user_levels`) and `Sprout`, `Bloom`, `Grow`, `Harvest` (the four badge-stage names, `stage_order` 1–4).

**Tiers** (see section 4): `member_tier` 0–3, and the text tiers `free`, `plus`, `steward`, `collective`.

**Themes:** `T01`…`T05` — Connecting / Belonging, Creating, Innovating, Reflecting, Acting / Motivating.

**Token codes:** `TB-<theme><stage>-<n>` for the ten collectible art tokens per theme (60 active), `TE-0xx` for the milestone-issued theme tokens (10 inactive rows, 15 milestone-linked awards).

**Levels:** `Novice`, `Experienced`.
**Engagement:** `Seed`, `Sprout`, `Bloom`, `Harvest`.
**Membership longevity:** `New Bee` is the default `member_status`.
**Invite states:** `pending`, and the terminal states the RPC writes (`accepted`).
**Inquiry states:** `unread`, `resolved` (observed values), with categories `general`, `support`, `test`.

---

## 4. Membership, tiers and billing

### 4.1 The two tier fields

The member's access level is `profiles.member_tier` — an integer 0–3. It is the field every gate reads. Alongside it:

- `profiles.tier` — a text label (`free`, `collective` are the observed values).
- `profiles.subscription_tier` — the paid plan name (`collective` observed), or NULL for members who never subscribed.
- `profiles.subscription_status` — `active`, `canceled`, `expired` or NULL.
- `profiles.stripe_customer_id`, `profiles.stripe_subscription_id`, `profiles.subscription_current_period_end`, `profiles.subscription_cancel_at_period_end` — billing mirrors of the Stripe subscription row.

### 4.2 What each tier sees

This is enforced in the database by `get_user_tasks_v2`, verbatim:

```sql
allowed_stages := CASE user_member_tier
    WHEN 0 THEN ARRAY['🌰 Seeds']
    WHEN 1 THEN ARRAY['🌰 Seeds', '🌱 Sprout']
    WHEN 2 THEN ARRAY['🌰 Seeds', '🌱 Sprout', '🌸 Bloom']
    WHEN 3 THEN ARRAY['🌰 Seeds', '🌱 Sprout', '🌸 Bloom', '🌾 Harvest']
    ELSE ARRAY['🌰 Seeds']
END;
```

So tier 0 (free) is a Seeds-only experience; tier 3 sees everything, including the Harvest stage — which currently has no tasks authored (section 21).

A second, independent gate is `themes.min_tier`:

| Theme | Name | min_tier |
|---|---|---|
| T01 | Connecting / Belonging | 0 |
| T02 | Creating | 0 |
| T03 | Innovating | 0 |
| T04 | Reflecting | 1 |
| T05 | Acting / Motivating | 1 |

Themes T04 and T05 are therefore hidden from free members. This gate is applied on the client (theme selector and task filters); the database does not filter themes by tier.

A third gate governs collaboration: inviting and working with a partner requires the **Collective** tier. Members below it get an upgrade prompt instead of the invite controls (section 14).

### 4.3 Plans, products and prices

Stripe objects are mirrored into the database:

| Product id | Name | `tier_name` | Price id | Amount | Interval |
|---|---|---|---|---|---|
| `prod_UA887AjJ5IRT3T` | Hive+ | `plus` | `price_1TBnsd2Lbr3N4JyiOnT9fMek` | 10 | month |
| `prod_UA8DnYOVPykKPG` | Steward | `steward` | `price_1TBnxR2Lbr3N4JyiQB94irAS` | 20 | month |
| `prod_UOLwLbHL3MSdam` | Collective | `collective` | `price_1TPZEK2Lbr3N4JyiobLYnSeI` | 25 | month |

Amounts are stored as integers in the currency's minor unit as supplied by Stripe; `currency` is NULL on all three rows, and `trial_period_days` is NULL on all three (no trials configured at present).

### 4.4 Subscription lifecycle

- `handle_subscription_event(p_event_type, p_stripe_sub_id, p_customer_id, p_period_end, p_product_id)` — the webhook target. It writes the subscription row and mirrors plan state onto the profile.
- `downgrade_expired_subscriptions()` — sweeps subscriptions whose period has ended and drops the member back down.
- `check_upcoming_renewals(p_days_ahead)` — returns the subscriptions renewing inside the window, for the renewal reminder email.
- `subscriptions` columns: `id`, `customer_id`, `price_id`, `status`, `current_period_start`, `current_period_end`, `cancel_at_period_end`, `trial_start`, `trial_end`, `metadata`, `created_at`, `tier`, `user_id`, `stripe_subscription_id`, `stripe_customer_id`, `updated_at`.

Edge functions `stripe-checkout`, `stripe-webhook` and `cancel-subscription` are deployed; `check-renewals` and `send-email` are **not deployed** (they return 404), so the renewal sweep and generic mailer are not yet live (section 22).

### 4.5 Current population

At verification: 16 members on tier 0, 1 on tier 1, 2 on tier 2, 1 on tier 3. By text tier, 18 `free` and 2 `collective`. Subscription status shows 2 active, 2 canceled, 2 expired, 14 with no subscription record.

---

## 5. Themes

Each theme is a coherent domain of action with its own colour pair, token family and tone.

| id | Name | Token family | min_tier | Primary | Secondary |
|---|---|---|---|---|---|
| T01 | Connecting / Belonging | Roots | 0 | `#2A6041` | `#B48B56` |
| T02 | Creating | Forge | 0 | `#D3724A` | `#EADDC7` |
| T03 | Innovating | Shift | 0 | `#2A646D` | `#D9A441` |
| T04 | Reflecting | Echo | 1 | `#A89CC0` | `#C7C5BE` |
| T05 | Acting / Motivating | Rhythm | 1 | `#F6B44D` | `#EE7C57` |

The `themes` table also carries narrative columns — `includes`, `symbolism`, `essence`, `emotional_tone`, `visual_symbol_icon_idea`, `colour_symbolism`, `purpose`, `sub_topics`, `example_focus` — which hold the editorial description of each theme. Task cards inherit `themes.primary_color` as their accent (falling back to `#F59E0B` when a task has no theme row).

Theme colour is also the tie-breaker when the interface orders locked cards of equal unlock time.

---

## 6. Stages and the maturity guardrails

Stage is a property of each task and of each progress row. The ladder is Seeds → Sprout → Bloom → Harvest.

Beyond stage, the design intends a *guardrail*: a filter that stops a member from paying for a stage in one sitting, so that consistency, not speed, is the thing being rewarded. The guardrails live in `theme_guardrails`, two rows per theme:

| Theme | Stage | min_days | min_task_types | min_spread_days | min_nectar |
|---|---|---|---|---|---|
| T01–T05 (each) | Sprout | 3 | 2 | 14 | 50 |
| T01–T05 (each) | Bloom | 7 | 4 | 30 | 200 |

Read as: to hold a Sprout credential in a theme, at least 3 days of activity, 2 distinct task types, activity spread over 14 days and 50 nectar earned; for Bloom, 7 days, 4 types, 30 days spread and 200 nectar.

The raw material for these checks is `user_theme_progress`, which is populated by `increment_theme_stage_progress(p_user_id, p_theme_id, p_stage, p_increment)`: it updates `novice_days_count` and `experienced_days_count` by the increment for the (user, theme, stage) row, or inserts it if absent, stamping `first_action_date` and `last_action_date`.

**Current state:** the guardrail table is reference data — no stored function reads it, and no RPC in the deployed 91 evaluates `min_days`, `min_spread_days` or `min_task_types` to block anything. The day counters exist and are maintained; the gate itself is designed but not wired. The client matches that: the dashboard fetches only `min_days` into a `stageGuardrails` variable, never reads the value back, never selects `min_task_types`, `min_spread_days` or `min_nectar`, and the `bypassGuardrails` identifier that appears near the guardrail code is never declared or tested. Nothing in the product currently stops a member from finishing a stage in one sitting. Documented in section 22.

---

## 7. The task engine

### 7.1 The task catalogue

150 tasks, structured as 15 buckets: 5 themes × 3 stages × 10 tasks. Every bucket is exactly ten rows with `task_order` 1…10, and every row is `active`.

| Distribution | Count |
|---|---|
| T01 T02 T03 T04 T05, each stage | 10 tasks each |
| Seeds (all themes) | 50 |
| Sprout (all themes) | 50 |
| Bloom (all themes) | 50 |
| `required_level` 0 / 1 / 2 | 50 / 50 / 50 |
| `nectar_reward` | 10 on every task |
| `available_from` / `available_to` | NULL on all 150 (no scheduled tasks) |

`required_level` looks like a difficulty gate (0 / 1 / 2 in even 50-task bands) but nothing reads it. The identifier appears nowhere in the dashboard code (`profile.js`, `theme-tokens.js`, `share-card.js`) and no task-serving filter consults it. Task gating is tier + stage + sequence only, and the column is descriptive metadata until a consumer is written.

Task columns of note: `id` (uuid), `task_id` (human code), `task_title`, `task_description`, `core_task`, `novice_description`, `experienced_description`, `core_theme`, `category`, `stage`, `theme_id`, `task_order`, `task_group`, `nectar_reward`, `impact_type`, `impact_unit`, `impact_unit_value`, `impact_base_value`, `impact_value`, `audience`, `required_level`, `examples`, `source_url`, `event_tag`, `available_from`, `available_to`, `active`, `created_at`.

The `core_task` column holds the short imperative version of the task (for example `Had a short walk for at least 15 minutes`), and `core_theme` holds a themed label such as `🌱 Connecting / Belonging`. Note that `core_theme` is a label, while `theme_id` is the foreign key that drives gating, tokens and progress. Section 21 records the places where `core_theme` is wrong.

### 7.2 Fetching tasks — the table path, and the unused `get_user_tasks_v2`

Two code paths express "the tasks I may see", and only one of them runs.

**What the dashboard actually does.** `fetchBaseTasksForTier(tierNum)` in the task engine queries the tables directly: `themes` filtered by `.lte('min_tier', tierNum)` (selecting `theme_id, theme_name, primary_color, secondary_color`), then `tasks` filtered by `.in('theme_id', themeIds)` with `select('*')`. It keeps only rows whose stage passes `allowedStages.includes(stageKey(task.stage))`, and maps each row so `subcategory` falls back to `category` and the theme's `primary_color` is attached. No stored function is involved, and `subcategory` — not `category` — is the field the Subcategory filter reads.

**What the database offers, unused.** `get_user_tasks_v2(p_user_id, ...)` implements the same idea server-side. In order:

1. Read the member's `member_tier`; raise if the user does not exist.
2. Build `allowed_stages` from the tier (section 4.2).
3. Return every task whose `stage` is in `allowed_stages`, **excluding tasks the member has already completed in the novice version**.
4. Attach `themes.primary_color` for the card accent.
5. Attach the theme progress row and compute `is_unlocked := COALESCE(utp.unlocked_task_index, 0) >= t.task_order - 1`.

The dashboard does not call it, and three consequences follow. First, the theme tier gate on T04/T05 is enforced wholly client-side by the `themes.min_tier` comparison above. Second, the `is_unlocked` the function computes is never displayed. Third, the column it depends on — `user_theme_progress.unlocked_task_index` — is written by nothing in the database, so the rule members experience is the client-side rule in 7.3. The duplication also means the tier/stage allowlist exists in two places and can drift.

`get_user_tasks(p_user_id)` is the older v1 of the same idea, also present and also unused by this page.

### 7.3 The real unlock rule (client-side, sequential + 24-hour cooldown)

This is the mechanic members actually experience, implemented in the task engine (`public/js/profile.js`, the per-task unlock pass). Verbatim logic:

- Tasks are grouped by `theme_id` and sorted by `task_order`.
- **Index 0** (the first task of a theme): always unlocked unless already completed.
- **Any later task**: locked until its immediate predecessor **in the same theme** is completed. If the predecessor is not complete, the card's message is `Complete "<previous task title>" to unlock`.
- **When the predecessor is complete**, a **24-hour cooldown** starts (`cooldownHours = 24`). Until 24 hours have elapsed since the predecessor's completion timestamp, the task stays locked with the message `"<previous task title>" completed — <N>h until unlocked` (or, under an hour, `…<N>m until unlocked`), and the card carries `unlock_at = predecessor_completed_at + 24h`. Because `unlock_at` is a timestamp, the interface can count the lock down live — this is the moving number seen on locked cards.
- When the predecessor is complete and 24 hours have passed, the task unlocks (unless the task itself is done).

Locked cards are ordered **soonest to unlock first**. Cards with a clock (3h, 6h, 12h left) sort by `unlock_at`; chain-locked cards with no clock (the predecessor is not done, so there is no start time) go last; ties break by theme id and then `task_order`. Only the first three locked cards are shown with a `Show N more locked tasks` control.

### 7.4 The dashboard's five card states

Every task card resolves to one of five visual states, in this precedence:

| State | Condition |
|---|---|
| `both` | The member completed it **and** the collaboration partner completed it |
| `done` | The member completed it |
| `locked` | Not completed and not unlocked (predecessor incomplete, or inside the 24h cooldown) |
| `due` | Not completed, not locked, and the partner has completed tasks the member has not |
| `available` | Everything else |

The marking control follows state: a checkbox when `available` or `due`, a lock icon when `locked`, a check icon when `done` or `both`. Partner context lines appear only for members with collaboration access.

An important implementation note: a completed task is persisted with `is_unlocked = false`, so `isLocked` must be computed as `!is_unlocked && !isCompleted`. Computing lock state before completion state crashes the render (temporal-dead-zone bug). Completed tasks are counted in the progress bar but are not re-rendered as cards in the daily list; the explicit "mine" filter is the completed-only view.

### 7.5 Completing a task — `complete_task`

Verbatim behaviour of `public.complete_task(p_user_id, p_task_id, p_version default 'novice')`:

```sql
IF p_user_id IS DISTINCT FROM auth.uid() THEN
    RETURN jsonb_build_object('success', false, 'error', 'Unauthorized');
END IF;

IF EXISTS(SELECT 1 FROM user_tasks WHERE user_id = p_user_id AND task_id = p_task_id AND version = p_version) THEN
    RETURN jsonb_build_object('success', false, 'error', 'Task already completed');
END IF;

SELECT COALESCE(t.nectar_reward::integer, 10) INTO nectar_earned FROM tasks t WHERE t.id = p_task_id;

INSERT INTO user_tasks (user_id, task_id, version, completed_at) VALUES (p_user_id, p_task_id, p_version, NOW());

UPDATE profiles SET
    nectar_points = COALESCE(nectar_points::integer, 0) + nectar_earned,
    total_tasks_completed = COALESCE(total_tasks_completed::integer, 0) + 1
WHERE id = p_user_id
RETURNING user_level, engagement_level INTO new_level, new_engagement;

awarded_tokens_result := award_theme_tokens(p_user_id);
```

Points to note:

- Authorisation is `auth.uid()` — a member can only complete tasks for themselves.
- Duplicate protection is per **version**: the same task can be completed once as `novice` and once as `experienced`.
- Reward: the task's own `nectar_reward`, defaulting to 10.
- The function does **not** call `update_user_levels` and does **not** consult `calculate_points`. The level values it returns are read from the profile row **before** the level would change, so `new_user_level` / `new_engagement_level` in the response are the pre-completion values unless something else recalculated them earlier. It also does not write `user_theme_progress`, so completing a task does not by itself advance progress counters or the cooldown chain beyond what the client tracks.
- `user_tasks` columns include `version`, `completed_at`, `completion_date`, `completion_day`, `points_awarded`, `calculated_nectar`, `co2_saved_kg`, `calculated_co2e_saved`, `multiplier_applied`, `applied_multiplier`, `experience_level`, `status`, `evidence_url`. Only a subset is written by the deployed path.
- **What the client expects back.** After the call the dashboard reads `result.points_earned`, `result.awarded_milestones` and `result.awarded_tokens` to update the counters and to toast `"<name> milestone unlocked!"` and `New token: <name> (<stage>)`. Those toasts therefore depend on the response keys: the body quoted above demonstrably returns the token result, so a missing toast means a missing display key, not a lost award.
- **What the client does next.** It records the completion locally, reloads `user_theme_progress`, refreshes the task list and the profile UI, calls `check_and_award_milestones`, and toasts `"<completed task>" done! "<next task in theme>" unlocks in 24h`.

### 7.6 Novice and Experienced task versions

Each task can carry two authored descriptions: `novice_description` and `experienced_description`. The dashboard renders one version at a time (`showingExperienced`), and completion records are keyed by version, so a member who levels up can replay the same catalogue at the higher difficulty and earn nectar for it again. `profiles.prefers_experienced` remembers the choice.

### 7.7 Filters, progress bar and the completed badge

The dashboard exposes three filters — **Core Theme**, **Stage**, **Subcategory** — whose option values are the raw stored literals (for example `🌰 Seeds`). Filtering is client-side and composes with the theme selection and the "mine / partner / theme" story chips.

Progress is displayed as a percentage **against the visible scope, including completed tasks**, and never as a shrinking remainder:

```js
const pct = totalVisibleTasks
    ? Math.min(Math.round((completedVisibleTasks / totalVisibleTasks) * 100), 100)
    : 0;
progressPct.innerText = `${pct}% (${completedVisibleTasks}/${totalVisibleTasks})`;
```

Three copies of this bar exist in the markup (desktop, mobile, mobile copy) and all three are updated together, along with the completed badge, the pending-sigma badge, the tab counts and the partner comparison.

A worked example from the shipped build: `3% (1/30)` — one completed task in a 30-task visible scope.

### 7.8 Task card interactions

Three further controls sit on every card, each with its own table:

| Control | Behaviour |
|---|---|
| Like / dislike | Upserts `task_feedback` on the key `(user_id, task_id)`, so a member holds one reaction per task and switching replaces it. The buttons repaint from the cached value. |
| Comment | Inserts into `task_comments`; the author can edit or delete their own row from the card. |
| Proof of completion | A free-text field (`Proof of completion (link or description)`), stored in `task_sigma_logs.improve`. |

There is **no photo or file upload for a task**. The only file upload on the dashboard is the avatar (Supabase Storage bucket `avatars`, upsert, public URL).

Reflections are separate from completions: `sigma_logs` holds a general improvement log (define / measure / analyse / improve / control) and `task_sigma_logs` holds a per-task reflection. The "Tasks Reflection" panel lists completed tasks that have no `task_sigma_logs` row, so its badge counts outstanding reflections rather than tasks.

---

## 8. Points, levels and impact maths

### 8.1 The scoring formula

`calculate_points` exists in two overloads — one taking a numeric impact value, one taking a text impact value from which it extracts the first number with `regexp_match(impact_text, '(\d+(?:\.\d+)?)')`, falling back to 1 if no number is present. Both then return:

```
points = impact × stage_multiplier × user_level_multiplier × engagement_multiplier
```

with the multipliers, verbatim:

| Factor | Value |
|---|---|
| Stage `🌰 Seeds` / `🌱 Sprout` / `🌸 Bloom` / `🌾 Harvest` | 1 / 2 / 3 / 4 |
| Stage unknown | 1 |
| Level `Novice` / `Experienced` | 1 / 2 |
| Engagement `Seed` / `Sprout` / `Bloom` / `Harvest` | 1 / 2 / 3 / 4 |
| Engagement unknown | 1 |

Neither overload is `SECURITY DEFINER` and neither is called by `complete_task`, so the multiplier model currently describes the intended design rather than the deployed earning path (which pays a flat `nectar_reward`, 10 by default).

### 8.2 Level and engagement thresholds — `update_user_levels`

Verbatim:

```sql
user_level = CASE WHEN total_points >= 100 THEN 'Experienced' ELSE 'Novice' END
engagement_level = CASE
    WHEN total_points < 50  THEN 'Seed'
    WHEN total_points < 200 THEN 'Sprout'
    WHEN total_points < 500 THEN 'Bloom'
    ELSE 'Harvest'
END
```

Read as: **Novice** below 100 nectar, **Experienced** from 100. Engagement **Seed** < 50, **Sprout** 50–199, **Bloom** 200–499, **Harvest** 500+.

`update_user_levels(p_user_id)` returns `(new_user_level, new_engagement_level)`. The dashboard also computes an equivalent client-side so the header level and the leaderboard agree between RPC calls.

### 8.3 Impact and CO₂e

Every task can name an `impact_type`, an `impact_unit` and a base value; `impact_conversion` holds the CO₂e factor per unit:

| id | Impact type | CO₂e per unit | Unit |
|---|---|---|---|
| I01 | Electricity Reduction | 0.8 | kWh |
| I02 | Fuel Avoidance / Mobility | 0.16 | km |
| I03 | Food Waste Avoidance | 1.8 | kg |
| I04 | Material / Product Avoidance | 0.25 | item |
| I05 | Waste Diversion / Recycling | 0.1 | item |
| I06 | Water Saving | 0.0003 | L |
| I07 | Nature Connection | 0 | Attention moment |
| I08 | Relational / Bonding | 0 | Relational signal |
| I09 | Education / Reflection | 0 | Expression instance |
| I10 | Community / Collective Action | — | Variable, scale by participants |
| I11 | Innovation / Systemic Influence | — | Contextual or multiplier-based |

CO₂e savings accumulate on `profiles.total_co2e_saved` and on `user_tasks.co2_saved_kg` / `calculated_co2e_saved`. Note that I07–I09 are intentionally zero-carbon: the product also scores connection and reflection, and it does not pretend those have an emissions factor.

### 8.4 Leaderboard

`get_leaderboard(p_limit)` is the ranking source. The dashboard displays nectar over a 100-point maximum ring or bar, consistent with the 100-nectar Experienced threshold. Ties and tie-breakers are handled in the function (it is `SECURITY DEFINER`, so it can rank across members whose `profiles` rows are otherwise private). Anonymity rules are covered in section 15.

---

## 9. Tokens

### 9.1 What a token is

A token is a collectible artefact with artwork, a name, a code and a stage. Tokens are **reveal-only**: they are never deleted, and there is no user-facing path that removes a token. `tokens.active = false` is the retirement mechanism.

### 9.2 Catalogue

70 rows: 14 per theme on average, distributed across the three stages.

| Theme | Rows | Active codes |
|---|---|---|
| T01 Connecting | 15 | `TB-…` |
| T02 Creating | 15 | `TB-…` |
| T03 Innovating | 12 | `TB-…` |
| T04 Reflecting | 13 | `TB-…` |
| T05 Acting / Motivating | 15 | `TB-…` |

60 rows are active; 10 are the `TE-0xx` theme tokens used as milestone rewards (section 10) and are deliberately inactive as catalogue items.

Each token row carries `theme_id`, `stage`, `name`, `description` (a JSON document containing the token code, stage, core theme, `tasks_required` and a short "copy" line), `tasks_required`, `icon_url`, `active`.

### 9.3 How tokens are awarded — `award_theme_tokens`

Called at the end of every successful `complete_task`. Verbatim logic:

```sql
FOR tok IN SELECT * FROM tokens ORDER BY theme_id, stage LOOP
    IF already awarded to this user THEN CONTINUE; END IF;
    SELECT COUNT(*) INTO completed_count
      FROM user_tasks ut JOIN tasks t ON t.id = ut.task_id
     WHERE ut.user_id = p_user_id AND t.theme_id = tok.theme_id AND t.stage = tok.stage;
    IF completed_count >= tok.tasks_required THEN
        INSERT INTO user_tokens (user_id, token_id, awarded_at, viewed) VALUES (p_user_id, tok.id, NOW(), false);
    END IF;
END LOOP;
```

The thresholds in the catalogue are **5, 10 and 15 completed tasks** for the three stages. One consequence deserves emphasis: the loop selects **every** token row for the theme+stage and awards every one whose threshold is met, and it does not filter on `active`. Because the four art tokens for a theme+stage all carry the same threshold, the first time a member reaches 5 completions in (theme, stage) they are awarded **all four** art tokens for that bucket at once — which is why the live database shows 51 held tokens across 20 members. The 10 inactive `TE-` rows are also eligible under this loop.

### 9.4 Token display, reveal and viewing

- `get_user_revealed_tokens(p_user_id)` returns the member's tokens for display. It is defined in the database but **not called by the dashboard or by the jar**: both read `user_tokens` with a direct table select instead.
- `mark_token_viewed(p_user_id, p_token_id)` sets `user_tokens.viewed = true`. Also defined and also unused by the current client — the only viewing call the dashboard makes is `mark_milestone_viewed`, for milestones. The reveal-only principle still holds in the schema: tokens are never deleted, only revealed, and retired with `active = false`.
- `user_tokens` columns: `id`, `user_id`, `token_id`, `acquired_at`, `awarded_at`, `viewed`.
- Storage layout (bucket `Token`, public read): `Token/<Theme Name>/<Stage>/<Token>.svg`, for example `Token/Connecting Belonging/Seed/Seedling.svg`, `Token/Acting Motivating/Bloom/Compass.svg`. Stage folders are the singular words `Seed`, `Sprout`, `Bloom`.

---

## 10. Milestones

`milestones` holds 32 definitions. Each has `name`, `category`, `requirement_value`, `reward_type` (`points` or `token`), `reward_value`, `icon_url`, `description`, `active`.

| Category | Rows | What it tracks | Examples |
|---|---|---|---|
| `nectar` | 6 | Lifetime nectar earned | Worker 10 / 25 / 50 / 100 / 500 / 1000 |
| `tasks` | 4 | Total tasks completed | Seed Sower 10, Sprout Keeper 25, Bloom Guardian 50, Harvest Mentor 100 |
| `membership` | 3 | Days of membership | New Bee 30, Steady Wing 100, Hive Veteran 365 |
| `referrals` | 3 | Members invited | Pollinator 5 / 10 / 25 |
| `sigma` | 1 | Improvement logs written | Sigma Eye at 3 |
| `theme_token` | 15 | Theme-stage completion | Roots Seed / Sprout / Bloom, Forge…, Shift…, Echo…, Rhythm… |

Rewards are 12 point awards and 20 token awards. Point rewards are 10, 25, 50 and 100; token rewards name either a theme token (`TE-001` … `TE-015`) or a one-off such as `steady_wing_token`, `veteran_token`, `special_nectar_token`, `sigma_eye_token`, `harvest_master_token`.

The theme-token milestones are the interesting ones: `requirement_value` 5, 15 and 30 completions in the theme, corresponding to Seeds, Sprout and Bloom presence, and each one names the `TE-` code with its own copy line — for example Roots Seed: *"You showed up for belonging — five roots planted."*

### How milestones are actually awarded

`check_and_award_milestones(p_user_id)` is `SECURITY DEFINER` and implements exactly five categories, matched by literal comparison:

```
milestone.category = 'membership'
milestone.category = 'nectar'
milestone.category = 'referrals'
milestone.category = 'sigma'
milestone.category = 'tasks'
```

The `theme_token` category is **not** evaluated by this function, so those 15 rows — the ones carrying the `TE-` codes — are currently definitions only and are not awarded by the deployed path. The `TE-` tokens can still arrive through `award_theme_tokens`, whose loop does not filter on `active`.

Supporting functions: `award_milestone(p_user_id, p_milestone_id)`, `mark_milestone_viewed(p_user_id, p_milestone_id)` (two overloads), `admin_save_milestone(p_data jsonb)`, `admin_delete_milestone(p_milestone_id)`, `admin_list_user_milestones()`, `admin_delete_user_milestone(...)`. Held milestones live in `user_milestones` (`id`, `user_id`, `milestone_id`, `achieved_at`, `is_legacy`, `viewed`).

`is_legacy` matters: it marks a milestone granted before the current rules, so historic accounts keep their trophies.

---

## 11. Badges

Badges are the long-form achievement track, distinct from tokens and milestones: five badges, one per theme, each with four stages.

| Badge | Theme | Stages |
|---|---|---|
| KindHive | T01 | 4 |
| ZeroWaste Loop | T02 | 4 |
| EcoMind | T03 | 4 |
| GreenRhythm | T04 | 4 |
| SeedSower | T05 | 4 |

Badge stage names, in order, are the same for every badge:

| stage_order | stage_name | Requirement description (verbatim) |
|---|---|---|
| 1 | Sprout | Pick habit (cup, commute, energy). |
| 2 | Bloom | Ideate and sketch one fix. |
| 3 | Grow | Build or simulate a prototype. |
| 4 | Harvest | Mentor another Hive member. |

`badge_stages` columns: `id`, `badge_id`, `stage_order`, `stage_name`, `requirement_description`, `co2e_target`, `reach_target`, `required_task_ids`, `required_token_ids`, `required_milestone_ids`. A stage can therefore be defined by CO₂e or reach targets, or by explicit lists of tasks, tokens and milestones that must be held first.

The lifecycle, by function:

- `submit_badge_stage(p_user_id, p_badge_id, p_stage_order, p_evidence, p_metrics)` — the member submits a stage with evidence text and metrics.
- `check_badge_stage_auto_approval(p_user_id, p_badge_id, p_stage_order)` — decides whether the submission can be auto-approved (it is not `SECURITY DEFINER`).
- `approve_badge_stage(p_submission_id)` — approves a submission (not `SECURITY DEFINER`).
- `award_stage_bonus(p_user_id, p_badge_id, p_stage_order)` — issues the stage reward (not `SECURITY DEFINER`).

The five-badge visual language also appears in the achievements area of the member dashboard, which renders the badge grid alongside milestone trophies.

---

## 12. The Honey Jar

The Honey Jar is the object-placement layer: a member arranges their collectibles inside a jar, the arrangement is saved, and the jar can be exported as an image.

### 12.1 Storage model

`user_jar_decorations`:

| Column | Meaning |
|---|---|
| `id` | Row id |
| `user_id` | Owner |
| `milestone_id` | A milestone trophy placed in the jar (nullable) |
| `token_id` | A token placed in the jar (nullable) |
| `x_pos`, `y_pos` | Position as a percentage across the jar's wood face — `50,50` is the centre (the client clamps 0–100, the server clamps again) |
| `scale` | Sticker radius as a fraction of the wood-face radius (0.10–1.05 in the client, 0.1–4 accepted by the server) |
| `rotation` | Rotation in **radians** (added by the sample hardening script; until the column exists the client mirrors rotation per user in `localStorage` under `jar_rot_<uid>`) |
| `created_at` | When placed |

So an item in the jar is either a milestone or a token — the two `*_id` columns are alternatives. The RPC itself accepts a row where both are NULL, so the either/or is a convention rather than a constraint.

### 12.2 Saving — `save_jar_decorations`

`save_jar_decorations(p_user_id, p_decorations jsonb)` is `SECURITY DEFINER` with `SET search_path TO 'public'`, and takes the whole arrangement as a JSON document. Saving is a **full replace, not an upsert**: the function deletes the member's rows and re-inserts them from `jsonb_array_elements(p_decorations)` in a single statement, returning `void`. Ownership is enforced inside the function — `auth.uid()` must equal `p_user_id` (or the caller must be `service_role`), otherwise it raises `28000 not authenticated` or `42501 forbidden: cannot write another user's jar`. That closes a real hole: the function had been `EXECUTE`-granted to `anon` with no ownership check, so any caller holding the public anon key could `DELETE + INSERT` another member's jar rows (an unauthenticated DELETE returning 204 was confirmed live). The hardening script revokes EXECUTE from `anon`/`public`, grants it to `authenticated` and `service_role`, adds the `rotation` column, and clamps every value server-side (`x_pos`/`y_pos` to 0–100, `scale` to 0.1–4, `rotation` defaulting to 0, `milestone_id` accepted only when numeric, `token_id` only when it has a UUID shape). `admin_list_jar_decorations()` gives admins the cross-member read.

Client-side, `buildJarPng()` renders the export, and images loaded into the canvas carry `crossOrigin` so the canvas is not tainted — without it the PNG export would fail.

### 12.3 Sources of jar items

The sticker tray is built from every token the member owns: `user_tokens` (all rows — revealed and previously earned) joined to `tokens` filtered by `active = true`, taking `id, name, icon_url`. An empty tray renders `No tokens yet — earn and reveal tokens on your profile first!` with a link back to the dashboard. Token art is loaded with `crossOrigin = 'anonymous'` and a plain-load fallback; the PNG export only works because of that. Milestone trophies are not part of the current tray.

The page also computes a "honey level" from `tasks` and `profiles`. That denominator sums `nectar_reward` across **all** task rows with no tier or eligibility filter, so a member whose tier cannot reach every theme can never fill it. A display quirk, not a functional one.

### 12.4 The live implementation — the inline script in `decorator.html` (Canvas 2D)

The shipped jar is the inline script inside `decorator.html` (about 80 KB of markup plus script). It is Canvas 2D: no physics engine, no bounce, no settle. In behaviour:

- **Login gate.** `init()` calls `supabase.auth.getUser()` and, with no session, performs a hard `window.location.replace('login.html')` — not a modal. A `#load-gate` spinner reading `GATHERING YOUR TOKENS…` covers the UI until the tray loads; a failed load hides the gate and shows `Failed to load tokens.`
- **Two placement modes.** `Auto-fit` (the default) snaps stickers into tidy wedges around the lid; `Free place` allows dragging with a rotate handle (`↻`) and a resize handle (`⇱`) per sticker, both kept at constant screen size regardless of zoom. Switching to Free place seeds every sticker from its wedge slot, so the artwork never teleports. The mode persists per user in `localStorage` (`jar_mode_<uid>`, or `jar_mode_anon` when signed out).
- **Transform model.** A placed sticker carries `fx, fy` (position normalised to the wood ellipse: 0 is the centre, ±1 the rim), `frot` (radians) and `fscale` (radius as a fraction of the face radius, bounded 0.10–1.05, default 0.46). Double-tap removes a sticker, and keyboard controls mirror the pointer ones.
- **A cap of three.** `MAX_STICKERS = 3`, surfaced as `LID STICKERS: n / 3`. A token already on the lid is greyed out in the tray and cannot be placed twice; Clear is inert unless the lid is closed.
- **Focus lid.** A 2.15× zoom about the face centre, because the lid is only about a fifth of the 900 × 1500 canvas and precision dragging at full-jar scale is guesswork. The button toggles between `Focus lid ⇤` and `Whole jar ↻`.
- **Reset layout.** Re-seeds every placed sticker into its wedge, clears rotation and the local rotation key. Tokens are kept; the hand-placing is dropped.
- **Save.** `#saveBtn` sends the whole arrangement to `save_jar_decorations` as `[{token_id, x_pos, y_pos, scale, rotation}]`, where `x_pos`/`y_pos` are `round((50 + f × 50) × 100) / 100`, `scale` is rounded to three decimals and `rotation` to four. Success shows `Lid saved to cloud!` and writes the local rotation mirror; failure shows `Save failed — please try again.` Because the RPC ignores unknown keys, sending `rotation` before the column existed was harmless — which is why the local mirror covered the gap.
- **Load with tolerance.** The select asks for `rotation` and, if that errors, retries without it, taking rotation from the local mirror. A layout is treated as legacy (and opened in the tidy wedge look) when every saved row is `y_pos = 20, scale = 1` — the signature of the retired physics code. `saneTransform()` rejects rows outside the ellipse (`hypot(fx, fy) > 1.15`) or outside the scale bounds.
- **Export.** `buildJarPng()` re-renders a clean frame, finds the jar's bounds by diffing pixels against the repainted background (quarter-scale diff, tolerance 16, falling back to the whole canvas if the box is degenerate), crops with roughly 14 logical pixels of breathing room, and caps the long edge at 1800 px (around a 1 MB PNG). `Save picture` downloads `my-honey-jar.png`; the `Share` button is revealed only after a `navigator.canShare({files: …})` probe on a dummy PNG, and hands the file to the OS share sheet through `navigator.share` (an `AbortError` is swallowed as a cancellation).
- **Storage safety.** Coordinates and scale are clamped in the client and again in the RPC.

### 12.5 Two implementations, only one of which is wired

- `public/js/decorator.js` (~18 KB) is a **Matter.js** version of the same idea: a hidden physics canvas with gravity 2.2, walls built from seven-segment arcs to approximate the jar's rounded corners, circles with `restitution` 0.5–0.65 and `frictionStatic` 0.3, `inertia: Infinity` so tokens never spin, sparkles and ripples on drop, and a save path that hardcodes `x_pos: 50, y_pos: 50, scale: 1`. **No page loads it.** It appears in no `import` or `<script>` outside its own header, and the two DOM nodes it requires — `#decoratorSheet` and `#jarContainer` — exist in no HTML file. It also has no export path.
- `matter-js@0.19.0` is nevertheless still fetched from a CDN on `profile.html`, next to an empty `<!-- Decorator Jar Bottom Sheet -->` placeholder. The library is downloaded and unused: dead weight, not dead functionality.
- `testjar.html` (~47 KB, 1,327 lines) is an older prototype with the same title and the same ids minus the newer mode and edit controls. It is bundled and routed (`/testjar.html`) but linked from nowhere — see section 22.
- `public/honey_jar.glb` and `public/tie.glb` exist with no reference from either implementation.

Maintenance rule: work in `decorator.html`. Editing `decorator.js` has no user-visible effect.

---

## 13. Collaboration and invitations

### 13.1 The model

Two members can link as **collaboration partners** and see each other's progress on the shared task catalogue. Partner state drives the `due` and `both` card states on the dashboard and the partner comparison widget.

### 13.2 Tables

`collaboration_invites`:

| Column | Meaning |
|---|---|
| `id` | Row id |
| `inviter_id` | The member sending the invitation |
| `invite_code` | The code that carries the invitation |
| `invitee_id` | Filled when a specific member is targeted |
| `invitee_email` | Filled when the invitation is addressed to an email |
| `status` | `pending` until resolved |
| `created_at`, `expires_at` | Lifetime of the invitation |

`collaborations`:

| Column | Meaning |
|---|---|
| `id` | Row id |
| `user_a_id`, `user_b_id` | The linked pair |
| `created_at` | When the link formed |

### 13.3 Functions

- `create_collab_invite()` — creates a general invite with a code, owned by the caller.
- `create_directed_collab_invite(p_email)` — creates an invitation addressed to an email address. Uses `lookup_member_for_invite(p_email)` to resolve the address to a member.
- `accept_collab_invite(p_code)` — the invitee redeems a code; this writes the `collaborations` pair and closes the invite.
- `get_collab_partners()` — the caller's current partners.
- `get_partner_progress(p_partner_id)` — the partner's task progress, for the comparison view.
- `get_partner_profiles(p_ids uuid[])` — batch profile fetch for partner display.
- Admin: `admin_get_collab_invites()`, `admin_get_collaborations()`, `admin_delete_collab_invite(p_invite_id)`, `admin_delete_collaboration(p_collab_id)`.

### 13.4 The tier gate

Inviting and participating as a partner is available **only on the Collective tier**. A member below it does not see the invite controls as usable; the interface shows an upgrade prompt stating that collaboration requires the Collective tier. This gate is applied in the collaboration module (`public/js/collaboration.js`) against `profiles.member_tier`, and it is the single most visible consequence of the tier system in the daily dashboard.

### 13.5 Row-level security on the collaboration tables (verbatim)

```
collaboration_invites INSERT collab_invites_insert  {authenticated}  WITH CHECK (auth.uid() = inviter_id)
collaboration_invites SELECT collab_invites_select  {authenticated}  USING ((auth.uid() = inviter_id) OR (status = 'pending'))
collaboration_invites UPDATE collab_invites_update  {authenticated}  USING ((auth.uid() = inviter_id) OR (status = 'pending'))
collaborations        INSERT collab_insert          {authenticated}  WITH CHECK ((auth.uid() = user_a_id) OR (auth.uid() = user_b_id))
collaborations        SELECT collab_select          {authenticated}  USING ((auth.uid() = user_a_id) OR (auth.uid() = user_b_id))
```

The `status = 'pending'` clause in the invites SELECT/UPDATE policies is what lets an invitee read an invitation addressed to them before they are a party to it.

---

## 14. The social layer and privacy

### 14.1 Visibility switch

`profiles.is_public` (boolean) and `profiles.alias` (text) are the privacy controls. At verification, 1 of 20 profiles was public.

- `set_profile_visibility(p_public boolean, p_alias text)` — the member's own switch. `SECURITY DEFINER`.
- `profile_display_name(p_is_public, p_first, p_last, p_alias)` — returns the name to show: the alias when the profile is public, the real name otherwise. Centralising this in one function prevents a display path from leaking a real name for a private profile.
- `ensure_profile_alias()` — keeps an alias present (there is also a `trg_ensure_profile_alias` trigger on `profiles` for INSERT and UPDATE).
- `search_public_profiles(p_query text, p_limit integer)` — search restricted to public profiles.
- `get_public_profile(p_id uuid)` — the public view of one member, alias-based.

### 14.2 Leaderboard and cross-member reads

Cross-member data is never fetched by direct table read. The dashboard reads other members only through `SECURITY DEFINER` functions — `get_leaderboard`, `search_public_profiles`, `get_public_profile`, `get_partner_progress`, `get_partner_profiles` — which return only the fields the view needs and respect `is_public`/alias. Direct `profiles` reads are limited by RLS to the caller's own row (section 17), which is exactly why those functions exist.

### 14.3 Who can see what

| Viewer | Sees |
|---|---|
| Anyone | The public pages (home, meadow, about, FAQ, contact, founders, join, board, information and links) |
| Signed-in member, own profile | Everything on their own record |
| Signed-in member, another non-public member | Only what the SECURITY DEFINER RPCs expose (leaderboard entry, alias if public, partner progress if partnered) |
| Signed-in member, another public member | Alias, public profile view, search visibility |
| Partner (Collective tier) | Partner progress and comparison |
| Admin | The admin RPC surface (`admin_*`, section 16) |

---

## 15. The Communication Board

### 15.1 What it is

The board (`board.html`) is the hive's shared, **public** noticeboard: it is reachable by non-members as well as members. Posts are announcements from the hive, each with an optional icon and an author stamp.

### 15.2 Data model

`communications`:

| Column | Meaning |
|---|---|
| `id` | Row id |
| `user_id` | Owning member context |
| `author_id`, `author_name`, `author_email` | Who posted |
| `post_type` | The label shown as the post's category |
| `icon` | Font Awesome icon name (for example `shield-halved`, `cloud-arrow-up`, `bell`) |
| `title`, `content` | The post body |
| `message` | The legacy body column |
| `created_at` | When posted |

Observed `post_type` values in the live data include `Announcement`, `Security`, `SECURITY`, `Update.` and `TEST` — the mixture is real and is itself a small data-hygiene issue (section 21).

### 15.3 Who may write

The only INSERT policy on `communications` is:

```
communications INSERT communications_admin_write {authenticated} WITH CHECK (storage_admin())
communications SELECT communications_read        {anon,authenticated} USING (true)
```

So reading is open to anonymous visitors — which is what makes the board genuinely public — and writing is restricted to the storage/admin privilege (`storage_admin()`, section 16). There is no client-side path for an ordinary member to post to the board.

### 15.4 Client behaviour

`board.html` plus `js/comms.js`, public, with no sign-in gate (the markup comments state that the board is public and that writes are admin-only, enforced by the RLS policy above):

- Posts are fetched with `select('*')` ordered `created_at desc`. Each card shows the `post_type` as a category chip, a locale date, and the body truncated to 150 characters behind a `Read More →` affordance.
- **The filter pills only cover the last 24 hours.** A `post_type` earns a pill only if at least one post of that type was created within 24 h; the first pill is always `All Posts`. Older types simply lose their pill while their posts stay listed.
- The full post opens in a bottom sheet (`#postBottomSheet`) titled `title || post_type`, with `message` as the body and `Meadow Team` as the footer.
- **Icons** come from `post.icon` when set, otherwise from a keyword map on `post_type`: `announce → bullhorn`, `update → sync-alt`, `community → users`, `security → shield-halved`, default `bell`.
- The Recent Activity card lists the latest three posts with `timeAgo` labels (seconds / minutes / hours / days).
- Live updates arrive through a Supabase Realtime channel on `public.communications` (`comm-board-changes`), which re-renders pills, posts, recent activity and the badge holder. The initial load shows `Fetching meadow updates...`.

### 15.5 The `content` / `message` mismatch (verified against live data)

The table carries **both** body columns, and the two sides of the product use different ones:

- Every read path — board cards, the bottom sheet, the recent list — renders `message`.
- The admin publish path (`js/admin-crm.js`, Communications layer) inserts `title`, `content`, `author_id` and `created_at`, and **no `message`**.

Live data confirms the split: recent rows carry a `message` with `content` NULL. A broadcast published from the admin console therefore renders as an empty card body on the board. The fix is one line on either side (write `message`, or read `COALESCE(message, content)`); until then, populate both fields when publishing.

### 15.6 The messenger layer is dormant

The floating buzz widget described in older notes is not connected in the current build:

- `js/notification.js` — the module that polls `communications` every 10 seconds over a 24-hour window (`checkLiveBuzz`, `renderMessengerBadge`, appending `#messenger-buzz` to the body) — **is loaded by no page**. Repo-wide it is referenced only in a comment in the React legacy loader and in a build manifest entry.
- `updateMessengerBadge()` in `js/comms.js` targets `#messengerBadge` and `.messenger-circle`; neither element exists in any HTML file, so the call is a no-op.
- The deep link it generates (`board.html?postId=…`) is never parsed: no `URLSearchParams` handling exists in `comms.js` or `board.html`.
- The home-page buzz targets (`#buzzPreviewBody`, `#homeBuzzContainer`, `#homeNotifSection`) exist in no HTML file, and the router redirects `/` and `/index.html` to `/the-meadow.html`, so the guarded home-feed code cannot run either.

Net effect: the board itself is the notification surface. Anything describing a private messenger or an unread badge describes intent, not shipped behaviour. Reviving it means adding the script tag (and the badge markup) to the page that should host it.

---

## 16. Admin and the privilege model

### 16.1 The privilege chain

Three functions define privilege, all `SECURITY DEFINER`:

- `is_admin(p_user_id)` — is this user an admin? Backed by the `admin_users` table (one row: `anhishgautam@gmail.com`).
- `admin_ok()` — the caller-based form used inside admin RPCs.
- `storage_admin()` — the privilege token used by table policies such as `communications` INSERT and `contact_inquiries` write access.

`add_admin(p_email)` and `remove_admin(p_email)` maintain the admin list; `admin_get_admins()` lists it.

### 16.2 The admin RPC surface

The database exposes the following admin surface — **41 `admin_*` functions in the live project, plus four helper functions in the privilege chain**, all verified against the database. The sanctioned design is that admin pages call these and nothing else; whether the shipped pages honour that is a different question, answered in section 16.3.

**Reads**

```
admin_get_admins()            admin_get_collab_invites()   admin_get_collaborations()
admin_get_config()            admin_get_inquiries()        admin_get_milestones()
admin_get_sigma_logs()        admin_get_stats()            admin_get_tasks()
admin_get_themes()            admin_get_tokens()           admin_get_user(p_user_id)
admin_get_users()             get_admin_stats()
admin_list_jar_decorations()  admin_list_theme_progress()  admin_list_user_milestones()
admin_list_user_tasks()       admin_list_user_tokens()
```

**Writes**

```
admin_save_config(p_key, p_value, p_description)     admin_delete_config(p_key)
admin_save_milestone(p_data jsonb)                   admin_delete_milestone(p_milestone_id)
admin_save_task(p_data jsonb)                        admin_delete_task(p_task_id)
admin_save_theme(p_data jsonb)                       admin_delete_theme(p_theme_id)
admin_save_token(p_data jsonb)                       admin_delete_token(p_token_id)
admin_update_user(p_user_id, p_data jsonb)           admin_delete_user(p_user_id)
admin_set_points(p_user_id, p_nectar, p_co2e)
admin_update_inquiry(p_inquiry_id, p_status, p_notes)  admin_delete_inquiry(p_inquiry_id)
admin_delete_theme_progress(p_user_id, p_theme_id, p_stage)
admin_delete_user_milestone(p_user_id, p_milestone_id)
admin_delete_user_task(p_user_id, p_task_id)
admin_delete_user_token(p_user_id, p_token_id)
admin_delete_sigma(p_sigma_id)
admin_delete_collab_invite(p_invite_id)
admin_delete_collaboration(p_collab_id)
```

Note the design pattern: the `admin_save_*` functions take a single `jsonb` document, so a whole record can be upserted without the client needing to know the column list.

**Member-data operations**

```
reset_user_progress_by_id(uid uuid)     unlock_all_tasks_for_user(p_user_id)
reset_experienced_progress(p_user_id)   award_milestone(p_user_id, p_milestone_id)
```

### 16.3 What the admin pages actually do (verified against the shipped scripts)

The back-office in this build is four pages: `admin-crm.html` (CRM/overview + communications + inquiries), `admin-achievements.html`, and the two legacy orphans `admin_comms.html` and `admin_inbox.html`.

The first and most important fact contradicts the natural reading of section 16.2: **no admin page calls a single `admin_*` function.** A repo-wide scan of every script in `public/js/` finds zero call sites for the `admin_get_*`, `admin_save_*`, `admin_delete_*`, `admin_list_*`, `admin_update_*` and `admin_set_*` families. The whole privileged surface listed in section 16.2 exists in the database and is unused by the front end.

What the shipped pages call instead:

| Page | RPCs actually called | Direct table access |
|---|---|---|
| `js/admin-crm.js` | `is_admin` (the entry gate), `get_admin_stats`, `add_admin`, `remove_admin`, `downgrade_expired_subscriptions`, `check_upcoming_renewals` | `profiles` (x5), `tasks` (x5), `contact_inquiries` (x3), `communications` (x2), `user_tokens`, `user_tasks`, `user_milestones`, `tokens`, `milestones`, `admin_users` |
| `js/admin-achievements.js` | none — its only check is `supabase.auth.getUser()` | `milestones`, `tokens` |
| `src/legacy/admin_comms.html` | none | `localStorage` only (key `admin_comms`) |
| `src/legacy/admin_inbox.html` | none | `localStorage` only (key `hive_inquiries`) |
| `js/config.js` | `get_all_config` (called twice) | — |

Consequences that follow directly from that table:

- **Everything not listed in the RPC column runs under the caller's own RLS.** Reading `profiles`, `user_tasks`, `user_milestones` et al. from `admin-crm.js` returns only rows the policy permits — for a plain member that is their own row, silently. The admin pages look "empty" rather than erroring.
- **The admin entry gate is sound where it is used**: `admin-crm.js` calls `supabase.rpc('is_admin', { p_user_id: user.id })` at load and only then renders. `admin-achievements.js` does **not** — any signed-in user reaches that page's DOM; only RLS stands behind it.
- **The two orphan pages are localStorage-only.** `admin_comms.html` writes `admin_comms`, `admin_inbox.html` writes `hive_inquiries`, and nothing else in the repository reads either key, so neither page touches Supabase. They also contain a hardcoded project URL and an inline anonymous key.
- **Config loading is broken by a missing function.** `js/config.js` (`getConfig` / `getAllConfig`) calls `supabase.rpc('get_all_config')`, which does not exist in the live project (the config reader is `admin_get_config`). The call 404s, the console logs `Failed to load config: …`, the cache becomes `{}` and every `getConfig(key)` returns `null`. The consumers that matter (`admin-crm.js` reading `notification_email` / `site_url` / `notify_broadcast`) all have hardcoded fallbacks, so the visible effect is a console warning plus fallback values rather than a crash. Either create `get_all_config` or point the client at `admin_get_config`.

The DB surface itself is real and complete — 41 `admin_*` functions exist and are `SECURITY DEFINER` + admin-gated. Rewiring the pages onto them is the single highest-value piece of pending work on the back-office.

### 16.4 The rule this embodies

Admin pages must use RPCs, never direct table reads. Row-level security restricts `profiles`, `user_tasks`, `user_tokens` and friends to the caller's own row (`auth.uid() = user_id`), so a direct `select * from profiles` from an admin page returns **only the admin's own profile** — silently, with no error. The `admin_*` functions are `SECURITY DEFINER` and check `admin_ok()`, which is what makes the back-office able to see the whole hive.

Current reality check (verified against the shipped scripts, see section 16.3): the back-office does
the opposite of what this section prescribes. `admin-crm.js` reads `profiles`, `tasks`,
`contact_inquiries`, `communications`, `user_tokens`, `user_tasks`, `user_milestones`, `tokens`,
`milestones` and `admin_users` with direct `.from()` calls, and `admin-achievements.js` reads
`milestones` and `tokens` directly; none of the `admin_*` RPCs is called anywhere. Those reads are
not privileged — they return whatever the caller's policies allow, which for a normal member is
their own row, so an admin page that should show the whole hive can quietly show one row instead.
The only privileged calls in the shipped front end are the six in the table above (`is_admin`,
`get_admin_stats`, `add_admin`, `remove_admin`, `downgrade_expired_subscriptions`,
`check_upcoming_renewals`). When an admin page shows too little data, the cause is a direct
`.from()` read that should have been an `admin_get_*` / `admin_list_*` call.

---

## 17. Database security model

- **42 tables** in the `public` schema. **37** have row-level security enabled. **70** policies in total.
- Ownership-scoped tables use `auth.uid()` in both `USING` and `WITH CHECK`:
  - `profiles` — SELECT/UPDATE own row only (`auth.uid() = id`); INSERT with `auth.uid() = id`.
  - `user_tasks` — SELECT/INSERT/UPDATE/DELETE restricted to `auth.uid() = user_id`.
  - `user_theme_progress` — all commands restricted to `auth.uid() = user_id`.
  - `user_tokens` — SELECT/UPDATE own rows; a `service_role` policy exists for server-side awarding.
  - `user_milestones` — SELECT/UPDATE/INSERT own rows.
  - `user_jar_decorations` — SELECT/INSERT/DELETE own rows.
  - `subscriptions` — SELECT own row only.
- Reference tables are readable by signed-in members: `tasks` (public SELECT plus an authenticated SELECT), `milestones` (authenticated), `themes` (authenticated), `tokens` (authenticated). Note that `themes` and `tokens` are **not** anon-readable, so theme chips and token art resolve only inside an authenticated session.
- Admin-write tables use `storage_admin()`: `communications` INSERT, `contact_inquiries` SELECT/UPDATE/DELETE.
- `contact_inquiries` INSERT is open to anon and authenticated (`WITH CHECK (true)`), which is what allows the public contact form to work without an account.
- **Stored functions**: 91 signatures, of which the `admin_*` family, `is_admin`, `admin_ok`, `storage_admin`, `complete_task`, `award_theme_tokens`, `check_and_award_milestones`, `reveal_token`, `save_jar_decorations`, `get_leaderboard`, `search_public_profiles`, `get_public_profile`, `set_profile_visibility` and the subscription handlers are `SECURITY DEFINER` with `SET search_path TO 'public'`. Functions that are deliberately **not** definer-privileged include the two `calculate_points` overloads, `get_user_tasks`, `get_user_tasks_v2`, `update_user_levels`, `submit_badge_stage`, `approve_badge_stage`, `award_stage_bonus`, `check_badge_stage_auto_approval`, `check_and_award_theme_tokens`, `mark_milestone_viewed` (integer overload), `profile_display_name`, `extract_numeric` and `reset_experienced_progress`.
- `complete_task`, `award_theme_tokens` and `save_jar_decorations` additionally enforce `p_user_id IS DISTINCT FROM auth.uid()` inside the body and return a structured `{success:false, error:'Unauthorized'}` rather than raising — a deliberate choice that keeps the client's error handling uniform.
- Secrets: the anon key in the front-end is public by design. No `service_role` key, no database connection string and no Stripe secret key exists in the repository.

---

## 18. Complete function inventory (91 signatures)

Grouped by purpose. Overloads are shown with their argument types.

**Task engine and scoring**
`get_user_tasks(p_user_id uuid)`, `get_user_tasks_v2(p_user_id uuid)`, `get_my_task_progress()`, `complete_task(p_user_id uuid, p_task_id uuid, p_version text)`, `calculate_points(impact_value numeric, task_stage text, user_level text, engagement_level text)`, `calculate_points(impact_text text, task_stage text, user_level text, engagement_level text)`, `extract_numeric(text_value text)`, `update_user_levels(p_user_id uuid)`, `increment_theme_stage_progress(p_user_id uuid, p_theme_id text, p_stage text)`, `increment_theme_stage_progress(p_user_id uuid, p_theme_id text, p_stage text, p_increment integer)`, `unlock_all_tasks_for_user(p_user_id uuid)`, `reset_user_progress_by_id(uid uuid)`, `reset_experienced_progress(p_user_id uuid)`.

**Tokens and milestones**
`award_theme_tokens(p_user_id uuid)`, `check_and_award_theme_tokens(p_user_id uuid, p_theme_id text)`, `reveal_token(p_user_id uuid, p_token_id uuid)`, `get_user_revealed_tokens(p_user_id uuid)`, `mark_token_viewed(p_user_id uuid, p_token_id uuid)`, `check_and_award_milestones(p_user_id uuid)`, `award_milestone(p_user_id uuid, p_milestone_id integer)`, `mark_milestone_viewed(p_user_id uuid, p_milestone_id integer)`, `mark_milestone_viewed(p_user_id uuid, p_milestone_id bigint)`.

**Badges**
`submit_badge_stage(p_user_id uuid, p_badge_id uuid, p_stage_order integer, p_evidence text, p_metrics jsonb)`, `check_badge_stage_auto_approval(p_user_id uuid, p_badge_id uuid, p_stage_order integer)`, `approve_badge_stage(p_submission_id uuid)`, `award_stage_bonus(p_user_id uuid, p_badge_id uuid, p_stage_order integer)`.

**The jar**
`save_jar_decorations(p_user_id uuid, p_decorations jsonb)`.

**Profile, identity and privacy**
`handle_new_user()`, `ensure_profile_alias()`, `profile_display_name(p_is_public boolean, p_first text, p_last text, p_alias text)`, `set_profile_visibility(p_public boolean, p_alias text)`, `get_public_profile(p_id uuid)`, `search_public_profiles(p_query text, p_limit integer)`, `get_leaderboard(p_limit integer)`.

**Collaboration**
`create_collab_invite()`, `create_directed_collab_invite(p_email text)`, `lookup_member_for_invite(p_email text)`, `accept_collab_invite(p_code text)`, `get_collab_partners()`, `get_partner_progress(p_partner_id uuid)`, `get_partner_profiles(p_ids uuid[])`.

**Billing**
`handle_subscription_event(p_event_type text, p_stripe_sub_id text, p_customer_id text, p_period_end bigint, p_product_id text)`, `downgrade_expired_subscriptions()`, `check_upcoming_renewals(p_days_ahead integer)`.

**Reporting**
`get_site_stats()`, `get_admin_stats()`.

**Privilege**
`is_admin(p_user_id uuid)`, `admin_ok()`, `storage_admin()`, `add_admin(p_email text)`, `remove_admin(p_email text)`.

**Administration (`admin_*`)** — the reads, writes and member-data operations listed in section 16.2: `admin_get_admins`, `admin_get_collab_invites`, `admin_get_collaborations`, `admin_get_config`, `admin_get_inquiries`, `admin_get_milestones`, `admin_get_sigma_logs`, `admin_get_stats`, `admin_get_tasks`, `admin_get_themes`, `admin_get_tokens`, `admin_get_user`, `admin_get_users`, `admin_list_jar_decorations`, `admin_list_theme_progress`, `admin_list_user_milestones`, `admin_list_user_tasks`, `admin_list_user_tokens`, `admin_save_config`, `admin_save_milestone`, `admin_save_task`, `admin_save_theme`, `admin_save_token`, `admin_set_points`, `admin_update_inquiry`, `admin_update_user`, `admin_delete_collab_invite`, `admin_delete_collaboration`, `admin_delete_config`, `admin_delete_inquiry`, `admin_delete_milestone`, `admin_delete_sigma`, `admin_delete_task`, `admin_delete_theme`, `admin_delete_theme_progress`, `admin_delete_token`, `admin_delete_user`, `admin_delete_user_milestone`, `admin_delete_user_task`, `admin_delete_user_token`.

---

## 19. Integrations

### 19.1 Supabase Storage

Public-read buckets (paths as stored on the referenced rows):

| Bucket | Layout | Used by |
|---|---|---|
| `Token` | `Token/<Theme Name>/<Stage>/<Token>.svg` — stage folders `Seed`, `Sprout`, `Bloom` | Token art (`tokens.icon_url`) |
| `Badges` | `Badges/<Track>/<Name>.png` — tracks such as `Membership Longevity`, `Nectar Progession`, `Collective Contribution`, `Growth Journey`, `Reflection & Control` | Milestone trophies (`milestones.icon_url`) |
| Theme imagery | referenced by `themes.visual_symbol_icon_idea` | Theme headers |

Token SVG paths also exist locally under `assets/tokens/<Theme-Folder>/…` (for example `assets/tokens/Connecting-Belonging/TE-001_RootsSeed.svg`), used by the jar and the milestone awards.

### 19.2 Email

Transactional email goes through Brevo SMTP configured on the Supabase project; `app_config` holds the notification address and the site URL. Password reset is handled by the deployed edge functions `send-reset-email` and `send-reset-v3`. `send-email` is not deployed — and the client helper `js/config.js#sendEmail()` posts to exactly that missing function (`${SUPABASE_URL}/functions/v1/send-email`), so every in-app send (contact form, broadcast, welcome mail) fails soft with a console warning.

The config reader is likewise mismatched: `js/config.js` calls `supabase.rpc('get_all_config')`, which does not exist in the live project — the real reader is `admin_get_config()`. Each call logs `Failed to load config: …` and returns `null` for every key; the callers with hardcoded fallbacks mask it.

### 19.3 Stripe

Three deployed edge functions: `stripe-checkout` (creates a Checkout Session for a price), `stripe-webhook` (calls `handle_subscription_event`), `cancel-subscription` (sets `cancel_at_period_end`). `check-renewals` — the scheduled sweep that would call `check_upcoming_renewals` — is not deployed.

---

## 20. Configuration reference

`app_config` (3 rows):

| key | value |
|---|---|
| `notification_email` | `follydevs@gmail.com` |
| `notify_broadcast` | `true` |
| `site_url` | `https://www.hivenectar.earth` |

`navigation_menu` (5 rows, ordered by `order_index`) — the TRail sidebar/library sections:

| order_index | label | icon | path |
|---|---|---|---|
| 1 | Policy Briefs | `file-alt` | `briefs` |
| 2 | Gardening Tips | `leaf` | `gardening` |
| 3 | Planners & Tools | `shopping-cart` | `shop` |
| 4 | Video Library | `video` | `videos` |
| 5 | TEST | `person` | `test` |

The fifth row is a test artefact (section 21).

---

## 21. Design and display rules that affect behaviour

Two standing rules are important enough to record in a system guide, because violating them changes what members see:

1. **No emoji in the interface as decoration.** The house style is Font Awesome icons (`fas fa-*`, 326 usages) or plain wording. The application carries a runtime display filter (`public/js/emoji.js`) that strips pictographs from rendered text, so stored values containing emoji — and many do, because the stage literals themselves contain them — display cleanly without the database being rewritten. This is deliberate: the emoji stage literals are canonical keys that the scoring and gating code compares byte-for-byte, so the database keeps its bytes and the display layer cleans them.

2. **Typography is not emoji.** Arrows (`↻`, `⤡`), en and em dashes are legitimate typography and are kept. Only pictographs are filtered.

The practical consequence for anyone editing content: the stored value and the displayed value differ. Edit the stored value; never "fix" it to match what a member sees on screen.

---

## 22. Known gaps, inconsistencies and current risks

Recorded because a guide that claims completeness should also say where the system is not finished. Each item was verified against live data or code.

**Content and data**

1. **Theme T03 (Innovating) has no authored tasks.** Its 30 rows carry placeholder titles (`Innovating Task 1` … `Innovating Task 10`, each three times) and their `core_theme` is set to `🌱 Connecting / Belonging` — the T01 label — rather than an Innovating label. T03 also has fewer tokens (12) than the other themes.
2. **The Harvest stage is empty.** `get_user_tasks_v2` grants tier 3 the Harvest stage, but no task has `stage = '🌾 Harvest'`.
3. **`core_theme` is a label, not a key.** T03's rows demonstrate the hazard. Any logic that groups by `core_theme` instead of `theme_id` will misreport T03.
4. **Milestone row 18 (`Worker 25`)** holds placeholder values (`reward_value = 'points'`, `description = 'points'`).
5. **Milestone row 33 (`Echo Still`)** names reward `TE-013` (which is the Shift/Innovating theme token) while its icon path is `TE-014_EchoStill.svg` and its own JSON describes `TE-014`. The reward code and the artwork disagree.
6. **`post_type` values on the board are inconsistent** (`Security` and `SECURITY`, `Update.` with the trailing period, `Announcement` with no icon, and a `TEST` post in production).
7. **`navigation_menu` contains a `TEST` entry** (path `test`).
8. **Public leftovers at the repository root** — `tasks_master.json`, `users.json`, `admin_comms.json`, a stub `app.js`, and a `testjar.html` duplicate — are served publicly although they are not part of the product. *(React port, 13 October 2026: the three JSON files were removed from `public/`, so the next deploy of this tree does not serve them — see section 23.8. In the older deployed tree they remain until that deploy is replaced. `testjar.html` was kept: the name is misleading, it is the Honey Jar lid decorator, a real member page.)*

**Behaviour and wiring**

9. **The database's sequential unlock is inert.** `get_user_tasks_v2` computes `is_unlocked` from `user_theme_progress.unlocked_task_index`, and no stored function writes that column; only the client's progress controls do. The unlock rule members actually experience is the client-side sequential-plus-24-hour rule in section 7.3.
10. **`calculate_points` is not on the earning path.** The multiplier model (impact × stage × level × engagement) is implemented but not called by `complete_task`, which pays a flat `nectar_reward`. Likewise `update_user_levels` is not called by `complete_task`, so the level and engagement values returned by a completion are the pre-completion values; the client recomputes them for display.
11. **The maturity guardrails are not enforced.** `theme_guardrails` holds min_days, min_task_types, min_spread_days and min_nectar for Sprout and Bloom, and `user_theme_progress` maintains day counters, but no function evaluates the guardrails to block or unlock anything.
12. **Milestones of category `theme_token` are never awarded** by `check_and_award_milestones`, which evaluates only `nectar`, `tasks`, `membership`, `sigma` and `referrals`. The 15 `TE-` milestone definitions are therefore decorative unless awarded manually or via `award_theme_tokens`.
13. **`award_theme_tokens` ignores `active`.** It awards every token row whose threshold is met, which is why a member receives four art tokens at once on reaching 5 completions in a theme+stage, and why the 10 inactive `TE-` rows are still awardable.
14. **`themes` and `tokens` are not anon-readable** (their SELECT policies require the `authenticated` role), so theme chips and token art only resolve inside a signed-in session.
15. **`user_milestones` has no DELETE policy**, so a member cannot remove a milestone row even where the interface implies it; an administrator or a SQL statement is required.
16. **Two edge functions are missing** — `check-renewals` and `send-email` return 404 — so renewal reminders and the generic mailer are not running.
17. **`subscriptions.current_period_end` is populated by the webhook**, not backfilled, and `profiles.subscription_current_period_end` remains NULL for existing members until a webhook fires.
18. **Duplicate SELECT policies** exist on several tables (for example `profiles` has two "view own profile" policies and `tasks` has both a public and an authenticated SELECT). Harmless for correctness; confusing when auditing.

**Verified in the deep code review (dashboard, jar, board, admin pages)**

19. **`public/js/decorator.js` is dead code.** The Matter.js jar implementation is loaded by no page and requires `#decoratorSheet` and `#jarContainer`, which exist in no HTML file; `matter-js@0.19.0` is still fetched from a CDN on `profile.html` beside an empty placeholder comment. The live jar is the inline Canvas-2D script in `decorator.html` (sections 12.4–12.5).
20. **The messenger is dormant.** `js/notification.js` is loaded by no page; `#messenger-buzz`, `#messengerBadge` and `.messenger-circle` exist nowhere; the `board.html?postId=` deep link it generates is never parsed; and the home buzz containers are absent while the router redirects `/` and `/index.html` to `the-meadow.html`, so the guarded home-feed code cannot run either (section 15.6).
21. **Admin broadcasts render blank on the board.** The admin publish path writes `title`, `content`, `author_id`, `created_at` and no `message`, while every read path renders `message`. Confirmed against live data: recent rows have `message` populated and `content` NULL, and the table carries both columns. One line on either side fixes it (section 15.5).
22. **The board's filter pills expire after 24 hours.** Only `post_type` values seen in the last day earn a pill; the posts themselves stay listed (section 15.4).
23. **`admin_comms.html` and `admin_inbox.html` are disconnected from Supabase.** They read and write the `localStorage` keys `admin_comms` and `hive_inquiries`, which nothing else in the repository reads, they hardcode the Supabase URL with an inline anon key, and they gate on "any logged-in user" rather than on admin. Treat them as legacy surfaces; the live paths are the Communications and Inquiries layers of the admin console.
24. **`CRM.html` is retired.** Its script (`js/admin.js`) is a 522-byte stub, so the page renders and does nothing; the working admin console in this tree is `admin-crm.html` with `js/admin-crm.js`.
25. **The dashboard never calls `get_user_tasks_v2`.** It queries `themes` and `tasks` directly, so the tier/stage/is-unlocked logic exists twice and can drift (section 7.2).
26. **`required_level` has no consumer.** The column is populated in even 50-task bands but appears in no dashboard client code and in no task-serving filter (section 7.1).
27. **One card, two meanings.** `profile.js` writes the member's `member_tier` number into the "Meadow rank / Among members" card (`#rankLevel` = `#N`), while `social.js` binds that same card to the leaderboard position. Both definitions are live and unreconciled.
28. **The dashboard references DOM that does not exist on its page** — `#viewProfileStatusBtn`, `#mobileStatsModal`, `#achievementsModal`, `#completedModal`, `#pendingSigmaModal`, `#sigmaModal`, `#taskSigmaModal`, `#noviceCompleteModal`, `#deadEndModal`, `#upgradePromptModal`, `#tierSimulator`, `#adminSimulator` — and `board.html` has no `#postModal`; `profile.html` also carries a stray `</div>`. Harmless today, but it makes refactoring guesswork.
29. **`task_order` is the only ordering column in use.** The in-theme index is computed from the sorted array, so there is no client-side `unlocked_task_index` at all (the DB column of that name is inert — item 9).
30. **Two moderation-adjacent scripts are unwired**: `setupAdminSimulator()` is defined and never called, and `shareVia()` / `hideInviteButton()` in `collaboration.js` exist with no call sites. Also, the five collaboration RPCs (`create_collab_invite`, `accept_collab_invite`, `get_collab_partners`, `get_partner_profiles`, `get_partner_progress`) have **no DDL in the repository** — their tables, joins and return shapes can only be inferred from call sites.
31. **No admin page calls the admin RPC layer.** All 41 `admin_*` functions exist and are privileged, and every one of them is called by nothing: a repo-wide scan of `public/js/` finds zero call sites for the `admin_get_*` / `admin_save_*` / `admin_delete_*` / `admin_list_*` / `admin_update_*` / `admin_set_*` families. The shipped front end uses six privileged RPCs in total — `is_admin`, `get_admin_stats`, `add_admin`, `remove_admin`, `downgrade_expired_subscriptions`, `check_upcoming_renewals` — and does everything else by reading and writing tables directly under the caller's own RLS. `admin-achievements.js` has no admin check at all (it only asks whether anyone is signed in), and `admin-crm.html`'s achievements tab references `switchAchTab`, `openMilestoneModal` and `openTokenModal`, which are defined nowhere in the repository — so that management UI is missing rather than broken (section 16.3).
32. **Two client helpers call functions that do not exist.** `js/config.js` calls `supabase.rpc('get_all_config')` (the real reader is `admin_get_config()`) and posts mail to the undeployed `send-email` edge function. Both fail soft: config reads return `null` with a console warning and every caller falls back to hardcoded values; every in-app email send (contact form, broadcast, welcome) silently does nothing (section 19.2).

---

*Continued in the second half of this document: the page-by-page reference for all 24 pages, the end-to-end member journeys, and the glossary.*
## Part 2 — Page-by-Page Reference

All 24 pages live in `src/legacy/` of the React application (`The Meadows react.`) and are
mounted verbatim at their original URLs. Each entry lists: file, page title, purpose, what the
page renders (grounded in its own headings and element ids), the scripts it loads, the data it
touches, and whether authentication is required.

### 2.1 Site shell and entry point

**`index.html`** — *The Meadow | Belonging*
- 1 KB redirect stub. No nav, no app scripts except the emoji net.
- Purpose: the GitHub-Pages/Vercel root. Anyone hitting the bare domain lands here and is
  redirected to `the-meadow.html`, which is the real landing page.
- Data: none. Auth: public.

**`the-meadow.html`** — *The Meadow | Belonging*
- The public landing page and the marketing front door.
- Heading structure (in document order): `h1 The Meadow`, then the sections
  `Explore The Hive`, `Quick Guide`, `More To Explore`, `Create Your Account`, `What Exists Here`,
  `Why This Exists`, `How This Is Different`, `Founder Snapshot`, `Credibility & Norm Shift`,
  `Design Values`, `PollenPop — First Product`, `PollenPop Member Benefits`.
- Key elements: `#hero-section`, `#hero-cta`, `#hiveGrid` (the card grid of destinations),
  `#accordionWrap` (the "Quick Guide" accordion), `#signupSheet` (a bottom sheet holding a second
  copy of the signup form: `#signupFirst`, `#signupLast`, `#signupUsername`, `#signupEmail`,
  `#signupPass`, `#signup-submit`), `#footer`.
- Scripts: `js/app.js` (theme + site stats), `js/emoji.js` (display net), plus one inline block.
  Font Awesome 6.5.1 from cdnjs, plus `style.css` and `meadow-theme.css`.
- Data: reads `theme_settings` through `js/app.js` (cached in `localStorage.meadow_theme_cache`,
  24 h TTL) and calls RPC `get_site_stats` to fill the home counters.
- Auth: public. Signing up from this page calls Supabase `auth.signUp` and then optionally the
  welcome-email path (`js/signup.js` / `js/email.js`).

**`login.html`** — *Login | The Meadow*
- Email + password sign-in. Form `#loginForm` with `#loginEmail`, `#loginPassword`,
  inline error box `#loginError`, submit `#login-submit`, links to `forgot-password.html` and
  `join.html`.
- Scripts: `js/app.js`, `js/emoji.js`. Auth handled by Supabase JS (auth token persisted in
  `localStorage` under the `sb-<ref>-auth-token` key).
- On success the user is sent to `profile.html`; the admin surfaces (`CRM.html`, `admin-crm.html`)
  re-check `is_admin` themselves.

**`join.html`** — *Join the Meadow | The Meadow*
- Account creation. `#signupForm` fields: `#signupFirst`, `#signupLast`, `#signupUsername`,
  `#signupEmail`, `#signupPass`, submit `#signup-submit`; `#formTitle` and `#login-card` allow the
  card to flip between signup and login.
- Scripts: `js/signup.js` (creates the account, then fires the welcome email helper), `js/app.js`,
  `js/emoji.js`.
- A database trigger (`handle_new_user`) creates the matching `profiles` row on signup; see Part 1
  for the profile defaults.

**`forgot-password.html`** — *Reset Password | The Meadow*
- Request a reset link. Form `#forgotPasswordForm` with `#resetEmail`, submit `#sendLinkBtn`,
  status area `#resetMessage`.
- Scripts: `js/forgot-password.js` — sends the reset email through the Supabase edge function
  `send-reset-email` (falls back to `send-reset-v3`), which uses Brevo SMTP server-side.

**`reset-password.html`** — *New Password | The Meadow*
- The landing page for the emailed recovery link. Form `#resetForm` with `#newPassword`,
  submit `#updateBtn`, status area `#resetStatus`, fields container `#resetFields`.
- The page waits for Supabase to consume the recovery token from the URL fragment and then calls
  `auth.updateUser({ password })`.

**`about.html`** — *About The Meadow | The Meadow*
- Static brand page. Sections: `Why This Exists`, `How This Is Different`, `Founder Snapshot`,
  `Design Values`, closing CTA `#about-cta` / `#join-cta`. 22 Font Awesome icons, no dynamic data.
- Scripts: `js/app.js`, `js/emoji.js`. Auth: public.

**`founders.html`** — *Founders | The Meadow*
- Renders the founder cards into `#foundersGrid`. The grid is built from a data array inside the
  page's inline script (the heading template is `h3 ${escapeHtml(founder.name)}`), so founder
  content is edited in the page, not the database.
- Scripts: `js/app.js`, `js/emoji.js`. Auth: public.

**`faq.html`** — *FAQ | The Meadow*
- Accordion FAQ grouped as: `Getting Started`, `Nectar & Points`, `Tasks & Levels`,
  `Account & Membership`, closing CTA `#faq-contact-cta`. Container `#faq-container`, repeated
  `#faq-item` blocks, 17 Font Awesome icons.
- Static content, one inline script for the open/close behaviour.

**`contact.html`** — *Contact Us | The Meadow*
- Contact form `#contactForm` with `#userName`, `#userEmail`, `#contactCategory` (the category
  select), `#userMessage`, submit `#contact-submit`; `#contact-info` side panel and a FAQ teaser
  linking on to `faq.html`.
- Scripts: `js/contact.js` writes a row into the `contact_inquiries` table, which is the queue the
  admin Inbox reads. Auth: public (no account needed to write an inquiry).

**`pollenpop.html`** — *PollenPop | The Meadow*
- Product-information page for the first physical product. Sections: `How it Works`,
  `What You Receive`, `Step-by-Step`, `Nectar → Bloom`, `Early Access`. Presentation only, 11
  Font Awesome icons.

**`information-and-links.html`** — *Information & External Links | The Meadow*
- A hub of policy/information links plus an embedded trial login. Contains an auth overlay
  `#loginOverlay` with `#trialLoginForm` (`#loginEmail`, `#loginPassword`), a `#dashboard`
  section and a `#dynamicSidebar` that is rendered at runtime from the `navigation_menu` table.
  Includes `tester.css` and `js/trial.js`.
- Data: `navigation_menu`, `policy_briefs`, `hub_content`, `social_links`, `profiles`
  (all via `js/trial.js`). Auth: the *links* are public; the embedded trial hub requires login.

**`trail.html`** — *Trial Hub | The Meadow*
- The same trial hub as above, standalone: `#authSection`, `#loginOverlay`, `#trialLoginForm`,
  `#dashboard`, `#dynamicSidebar`, `#exploreMainBtn`. Scripts `js/app.js`, `js/trial.js`.
- Purpose: a gated member area for trial/policy material — side navigation is built from
  `navigation_menu`, media cards from `hub_content`, briefs from `policy_briefs`.

**`preview.html`** — *My Achievements | The Meadow*
- A standalone achievements showcase: `h1 Nectar Artefacts`, sample stage cards
  (`Bloom Guardian`, `Harvest Mentor`, `Title`) and a detail modal `#achieveModal` with
  `#modalImg`, `#modalTitle`, `#modalSub`, `#modalDesc`.
- Loads Tailwind from the CDN, `meadow-theme.css` and `js/emoji.js`; content is rendered by an
  inline script from the token/milestone tables. It is a design/preview surface rather than a
  linked navigation destination.
### 2.2 Member area (authentication required)

**`profile.html`** — *My Profile | The Meadow* (31 KB markup + the 166 KB `js/profile.js`)
This is the product. Everything a member does day to day happens here.

Layout and elements
- Hero: `h1 Keep the meadow in bloom.` with `#profileAvatar`, `#heroName`,
  `#rankNameDisplayCompact`, `#rankLevel`, `#pointsVal` (nectar points), `#expText`,
  `#userTierBadgeCompact`, `#heroCta`.
- Top bar / avatar: `#topbarAvatar`, `#profileAvatarDropdown`, `#avatarDropdownMenu`,
  `#editProfileBtn`, `#logoutBtnHeader`, `#userNameDisplayShort`.
- Mobile action panel: `#mobileActionsPanel` with `#mobileMissionsBtn` (Daily Tasks),
  `#mobilePendingSigmaBadge`, `#mobileCompletedTasksBtn` + `#mobileCompletedBadge`,
  `#mobileAchievementsBtn`, `#mobileAddSigmaBtn`, `#mobileThemeSelectorBtn`, `#mobileUpgradeBtn`.
- Modals: `h2 Daily Tasks`, `h3 Cancel Subscription`, `h3 Edit Profile`, `h3 Upgrade Your Tier`.
- Share card canvas: `#shareCanvas`.
- Scripts: `js/app.js` (which imports the dashboard engine `js/profile.js`) plus the page's own
  modules `js/social.js`, `js/collaboration.js`, `js/share-card.js` and the `js/emoji.js` display
  filter; `js/theme-tokens.js` is pulled in by the engine. Stripe's SDK
  (`https://js.stripe.com/v3/`) is loaded for checkout. `matter-js@0.19.0` is also fetched from a
  CDN, next to an empty `<!-- Decorator Jar Bottom Sheet -->` comment — nothing on the page uses it
  (see 2.3). `js/notification.js` is **not** loaded here or on any other page (section 15.6 of the
  first half). 49 Font Awesome icons.

Daily task engine (the rules, from `js/profile.js`)
1. `fetchBaseTasksForTier()` loads the tasks the member is allowed to see. It first computes the
   allowed stage list for the member's tier and only keeps tasks whose stage passes
   `stagesForTier` + `stageKey` (stage names are normalised to lowercase key form before
   comparison). A broken gate here blanks the whole daily-task list, the filters and the counters
   at once.
2. Tasks are grouped per theme (`theme_id`) and sorted by `task_order`.
3. Unlock status is then computed **per theme, sequentially, with a 24-hour cooldown**, in code
   and not from the database:
   - The first task of a theme (`idx === 0`) is unlocked whenever it is not already completed.
   - Otherwise the immediately previous task in the same theme (by `task_order`) must be
     completed, or the card renders locked with
     `Complete "<previous task title>" to unlock`.
   - Once the previous task is completed, a **24-hour cooldown** starts:
     `hoursSincePrev = (now - prevCompletedAt) / 3600000`. While `hoursSincePrev < 24` the card
     stays locked with `"<previous task>" completed — <N>h until unlocked` (or the same message in
     minutes when under an hour), and carries an `unlock_at` timestamp
     (`prevCompletedAt + 24 h`) so the UI can count down live.
   - Exactly 24 h or more after the previous completion, the task unlocks (unless it is itself
     already completed).
   - Only the immediately previous task blocks; earlier tasks in the theme are not re-checked, so
     a member cannot be stalled by an old incomplete task once they have moved past its successor.
4. Completed tasks are removed from the active list (`allTasks`), but kept in
   `allTasksWithCompleted` so the "Completed" view and the counters stay correct.
5. Filters: `activeFilters.core_theme`, `activeFilters.stage`, `activeFilters.subcategory` —
   three independent multi-select filter groups. The option values are the raw database literals
   (e.g. `🌰 Seeds`), derived with `[...new Set(tasks.map(t => t.stage))]`.

Task card actions — `createTaskCard`, `handleDone`, `handleReact`, `handleComment`:
- **Done** calls RPC `complete_task(p_user_id, p_task_id, p_version)` — it writes `user_tasks`,
  adds the task's nectar reward to `profiles.nectar_points`, increments
  `profiles.total_tasks_completed` and then calls `award_theme_tokens`. It does **not** call
  `increment_theme_stage_progress`: that RPC is only reached from the admin/simulator code paths, so
  completing a task does not by itself advance the theme-stage day counters. The client then reads
  `result.points_earned`, `result.awarded_milestones` and `result.awarded_tokens`, reloads
  `user_theme_progress`, refreshes the list and calls `check_and_award_milestones`.
- **React** and **Comment** write to `task_feedback` and `task_comments`; reactions by other
  members are surfaced on the card.
- Sigma logs: `sigma_logs` / `task_sigma_logs` back the "add sigma" (extra/honourable action)
  flow behind `#mobileAddSigmaBtn` / `#mobilePendingSigmaBadge`.
- `getUnlockCondition`, `goToBlockerTask`, `showBottomSheet`, `closeAllBottomSheets` drive the
  locked-card explanation and the "go to the blocking task" shortcut.

Achievements on this page — `checkAndAwardMilestones`, `updateAchievementsBadge`,
`generateAchievementsHtml`, `attachAchievement3DEffects`, `openAchievementDetail`:
- Milestones are read from `user_milestones` + `milestones`; the award path calls RPC
  `check_and_award_milestones` and marks views with `mark_milestone_viewed`.
- Token artefacts are read from `user_tokens` + `tokens`, revealed with `reveal_token`, and the
  hidden/visible split uses `HIDDEN_LIMIT = 3` (`revealable`, `visibleTokens`, `tokenItems`).
- `THEME_ICON_FILES` and `TOKEN_THEME_NAMES` map theme ids (T01…T05) to icon files and human
  names; storage bucket `meadow-theme` holds theme artwork.

Other profile data touched by this page: `themes`, `tasks`, `user_theme_progress`, `user_tasks`,
`profiles`, `subscriptions`, `user_task_group_stats`, `theme_guardrails`.
Subscription actions (upgrade / cancel / billing portal) run through the deployed Stripe edge
functions `stripe-checkout` and `cancel-subscription`; the tier gate for collaboration lives in
`js/collaboration.js` (see 2.3).

**`board.html`** — *Communication Board | The Meadow* (6.5 KB markup + `js/comms.js`)
- Public and reachable by non-members, by design.
- `h1 Communication Board`, `#board-hero`, filter pills row `#filterPills`, the post list
  `#postsContainer` / `#posts-container`, `#recentActivityList`, and a bottom sheet for post
  detail: `#postBottomSheet` with `#postSheetTitle`, `#postSheetBody`, `#postSheetDate`.
- `js/comms.js` reads the `communications` table directly (no RPC): `fetchAllPosts`,
  `normalizeType`, `getIconForPost`, `renderFilterPills`, `renderPosts`, `openPostModal`,
  `updateRecentActivity`, `updateMessengerBadge`, `updateBuzzPreview`, `initCommunicationBoard`,
  `initHomeFeed`, `initHomeNotifications`. Post types are normalised so the pills and icons stay
  consistent; `timeAgo` renders relative timestamps.
- `js/notification.js` (`checkLiveBuzz`, `renderMessengerBadge`) is written to poll this table on a
  10-second cycle over a 24-hour window, but **no page loads the script** and its badge/popover DOM
  exists nowhere, so the messenger is dormant (section 15.6 of the first half). What members
  actually see on the board is its own 24-hour filter pills plus the Realtime channel.

**`collaborate.html`** — *Collaboration Invite | The Meadow* (4.3 KB)
- The landing page an invitee opens from an invite link. Elements: `#inviteStatus`,
  `#inviteMessage`, `#inviteActions`, `#acceptInviteBtn`.
- No app script: the acceptance logic is inline on the page; it reads the invite token from the
  URL, looks up the invite and calls the corresponding RPC path
  (`lookup_member_for_invite` / `accept_collab_invite`) to join the collaboration.
- States rendered: valid invite (accept button), invalid/expired invite, already accepted, and
  not-signed-in (prompts to log in first, then return).

### 2.3 The Honey Jar (token decorator)

**`decorator.html`** — *Honey Jar - Lid Decorator | The Meadow* (80 KB markup, self-contained)
- The full-size jar designer. Key ids: `#load-gate` (shown until the member's tokens load),
  `#jar-wrap`, `#jar-scene`, `#canvas` (the render surface), `#tray` / `#tray-tokens` (the
  sticker tray), `#token-count-bar` + `#token-count`, `#sticker-num`, `#clear-btn`,
  `#mode-bar` with `#mode-auto` / `#mode-free`, `#zoom-lid`, `#reset-layout`, `#hint`,
  `#edit-note`, `#jar-actions` with `#saveBtn`, `#png-btn`, `#share-btn`, `#clear-btn2`.
- Behaviour lives in the **inline script inside `decorator.html`**, not in `js/decorator.js`.
  `js/decorator.js` is a Matter.js physics variant that **no page loads** — it needs
  `#decoratorSheet` and `#jarContainer`, which exist in no HTML file — so it is dead code
  (sections 12.4–12.5 of the first half). The live implementation is Canvas 2D with no physics:
  `Auto-fit` wedges by default, `Free place` for dragging with a per-sticker rotate handle (`↻`)
  and resize handle (`⇱`), a 2.15x `Focus lid` zoom, `Reset layout`, a **cap of three stickers**
  (`LID STICKERS: n / 3`) and per-user mode persistence in `localStorage` (`jar_mode_<uid>`).
  Transform model: `fx, fy` (position normalised to the wood ellipse), `frot` (radians),
  `fscale` (radius as a fraction of the face radius, 0.10–1.05). Rotation has no column in the
  shipped schema, so it is mirrored per user in `localStorage` (`jar_rot_<uid>`) and upgraded
  automatically once the column exists. Double-tap removes a sticker.
- Auth: `init()` hard-redirects to `login.html` when there is no session, and `#load-gate` covers
  the UI until the tray has loaded.
- Tray: every token the member owns (`user_tokens` joined to `tokens` where `active = true`), with
  `No tokens yet — earn and reveal tokens on your profile first!` when empty; placed tokens are
  greyed out and cannot be placed twice.
- Persistence: RPC `save_jar_decorations` (SECURITY DEFINER, ownership-checked) performs a **full
  replace** — delete then insert — of the member's rows in `user_jar_decorations`. The load path
  tolerates a missing `rotation` column by retrying without it, and detects legacy physics-era
  layouts (`y_pos = 20, scale = 1`) so they open in the tidy wedge look.
- Export: `buildJarPng()` renders a clean frame, auto-finds the jar bounds by pixel diff, crops and
  caps the long edge at 1800 px. `Save picture` downloads `my-honey-jar.png`; `Share` appears only
  when `navigator.canShare({files})` accepts a PNG. Remote token art is loaded with `crossOrigin`,
  without which the canvas would be tainted and the export would fail.

**`testjar.html`** — *Honey Jar - Lid Decorator | The Meadow* (47 KB)
- An orphan duplicate of the decorator (same title, same ids without the newer mode/edit controls).
  It is not linked from navigation. Treat `decorator.html` as the live page and this file as a
  leftover prototype; the SQL/hardening work applies to the live one.
### 2.4 Administration surfaces (admin-only)

All admin pages are gated at runtime by RPC `is_admin` (and `admin_ok` inside the `admin_*` functions).
Access is mixed and this matters: the privileged operations (stats, admin grant/revoke, subscription
maintenance, task/theme/token/milestone writes) go through `admin_*` SECURITY DEFINER functions, but
the page scripts also read tables directly with `.from()` — `admin-crm.js` reads `profiles`,
`tasks`, `contact_inquiries`, `communications`, `user_tokens`, `user_tasks`, `user_milestones`,
`tokens`, `milestones`, `admin_users`, and `admin-achievements.js` reads `milestones` and `tokens`.
Those direct reads are subject to row-level security, so they only return what the caller's policies
allow (normally the caller's own rows); the reliable path for anything cross-member is the
`admin_get_*` / `admin_list_*` functions. Treat every direct `.from()` in an admin page as a
policy-dependent read, not as privileged access.

**`admin-crm.html`** — *Admin CRM | The Meadow* (15.8 KB + `js/admin-crm.js`, 26 KB) — the main console.
Layers, switched by `switchLayer`:
- `#layer-dashboard` — `#statsGrid` filled by `loadDashboard` (RPC `get_admin_stats`, plus
  `downgrade_expired_subscriptions` and `check_upcoming_renewals` as maintenance actions).
- `#layer-users` — `#userSearch`, `#usersBody`, `#userDetail`. `loadUsers` / `renderUsers` /
  `promptModal` implement search, the per-user detail panel, point adjustment and admin
  grant/revoke (`add_admin`, `remove_admin`).
- `#layer-tasks` — `#tasksBody` from `loadTasks` (task CRUD via `admin_get_tasks` /
  `admin_save_task` / `admin_delete_task`).
- `#layer-achievements` — tabs `#achievementTabMilestones` / `#achievementTabTokens` with panels
  `#achMilestonesPanel` (`#milestoneCount`, `#milestonesBody`) and `#achTokensPanel`
  (`#tokenCount`, `#tokensBody`); `loadAchievementsQuick` fills both.
- `#layer-comms` — broadcast composer `#commTitle`, `#commContent`, history `#commHistory`
  (`loadCommHistory`).
- `#layer-inquiries` — `#inquiryFilters`, `#inquiryList`, `loadInquiries` / `renderInquiries` +
  `admin_update_inquiry`.
- Subscription overview `loadActiveSubs` (`Active Subscribers` section) and admin management
  `loadAdmins` (`Admin Management`).
- Tables involved: `profiles`, `user_milestones`, `user_tokens`, `user_tasks`, `tasks`,
  `milestones`, `tokens`, `communications`, `contact_inquiries`, `admin_users`.

**`admin-achievements.html`** — *Admin Achievements | The Meadow* (3.9 KB)
- A focused view of the achievement catalogue: `h1 Achievements Manager`, sections `Milestones`
  (`#milestonesCount`, `#milestonesBody`) and `Theme Tokens` (`#tokensCount`, `#tokensBody`).
- `js/admin-achievements.js` uses `showToast`, `init`, `loadMilestones`, `loadTokens` and reads the
  `milestones` and `tokens` tables. This is the surface for checking/adding milestone definitions
  and token definitions.

**`admin_comms.html`** — *Admin - Create Buzz* (4.8 KB)
- Minimal broadcast form: `h2 Post New Communication`, fields `#title`, `#desc`, with three inline
  script blocks — plus a `Clear All Posts` button that is itself only a `localStorage.removeItem`
  call. It does **not** write to Supabase: it saves into the `localStorage` key `admin_comms`,
  which nothing else in the repository reads, it hardcodes the Supabase URL with an inline anon
  key, and it gates only on "any logged-in user". Nothing it creates is displayed anywhere. Treat
  it as a disconnected legacy surface; the live publish path is the Communications layer of the
  admin console.

**`admin_inbox.html`** — *Admin Inbox | The Meadow* (3.9 KB)
- The contact-inquiry inbox: `h1 Inquiry Inbox`, container `#inboxContainer`, cards built from
  `h3 From: ${escapeHtml(iq.name)}`. It reads the `localStorage` key `hive_inquiries`, **not** the
  `contact_inquiries` table that the admin console reads; it also hardcodes the Supabase URL and an
  anon key inline and gates only on being signed in. A disconnected legacy surface — the live
  inquiry path is the Inquiries layer of `admin-crm.html`.

**`CRM.html`** — *Admin CRM | The Meadow* (7.9 KB) — retired; its script (`js/admin.js`) is a
522-byte stub, so the page renders and does nothing. The working console in this tree is
`admin-crm.html` with `js/admin-crm.js`.
- The **retired** earlier admin panel (layers `#layer-dashboard`, `#layer-users`,
  `#layer-inquiries`, `#layer-comms`; ids `#crm-user-list`, `#crm-inquiry-list`,
  `#inquiry-detail-view`, `#adminCommsForm`, `#commTitle`, `#commContent`, `#count-tasks`,
  `#count-account`, `#count-suggestions`, `#count-other`).
- It loads `js/admin.js`, which is a 522-byte placeholder (`// CRM Admin panel – placeholder`)
  whose only function is `loadInquiries`. The real console is `admin-crm.html`. Keep `CRM.html`
  only as an archive; do not extend it.

### 2.5 Support scripts (load on most pages)

- **`js/app.js`** — theme loader and shared UI. `loadSiteTheme`, `fetchThemeAndUpdateCache`,
  `subscribeToThemeChanges`, `applyTheme`, `getFallbackTheme` read `theme_settings` and cache it in
  `localStorage.meadow_theme_cache` for 24 h (`CACHE_TTL`); `LEGACY_THEME_CACHE_KEY` is honoured for
  upgrades from the old key. `updateHomeStats` calls RPC `get_site_stats`. `showToast` is the shared
  toast. Also owns the mobile menu toggle and the global loader (`#global-loader`, `#loader-text`).
- **`js/emoji.js`** — the display-policy net. `stripEmoji`, `tidy`, `cleanTextValue`, `skipEl`,
  `cleanNode`, `cleanAttrs`, `start`. It runs on every page and strips pictographic characters from
  rendered text and attributes, keeping arrows, dashes and typographic marks. The database keeps its
  original literals (see Part 1, section on stage keys); this net only cleans what is displayed.
- **`js/nav-auth.js`** — auth-aware header. `buildInMenu`, `render`, `main`; it finds the login link
  (`a[href="login.html"]`, `a[href="./login.html"]`) and swaps it for the member's menu (profile,
  logout) when a session exists. It currently ships on a subset of pages, so other pages still show a
  static sign-in link.
- **`js/supabase-config.js`** — the Supabase URL and **anon** key. Public by design; there is no
  service-role key anywhere in the front end.
- **`js/config.js`** — runtime configuration. `getConfig`, `getAllConfig`, `clearConfigCache`,
  `sendEmail`; it reads the `app_config` table through RPC `get_all_config` so copy, limits and
  feature switches can be changed without redeploying.
- **`js/theme-tokens.js`** — the shared token model. `parseTokenMeta`, `getAllTokenDefs`,
  `getUserTokens`, `getEarnedTokenMap`, `getThemeCompletionCounts`, `buildTokenDisplayList`,
  `getAchievementSubtext`, `getMilestoneDisplayDescription`; reads `tokens`, `user_tokens`,
  `user_tasks` and is what turns completion counts into "5/10/15 tasks → token" display state.
- **`js/share-card.js`** — shareable progress card. `getShareStats`, `generateCardHTML`, `doCapture`;
  reads `profiles`, `user_tasks`, `user_milestones` and caches with `SHARE_CARD_KEY`. Captures the
  card to an image for social sharing.
- **`js/notification.js`** — the messenger module: `checkLiveBuzz`, `renderMessengerBadge`, a
  10-second poll over a 24-hour window of `communications`, badge updates and a link to
  `board.html?postId=…`. **Loaded by no page**, and its badge/popover DOM exists in no HTML file, so
  the module is dormant; the `?postId=` parameter is never parsed by the board either.
- **`js/social.js`** (22.8 KB) — the social layer on the profile page: leaderboard, member search,
  profile cards, partner invites by email, and privacy controls (`openLeaderboard`, `openProfileCard`,
  `runSearch`, `openInviteByEmail`, `checkEmail`, `sendInvite`, `privacyLine`, `wirePrivacyBtn`,
  `buildVisibilityBlock`, `refreshPrivacyLine`, `injectUI`, `initSocial`, plus `tierLabel`,
  `upgradePopup`, `ensureModal` / `openModal` / `closeModal` and the share helpers).
- **`js/collaboration.js`** (15.7 KB) — partner collaboration: `initCollab`, `loadPartnerProgress`,
  `isPartnerDone`, `getPartnerDoneDate`, `markInviteLocked`, `showInviteLinkDialog`, `shareVia`,
  `shareNative`, `updatePartnerUI`, `hideInviteButton`, `showInviteButton`, `checkInviteOnLoad`,
  `showAcceptDialog`; RPCs `get_collab_partners`, `get_partner_profiles`, `get_partner_progress`,
  `create_collab_invite`, `accept_collab_invite`.
- **`js/trial.js`** (19.4 KB) — the trial/policy hub used by `trail.html` and
  `information-and-links.html`: auth check, user header, dynamic sidebar from `navigation_menu`,
  briefs table from `policy_briefs`, media cards from `hub_content` (with YouTube/TikTok embeds via
  `extractYouTubeId` / `extractTikTokVideoId`), social hub from `social_links`.
- **`js/error-guard.js`** — a global error net that surfaces uncaught errors as a floating card. It
  ships with the React port and is loaded on every page.
### 2.6 End-to-end journeys

**A. New member, first session**
1. Lands on `the-meadow.html` (or is redirected there from `index.html`).
2. Clicks a call to action → `join.html` (or the `#signupSheet` bottom sheet on the landing page).
3. Submits `#signupForm`; Supabase creates the auth user, the `handle_new_user` trigger creates the
   `profiles` row, and the welcome email path runs (`js/signup.js` → `js/email.js`).
4. The member signs in (`login.html`) and arrives at `profile.html`. As a tier-0 member
   (`member_tier = 0`) they see the first theme's tasks in the `🌰 Seeds` stage only, with the first
   task of each theme unlocked.
5. The header switches from "Login" to the member menu when `js/nav-auth.js` runs on that page.

**B. Completing a task and unlocking the next one**
1. The member opens a daily task card and presses **Done**.
2. `complete_task` inserts the `user_tasks` row, adds the task's nectar reward (default 10) to
   `profiles.nectar_points`, increments `profiles.total_tasks_completed`, then calls
   `award_theme_tokens(user)`.
3. `js/profile.js` additionally calls `increment_theme_stage_progress` to record the day counters
   for that theme-stage, then recalculates unlock state.
4. The next task in that theme now shows
   `"<completed task>" completed — 24h until unlocked` with a live countdown; when the cooldown
   expires the card becomes actionable. All other themes keep their own independent sequence.
5. The progress bar and the completed badge update: they show `completed / total` and the
   percentage **against the total** — the denominator never shrinks as work is done.

**C. Earning a token**
1. Token definitions live in `tokens` (70 rows, 60 active, codes `TB-xxx`, 5/10/15 completed tasks
   per theme-stage, artwork under the `Token` storage bucket).
2. On completion, `award_theme_tokens` compares the member's completed-task count for that
   theme + stage against each token's `tasks_required` and inserts the missing `user_tokens` rows.
3. The token appears in the profile achievements area. Hidden tokens are revealed
   through `reveal_token`; milestone viewing is recorded with `mark_milestone_viewed` (the dashboard
   makes no token-viewing call, and `HIDDEN_LIMIT = 3` is the locked-task truncation, not the token
   tray).
4. The same tokens become stickers in the Honey Jar (`decorator.html`).

**D. Decorating the honey jar**
1. `decorator.html` loads; `#load-gate` hides the UI until `loadEarnedTokens` has the member's
   token set.
2. Stickers are placed in `Auto-fit` (tidy wedges) or dragged in `Free place`, where each sticker
   carries `↻` rotate and `⇱` resize handles; at most three sit on the lid at once. `#zoom-lid`
   (2.15x) fine-tunes the lid and `#reset-layout` re-seeds the wedges. There is no physics
   simulation — the Matter.js variant in `js/decorator.js` is loaded by no page.
3. `#saveBtn` calls `save_jar_decorations` (SECURITY DEFINER, ownership-checked), which replaces
   the member's rows in `user_jar_decorations` in full; rotation is mirrored locally until the DB
   column exists.
4. `#png-btn` renders the jar to PNG in the browser (long edge capped at 1800 px) and `#share-btn`
   hands the file to the OS share sheet.

**E. Inviting a collaboration partner** (Collective-tier feature)
1. The member opens the collaboration panel on `profile.html`; `js/collaboration.js` calls
   `get_collab_partners` and `get_partner_progress`.
2. `refreshTier` / `tierLabel` in `js/social.js` check the tier first. A member below the Collective
   meadow tier gets the upgrade popup (`upgradePopup`) instead of an invite control — they cannot
   invite until they upgrade.
3. A Collective member creates an invite: `create_collab_invite` for a link,
   `create_directed_collab_invite` / `lookup_member_for_invite` for a specific member by email.
   `showInviteLinkDialog` plus `shareVia` / `shareNative` (Web Share API) distribute it.
4. The invitee opens `collaborate.html` with the token in the URL, sees `#inviteStatus` /
   `#inviteMessage`, and presses `#acceptInviteBtn` → `accept_collab_invite`.
5. Once accepted, both sides can see shared progress: `get_partner_progress` returns each partner's
   completion state, `isPartnerDone` / `getPartnerDoneDate` drive the done badges, and
   `markInviteLocked` prevents re-use of a spent invite.

**F. Reading and posting on the board**
1. Anyone (member or not) opens `board.html`; `js/comms.js` fetches `communications` and renders the
   filter pills and posts, with relative timestamps.
2. Clicking a post opens the bottom sheet with title, body and date.
3. There is no messenger to get: `js/notification.js` is loaded by no page, its badge DOM exists
   nowhere and the `?postId=` deep link is never parsed. What refreshes live is the board itself —
   its Realtime channel re-renders the pills, the post list, the Recent Activity card and the badge
   holder. Filter pills only cover types posted in the last 24 hours.
4. Admins publish from the Communications layer of `admin-crm.html`, which inserts into
   `communications` with `content` (not `message`) — so an as-is broadcast shows an empty body on
   the board until one of the two field names is aligned. `admin_comms.html` is a
   `localStorage`-only legacy page and publishes nothing.

**G. A day in the admin console**
1. Open `admin-crm.html`; `checkAuth` runs `is_admin` and bounces non-admins.
2. Dashboard: `get_admin_stats` fills the stat grid; `downgrade_expired_subscriptions` and
   `check_upcoming_renewals` are the maintenance buttons.
3. Users: search, open a member, adjust points (`admin_set_points`), edit the record
   (`admin_update_user`), grant or revoke admin (`add_admin` / `remove_admin`).
4. Tasks / Themes / Tokens / Milestones: full CRUD through the matching `admin_save_*` /
   `admin_delete_*` functions and the `admin_get_*` / `admin_list_*` readers.
5. Communications: publish a broadcast, review history.
6. Inquiries: filter and open contact submissions; `admin_update_inquiry` records the outcome.
7. Achievements: `admin-achievements.html` is the quick surface for milestone and token definitions.

### 2.7 Operator playbooks (where to change what)

- **Add or edit a task** — `admin-crm.html` → Tasks layer (`admin_save_task`), or directly in the
  `tasks` table. Keep `theme_id`, `stage`, `core_theme`, `subcategory`, `task_order` (1-10),
  `nectar_reward` and the `version` field consistent: `task_order` defines the sequential chain and
  the `version` (`novice` / `experienced`) decides which pass the task belongs to.
- **Change what a tier can see** — the stage allowlist lives in `get_user_tasks_v2` (the
  `CASE` on `member_tier`). Themes themselves are gated by `themes.min_tier`; the front end checks
  the tier before rendering a theme chip. The Collective gate for collaboration is
  `js/collaboration.js` / `js/social.js` plus the tier checks inside the collaboration RPCs.
- **Change reward amounts** — per task: `tasks.nectar_reward`. Plan prices: the Stripe `products` /
  `prices` rows (Hive+ 10, Steward 20, Collective 25 per month) — change in Stripe, then mirror the
  rows. Point weighting: `calculate_points` (impact × stage × level × engagement) and the level /
  engagement thresholds in `update_user_levels`.
- **Add a token** — `admin-crm.html` → Achievements → Tokens (`admin_save_token`), or the `tokens`
  table: set `theme_id`, `stage`, `token_code` (`TB-xxx`), `tasks_required` (5 / 10 / 15),
  `badge_tier`, `description`, `icon_url` (upload to the `Token` bucket first).
- **Add a milestone** — `admin_save_milestone`, or the `milestones` table. Milestones are grouped by
  `category` (nectar / tasks / membership / sigma / referrals / theme_token) and are evaluated in
  `check_and_award_milestones`. Note that `theme_token` milestones are the per-token artefacts and
  are also what the jar and the achievements wall read.
- **Change site copy, limits or switches** — `app_config` via `admin_save_config`
  (read at runtime by `js/config.js` through `get_all_config`). No redeploy needed.
- **Change the look** — `meadow-theme.css` holds the CSS custom properties (gold `#D9A441`,
  cream `#FFF3D6`, and the rest of the palette); `theme_settings` + `js/app.js` hold the runtime
  theme. Font Awesome is the house icon set — do not reintroduce emoji.
- **Publish news** — insert into `communications` from the admin console's Communications layer,
  and populate **`message`**: the board renders `message` while the console form writes `content`,
  so a broadcast published as-is shows an empty body (section 15.5). The board picks new rows up
  automatically through its Realtime channel; there is no messenger poller. `admin_comms.html` is a
  `localStorage`-only legacy page that posts nothing.
- **Handle a contact inquiry** — `contact_inquiries` is written by `contact.html`; read and update it
  in `admin-crm.html` (Inquiries layer) — the legacy `admin_inbox.html` reads only its own
  `localStorage` key and is disconnected from the table.
- **Gate the trial hub material** — `navigation_menu` (sidebar), `policy_briefs` (briefs table),
  `hub_content` (media cards), `social_links` (link hub); all driven by `js/trial.js`.
- **Privacy and visibility** — `profiles.is_public` plus `set_profile_visibility`,
  `ensure_profile_alias`, `profile_display_name`, `get_public_profile`, `search_public_profiles`
  and `get_leaderboard` control what other members can see.

### 2.8 Glossary

- **Nectar points** — the member's running score (`profiles.nectar_points`). A task normally adds 10.
- **Nectar / Bloom / Sprout / Seed** — the *engagement* bands derived from points:
  under 50 Seed, under 200 Sprout, under 500 Bloom, otherwise Harvest (`update_user_levels`).
- **Level** — Novice under 100 lifetime points, Experienced at 100 or more.
- **Tier / member_tier** — the paid membership level 0-3 (Hive+ 10, Steward 20, Collective 25 per
  month). It controls which stages and themes are visible, and whether collaboration is available.
- **Core theme** — the *category* a task belongs to (Connecting / Belonging, Creating / Circularity,
  Reflecting / Learning, Acting / Motivating). The fifth theme, Innovating / Stewardship, currently
  carries Connecting-labelled task rows — a known content issue.
- **Theme** — one of five tracked areas, `T01`-`T05`, each with its own task chain, token family and
  badge.
- **Stage** — the maturity band a task belongs to: `🌰 Seeds`, `🌱 Sprout`, `🌸 Bloom`, `🌾 Harvest`.
  These exact strings are database keys, so they appear verbatim in the data even though the UI
  renders them without pictographs.
- **Guardrail** — a persistence rule enforced before a stage is credited (minimum days, task types,
  spread of days, nectar).
- **Token / artefact** — a collectible awarded for 5, 10 or 15 completed tasks in a theme-stage;
  stickers in the jar and items on the achievements wall.
- **Milestone** — a one-off award triggered by a category threshold; 32 exist.
- **Badge** — a five-part themed achievement (per theme) with four stages: Sprout, Bloom, Grow,
  Harvest. Signed-off in stages via `submit_badge_stage` / `approve_badge_stage`.
- **Honey Jar** — the canvas where earned tokens are arranged as stickers and saved/exported.
- **Collaboration** — a two-person partnership on a task chain; requires the Collective tier.
- **Communication** — a broadcast post; the board lists them and the messenger polls them.
- **Admin** — a profile listed in `admin_users`; all admin data access goes through `admin_*`
  SECURITY DEFINER functions.

### 2.9 Verification commands used for this document

- Database (read-only helper, `cache/scratch/dbq.py`):
  `python3 dbq.py "select current_database(), count(*) from information_schema.tables where table_schema='public'"`
- Table/column inventory: `information_schema.columns` per table; row counts refreshed at read time.
- Function inventory: `pg_proc` joined to `pg_namespace` for the public schema, with
  `prosecdef` to identify SECURITY DEFINER functions.
- Policy inventory: `pg_policies` filtered to the public schema.
- Rule extraction: the bodies of `calculate_points`, `complete_task`, `get_user_tasks_v2`,
  `increment_theme_stage_progress`, `award_theme_tokens`, `update_user_levels`,
  `check_and_award_milestones`, `reveal_token`, `save_jar_decorations` were dumped and read, not
  paraphrased.
- Front end: the 24 pages, the 22 scripts and the shared CSS were read directly; page structure in
  Part 2 comes from each page's own headings, ids and script list.

---

## 23. The admin CRM (added 13 October 2026)

**Administration is now one route in the React app: `/admin`.** Nothing in the member
experience changed — same pages, same game rules, same rewards, same login. What changed is the
back-office.

### 23.1 Why it was replaced

The old back-office was five vanilla pages that read and wrote tables directly with `.from()`.
RLS returns only the caller's own row for most of those tables, so the pages silently showed
nothing, and their writes were silently refused (section 16.3). One of them
(`admin-achievements.html`) had no administrator check at all, and one real write path could
never succeed: `js/admin-crm.js` inserted `{title, content, author_id, created_at}` into
`communications`, whose `message` column is `NOT NULL` with no default, while every reader
renders `message`.

### 23.2 The design

- **One route**, `/admin`, with a shareable section query (`/admin?section=members`) so the
  browser back button works.
- **Privileged access only through the database.** Every read and every write goes through a
  `SECURITY DEFINER` `jsonb` RPC. No `.from()` call exists anywhere in the admin UI.
- **The gate is in Postgres, not the browser.** `admin_ok()` / `is_admin()` is evaluated as the
  caller. An anonymous caller gets `false` (measured, not assumed), and the app then shows a
  sign-in prompt. Hiding or showing a control is presentation, never the security boundary.
- **No new identity, no new database, no second copy of member data.** The anon key remains the
  only key in client code; `service_role` is never used by the app.

### 23.3 The thirty-two sections

The navigation is six collapsible groups (OVERVIEW, MEMBERS & RECOGNITION, THE MEADOW,
COMMUNICATIONS, CONTENT & BUSINESS, OPERATIONS) holding thirty-two sections. Grouping is
presentational only: every section id appears in NAV_TARGETS, so a deep link opens the group
that hosts it, and the group state is remembered per group in localStorage.

Overview (Dashboard, Activity Feed, Analytics, Overview), Members & Recognition (Members,
Member Reviews, Reflections, Sigma Logs, Nectar & Impact, Impact Logs, Member Progress,
Recognition & Rewards, Physical Gift Fulfilment, Memberships & Subscriptions), The Meadow
(Tasks, Themes & Stages, Tokens & Achievements, Milestones & Badges, Collaborations &
Invitations), Communications (Support Inbox, Ticket History, Communication Board, Email &
Notifications), Content & Business (Website CMS, Navigation Menu, Social Links, Policy
Briefs, Founders), Operations (Admin Team & Permissions, Audit Logs, System Health,
Settings).

Tasks, Themes, Tokens, Milestones and the five website-content kinds are all the *same*
config-driven list/edit/delete component reading a per-entity description, so a new entity is a
configuration entry, not new UI. The eight sections from Review centre to Integration health
(entered as Review centre, Recognition & gifts, Support inbox, Nectar ledger, Notifications,
Settings, Integration health) are the CRM core modules; the Auditing entry is "Audit log".

### 23.4 The RPC surface — 113 functions live today

The count in this heading is generated, not remembered: `dump_live_admin_sigs.py` reads
`pg_proc` and writes `admin-crm/05-LIVE-RPC-SIGNATURES.md` (`113` admin functions on
14 October 2026, of which `PUBLIC` holds `EXECUTE` on none). The table below records what the
first four migrations added; 23.10 records what came after.

| migration file | lines | what it adds | verification |
|---|---|---|---|
| `sql/2026-10-13-01-admin-plane-hardening.sql` | 87 | revokes anon `EXECUTE` on six functions that hand out privilege, destroy data or mutate subscriptions with no internal check; adds the guard inside `add_admin` | applied; live anon call now returns `401 permission denied` |
| `sql/2026-10-13-01-communications.sql` | 169 | `admin_get_communications`, `admin_save_communication`, `admin_delete_communication` | **16 PASS / 0 FAIL** |
| `sql/2026-10-13-02-subscriptions-analytics.sql` | 336 | `admin_get_subscriptions`, `admin_get_member_subscription`, `admin_set_member_tier`, `admin_update_subscription`, `admin_get_analytics` | **29 PASS / 0 FAIL** |
| `sql/2026-10-13-03-site-content.sql` | 269 | `admin_get_site_content`, `admin_save_site_item`, `admin_delete_site_item` — one trio for the five content kinds `hub / nav / social / policy / founder` | **18 PASS / 0 FAIL** |

All four files are applied to production. Each is idempotent, each ends in
`NOTIFY pgrst, 'reload schema';`, and each is deployable by hand in the Supabase SQL editor —
the repository holds no `service_role` key and no database connection string.

### 23.5 Rules this surface must keep

1. **RPCs only, never `.from()`.** RLS on an admin page returns the caller's own row, so direct
   table access works for some tables and silently fails for others.
2. **Every RPC is gated** by `admin_ok()` and returns `jsonb` (PostgREST rejects a `TABLE`
   return with a 400).
3. **Every deploy file ends with** `NOTIFY pgrst, 'reload schema';` or the API serves a stale
   schema.
4. **An edit must send the row's primary key.** The save RPCs choose insert-versus-update by
   looking for `p_data->>'id'` (or `theme_id`); a form that omits it creates a duplicate row
   instead of editing. This bug was live in the first build and is fixed centrally.
5. **`member_tier` drives access; `tier` is a display mirror.** `social.js` gates collaboration
   on `member_tier >= 3`. The Membership form always sends both.
6. **Ground truth is the live catalog**, not a hand-maintained signature table:
   `information/admin-crm/05-LIVE-RPC-SIGNATURES.md` is generated from `pg_proc` and is what the
   wiring verifier checks against.

### 23.6 Verification performed

- `vite build` clean, `oxlint` zero errors, no emoji in the admin source.
- Wiring against the **live** catalog: **32 PASS / 1 WARN / 0 FAIL**, **54/54 RPCs wired**
  (figures from this stage — §23.10 and §23.12 carry the current counts).
  The one warning is that 41 pre-existing functions still carry the house default `PUBLIC`
  EXECUTE — not a hole (the `admin_ok()` guard is the boundary; an anon call returns
  `{"error":"Forbidden"}`), and the exact tidy-up SQL is recorded in
  `admin-crm/04-ADMIN-UI-BUILD.md`.
- Every read RPC called as the administrator through the real JWT path: **33 PASS / 0 FAIL**,
  including each content kind returning its true row count (`hub` 7, `nav` 5, `social` 4,
  `policy` 3, `founder` 1); the same reads with the anon key are refused.
- Migration behavioural harnesses: **16 / 29 / 18 PASS, 0 FAIL.** The write probes run inside a
  block that always raises, so they roll back and production counts are unchanged.
- Not exercised in a browser: the write buttons themselves (save, delete, tier change), because
  the working session had no administrator credential. Their argument names are verified against
  the live signatures and their reads are proven to return data. An administrator signing in at
  `/admin` is the remaining click-through.

### 23.7 Still open versus the full intended scope

Items 1–3 of this list were closed by migrations 09–11 (see 23.10); what remains is:

1. **Badges, badge stages and challenges still have no management RPC, and
   `achievements`, `challenges`, `impact_conversion` and `theme_stats` still have row level
   security switched off** (see section 22). Enabling RLS there is not a mechanical change:
   the member pages write some of them with the anon key, so the write paths have to be found
   first or member behaviour breaks.
2. **The email transport is not wired.** `send-email` (and `check-renewals`) return 404, so
   every outbound message — ticket replies, member notifications, invitations — records
   `email_status: 'not_configured'` and delivers nothing. The CRM says so honestly rather than
   showing a false success. Writing the Brevo/SMTP secret and deploying the two edge functions
   is the whole fix; `admin_get_integration_health` will report ready the moment it lands.
   Invitation delivery has the same dependency, though the invitation itself is stored,
   revocable and acceptable in-app regardless.
3. **Subscription data is empty** — `subscriptions` has no rows, so
   `admin_get_subscriptions` and the member subscription panel have nothing to show until the
   Stripe webhook backfill runs.
4. **Automation** — scheduled and triggered administration actions.
5. **Two findings from the security audit remain unapproved and unfixed:**
   `handle_subscription_event(...)` is anon-reachable with no internal check (a forged
   `customer.subscription.updated` would grant a paid tier), and `reset_user_progress_by_id` /
   `unlock_all_tasks_for_user` are callable by any signed-in member.

### 23.8 Files removed from the served tree (13 October 2026)

Three demo files were removed from `public/`. A whole-tree search found no page, script or
component referencing any of them, so nothing a visitor or member does can change:

| file | why |
|---|---|
| `public/users.json` | **Plaintext demo credentials** (`bee@hivenectar.com` / `password123`) served at `/users.json`. Not a product file; nothing reads it. |
| `public/admin_comms.json` | Static demo broadcast list, replaced by the `communications` table and its RPCs. |
| `public/tasks_master.json` | Static task catalogue copy; the live engine reads the database. |

`src/legacy/testjar.html` was **kept** — despite the name it is the Honey Jar lid decorator,
a real member page, wired in by `import.meta.glob('../legacy/*.html')` in
`src/components/LegacyPage.jsx`. The byte-parity manifest in `verification/` still lists the
three removed files, because it is the record of the port as it was made; provenance copies
and the reasoning sit in `information/removed-demo-files/`.

The build record, the capability matrix and the packaged verifiers live in
`information/admin-crm/`.

### 23.9 Member-facing fixes and media uploads (13 October 2026)

Four owner-requested changes, all local-only and unpushed. Full detail in
`information/admin-crm/07-MEMBER-FIXES.md`; migration 06 in `admin-crm/sql/`.

**Reflections can now be read and edited.** The profile reflection sheet
(`public/js/profile.js`) gained *Pending* / *Submitted* tabs. Pending is the
completed-but-not-reflected list whose count drives the existing
`#pendingSigmaCountBadge` / `#mobilePendingSigmaBadge` badges; Submitted lists the
member's own `task_sigma_logs` rows with the same eye affordance the completed-task
list uses, opening a read-only detail view with an *Edit this reflection* action.
`openTaskSigmaModal(taskId, taskTitle, editLogId)` now updates instead of
inserting when editing. This is the first client-side write path to
`task_sigma_logs` beyond insert, and that table was found with **RLS disabled and
zero policies** — migration 06 enables RLS with owner-only policies, so a member
can only ever read or edit their own reflections.

**Artwork uploads from the CRM.** `tokens.icon_url`, `milestones.icon_url` and
`badges.icon_url` hold full public Storage URLs, and `admin_save_token` /
`admin_save_milestone` already accepted `icon_url`, so no RPC changed. What was
missing was storage policy and any upload control: migration 06 replaced the
unscoped `badges_admin_insert` (empty `with check`, no `bucket_id` — any signed-in
member could upload to any bucket) with bucket-scoped admin policies and added
insert/update/delete for `Jar`, `Policies` and `Theme image`. The CRM now has a
`file` field type that uploads before saving and writes the resulting public URL
into the same column the member site reads.

**The 24-hour message icon.** It was the communications board's filter pill row:
`comms.js:renderFilterPills()` built pills only from post types younger than 24
hours, so publishing in a new category added a pill with its icon that disappeared
a day later. Pills are now derived from every post type in the feed. Note that
`public/js/notification.js` — the floating `#messenger-buzz` bubble with its own
24-hour window — is **dead code**: no page loads it and none of its DOM targets
exist, on the site or live.

**Storage buckets (all public) and their folders:** `Token` →
`Token/<Theme name>/<Seed|Sprout|Bloom>/`, `Badges` → `Badges/<Category>/`,
plus `Jar`, `Policies`, `Theme image`, `avatars`. `themes.bucket_folder` does not
exist live; folders follow the theme *name*.


### 23.10 The CRM core modules (13 October 2026)

Section 23.7 listed what was still missing against the full brief. Migration 11 closes
it. Three SQL files were applied to the live project and verified in place:

| file | what it ships |
|---|---|
| `2026-10-13-09-admin-roles-audit-invitations.sql` | named roles, invitations, audit log, `admin_can` rewritten so `read.all` never satisfies a write permission |
| `2026-10-13-10-grant-hardening.sql` | revokes anon EXECUTE across the whole `admin_*` surface — verified live: anon holds EXECUTE on none of the `admin_*` functions, `authenticated` on all of them |
| `2026-10-13-11-crm-modules.sql` | the twelve CRM tables and their 37 functions |
| `2026-10-13-12-security-remediation.sql` | closes the four approved security findings (see 23.12) |
| `2026-10-14-13-ops-read-layer.sql` | Phase A read layer: 8 permission-gated read RPCs (dashboard metrics, activity feed, reflections, sigma inbox, ticket history, SLA stats, member 360, gift fulfilment), the support SLA trigger, and the review-queue ingest trigger that finally fills `member_reviews` (see 23.13) |
| `2026-10-14-13-ops-read-layer.sql` | the CRM read layer: dashboard metrics, activity feed, reflections, sigma inbox, ticket history, SLA stats, member 360 and the gift fulfilment queue — plus the review-queue ingest and SLA triggers (see 23.13) |

**Twelve new tables, every one with row level security enabled and no policy that
lets a member read another member's row:** `member_reviews`, `member_review_events`,
`nectar_ledger`, `gift_catalogue`, `gift_stock_movements`, `recognitions`,
`recognition_evidence`, `recognition_events`, `support_tickets`, `support_messages`,
`support_templates`, `admin_notifications`.

**Member Review Centre.** `admin_sync_review_queue` scans `user_tasks` for completed
tasks that have no review row yet and queues them — the queue is not a second copy of
the task data, it is a work list over it. Statuses are `new`, `in_review`,
`needs_clarification`, `reviewed`, `flagged`; `flagged` refuses to move without a
reason. A review item carries the member, the task, the full
define/measure/analysis/improve/control submission and an append-only event history
(`member_review_events`). `admin_reply_to_member` writes the reply and reports the
delivery result honestly.

**Nectar ledger.** `nectar_ledger` is the audit trail for every points change, and
`admin_adjust_nectar` is the only writer. It refuses a zero delta, a blank reason and
any correction that would take a member below zero, and returns `balance_before` and
`balance_after` so the screen can prove the arithmetic.

**Recognition and physical gifts.** This is the module that has a real fulfilment
machine behind it, with thirteen statuses:

`nominated → approved → awaiting_acceptance → awaiting_address → ready_to_pack →
packed → shipped → delivered → completed`, plus the terminal branches `rejected`,
`declined`, `cancelled`, `delivery_failed`.

`admin_advance_recognition` is the only mover and enforces, server-side, that a move
can only go forward; that *awaiting_address* requires the member to have accepted;
that entering any packing-or-later status requires both a delivery address and a
recorded consent; that *shipped* requires a carrier and tracking number; and that a
cancellation, rejection, decline or delivery failure requires a reason. **The commit
point is `ready_to_pack`**: it demands `fulfilment.manage`, refuses to run when stock
is zero, and decrements `gift_catalogue.stock_quantity` while writing an `allocation`
row to `gift_stock_movements` — so the catalogue, the movement log and the award can
never disagree. `cancelled` and `delivery_failed` return the allocated stock and say
so (`stock_returned: true`). A closed award refuses every further move. Every unit
cost is recorded, so `admin_get_recognition_dashboard` can report committed and
delivered spend, the pipeline counts and the gifts that are out of stock.

**Support inbox.** `contact_inquiries` rows are imported into `support_tickets`
(`admin_import_inquiries`), which then carries subject, status (`new`, `open`,
`pending_customer`, `pending_internal`, `resolved`, `closed`), priority (`low`, `normal`, `high`,
`urgent`, which recomputes the SLA due time), assignee, the message thread
(`support_messages`, inbound/outbound/internal note) and canned responses
(`support_templates`). Tickets can be merged. Each outbound message carries its own
delivery state, and **the email transport is not configured yet**, so a reply comes
back `email_status: 'not_configured'` and `delivered: false`, with the reason kept on
the message row's `email_error` column. The UI shows that as not sent — it must never
dress a non-delivery up as a success. Writing the Brevo/SMTP secret and deploying the
`send-email` edge function flips `admin_get_integration_health` to ready and nothing
else has to change.

**Notifications, settings, health.** `admin_send_member_notification` writes an
in-app notification and reports the same honest delivery state;
`admin_get_settings` / `admin_save_setting` / `admin_delete_setting` manage the
config store the RPCs already read; `admin_get_integration_health` returns a `health`
object holding one entry per dependency (`email_transport`, `billing`, `realtime`),
each with `ready` and `detail`, plus a `tables` block of live row counts.

**Verification performed.** `information/admin-crm/verification/apply_verify_migration11.py`
applies migrations 09 and 11 and then exercises every new function against the live
database with the primary admin's JWT claims set, exactly as a browser session would:
catalogue of the twelve tables, RLS present on all twelve, all 37 functions present,
no `admin_*` function reachable with the anon key, each function called with real
data, the review queue round-trip, a ledger correction that is refused for going
below zero, a four-step gift stock sequence, a recognition driven through nomination,
approval, acceptance, address, packing, shipping, delivery and completion, a
cancellation that returns stock, a support ticket with a real reply and a merge, and
the negative cases (blank reply, unknown status, illegal transition, closed award).
Result: **137 PASS / 0 FAIL**. Four further verifiers cover the UI without a browser.
`verify_admin_ui_wiring.py` (**79 PASS / 0 WARN / 0 FAIL**) refreshes the live signature
list from `pg_proc` and holds every UI call site to it (argument names and required
arguments), asserts every navigable section's component is actually imported or
declared, so a nav entry cannot point at a screen that does not exist, requires every
`adm-*` class used in the admin source to be defined in `admin.css`, and audits the
source for emoji. `verify_crm_payload_shapes.py` (**25 PASS / 0 FAIL**) calls each CRM
read RPC against the live database and asserts the keys the UI reads are really in the
reply, which a wiring check alone cannot prove. `verify_admin_rpc_path.py` (**33 PASS /
0 FAIL**) walks one RPC path end to end, and `verify_guide_admin_section.py` (**25 PASS /
0 FAIL**) holds this section to the live catalogue and the app's own navigation rather
than to numbers written by hand. `apply_verify_migration12.py` (**34 PASS / 0 FAIL**)
applies the security remediation and then plays both sides of it against the live
database: the anonymous caller and a real non-admin member are refused with `42501` and
their rows are byte-identical afterwards, while an administrator's identical call still
succeeds and is written to the audit log.

Rules this section keeps: the CRM is built on the existing Supabase RPC surface —
there is no second customer database, no service-role key in browser code, and no
change to the public site, the member experience or the task engine. Every write goes
through a `SECURITY DEFINER` function that checks a named permission and writes an
audit row.

<!-- BEGIN GENERATED ADMIN INVENTORY -->

### 23.11 The live admin RPC catalogue (generated)

Generated from `pg_proc` on the production project by `dump_live_admin_sigs.py`;
rendered into this file by `render_admin_inventory.py`. **113 functions.**
Do not hand-edit the table: rerun the scripts. `defaults` counts the trailing
parameters that carry a DEFAULT, which PostgREST may omit from a call.

| function | arguments | defaults | returns | public EXECUTE |
|---|---|---|---|---|
| `add_admin` | `p_email text` | 0 | boolean | no |
| `admin_accept_invitation` | `p_token text` | 0 | jsonb | no |
| `admin_actor_email` | `p_user_id uuid` | 1 | text | no |
| `admin_adjust_gift_stock` | `p_gift_id uuid, p_delta integer, p_kind text, p_note text` | 2 | jsonb | no |
| `admin_adjust_nectar` | `p_user_id uuid, p_delta integer, p_reason text, p_category text` | 1 | jsonb | no |
| `admin_advance_recognition` | `p_id uuid, p_status text, p_payload jsonb` | 1 | jsonb | no |
| `admin_assign_review` | `p_id uuid, p_assignee uuid, p_reason text` | 2 | jsonb | no |
| `admin_can` | `p_perm text, p_user_id uuid` | 1 | boolean | no |
| `admin_create_ticket` | `p_ticket jsonb` | 0 | jsonb | no |
| `admin_decide_recognition` | `p_id uuid, p_decision text, p_reason text` | 1 | jsonb | no |
| `admin_delete_collab_invite` | `p_invite_id uuid` | 0 | jsonb | no |
| `admin_delete_collaboration` | `p_collab_id uuid` | 0 | jsonb | no |
| `admin_delete_communication` | `p_id uuid` | 0 | jsonb | no |
| `admin_delete_config` | `p_key text` | 0 | jsonb | no |
| `admin_delete_inquiry` | `p_inquiry_id uuid` | 0 | jsonb | no |
| `admin_delete_milestone` | `p_milestone_id integer` | 0 | jsonb | no |
| `admin_delete_setting` | `p_key text` | 0 | jsonb | no |
| `admin_delete_sigma` | `p_sigma_id uuid` | 0 | jsonb | no |
| `admin_delete_site_item` | `p_kind text, p_id text` | 0 | jsonb | no |
| `admin_delete_support_template` | `p_id uuid` | 0 | jsonb | no |
| `admin_delete_task` | `p_task_id uuid` | 0 | jsonb | no |
| `admin_delete_theme` | `p_theme_id text` | 0 | jsonb | no |
| `admin_delete_theme_progress` | `p_user_id uuid, p_theme_id text, p_stage text` | 0 | jsonb | no |
| `admin_delete_token` | `p_token_id uuid` | 0 | jsonb | no |
| `admin_delete_user` | `p_user_id uuid` | 0 | jsonb | no |
| `admin_delete_user_milestone` | `p_user_id uuid, p_milestone_id integer` | 0 | jsonb | no |
| `admin_delete_user_task` | `p_user_id uuid, p_task_id uuid` | 0 | jsonb | no |
| `admin_delete_user_token` | `p_user_id uuid, p_token_id uuid` | 0 | jsonb | no |
| `admin_get_action_logs` | `p_limit integer, p_action text, p_actor_id uuid, p_target_type text, p_target_id text, p_search text` | 6 | jsonb | no |
| `admin_get_activity_feed` | `p_limit integer, p_from timestamp with time zone, p_to timestamp with time zone, p_kind text` | 4 | jsonb | no |
| `admin_get_admins` | `-` | 0 | jsonb | no |
| `admin_get_analytics` | `p_days integer` | 1 | jsonb | no |
| `admin_get_audit_actions` | `-` | 0 | jsonb | no |
| `admin_get_collab_invites` | `-` | 0 | jsonb | no |
| `admin_get_collaborations` | `-` | 0 | jsonb | no |
| `admin_get_communications` | `p_limit integer, p_offset integer` | 2 | jsonb | no |
| `admin_get_config` | `-` | 0 | jsonb | no |
| `admin_get_dashboard_metrics` | `p_from timestamp with time zone, p_to timestamp with time zone` | 2 | jsonb | no |
| `admin_get_fulfilment_queue` | `p_status text, p_limit integer` | 2 | jsonb | no |
| `admin_get_gift_stock_movements` | `p_gift_id uuid, p_limit integer` | 1 | jsonb | no |
| `admin_get_gifts` | `p_search text, p_include_inactive boolean` | 2 | jsonb | no |
| `admin_get_inquiries` | `-` | 0 | jsonb | no |
| `admin_get_integration_health` | `-` | 0 | jsonb | no |
| `admin_get_member_360` | `p_user_id uuid` | 0 | jsonb | no |
| `admin_get_member_subscription` | `p_user_id uuid` | 0 | jsonb | no |
| `admin_get_milestones` | `-` | 0 | jsonb | no |
| `admin_get_my_context` | `-` | 0 | jsonb | no |
| `admin_get_my_pending_invitations` | `-` | 0 | jsonb | no |
| `admin_get_nectar_ledger` | `p_user_id uuid, p_limit integer, p_offset integer` | 3 | jsonb | no |
| `admin_get_notifications` | `p_user_id uuid, p_limit integer` | 2 | jsonb | no |
| `admin_get_recognition` | `p_id uuid` | 0 | jsonb | no |
| `admin_get_recognition_candidates` | `p_limit integer` | 1 | jsonb | no |
| `admin_get_recognition_dashboard` | `-` | 0 | jsonb | no |
| `admin_get_recognitions` | `p_status text, p_search text, p_limit integer, p_offset integer` | 4 | jsonb | no |
| `admin_get_reflections` | `p_status text, p_limit integer, p_offset integer` | 3 | jsonb | no |
| `admin_get_review_item` | `p_id uuid` | 0 | jsonb | no |
| `admin_get_review_queue` | `p_status text, p_source text, p_search text, p_assignee uuid, p_limit integer, p_offset integer` | 6 | jsonb | no |
| `admin_get_settings` | `-` | 0 | jsonb | no |
| `admin_get_sigma_inbox` | `p_status text, p_limit integer, p_offset integer` | 3 | jsonb | no |
| `admin_get_sigma_logs` | `-` | 0 | jsonb | no |
| `admin_get_site_content` | `p_kind text` | 0 | jsonb | no |
| `admin_get_sla_stats` | `p_from timestamp with time zone, p_to timestamp with time zone` | 2 | jsonb | no |
| `admin_get_stats` | `-` | 0 | jsonb | no |
| `admin_get_subscriptions` | `p_limit integer, p_offset integer` | 2 | jsonb | no |
| `admin_get_support_templates` | `-` | 0 | jsonb | no |
| `admin_get_tasks` | `-` | 0 | jsonb | no |
| `admin_get_team_overview` | `-` | 0 | jsonb | no |
| `admin_get_themes` | `-` | 0 | jsonb | no |
| `admin_get_ticket` | `p_id uuid` | 0 | jsonb | no |
| `admin_get_ticket_history` | `p_status text, p_priority text, p_limit integer, p_offset integer, p_overdue boolean` | 5 | jsonb | no |
| `admin_get_tickets` | `p_status text, p_priority text, p_assignee uuid, p_search text, p_limit integer, p_offset integer` | 6 | jsonb | no |
| `admin_get_tokens` | `-` | 0 | jsonb | no |
| `admin_get_user` | `p_user_id uuid` | 0 | jsonb | no |
| `admin_get_users` | `-` | 0 | jsonb | no |
| `admin_import_inquiries` | `p_limit integer` | 1 | jsonb | no |
| `admin_invite_admin` | `p_email text, p_role_key text, p_note text` | 1 | jsonb | no |
| `admin_list_jar_decorations` | `-` | 0 | jsonb | no |
| `admin_list_theme_progress` | `-` | 0 | jsonb | no |
| `admin_list_user_milestones` | `-` | 0 | jsonb | no |
| `admin_list_user_tasks` | `-` | 0 | jsonb | no |
| `admin_list_user_tokens` | `-` | 0 | jsonb | no |
| `admin_log_action` | `p_action text, p_target_type text, p_target_id text, p_reason text` | 3 | jsonb | no |
| `admin_merge_ticket` | `p_target uuid, p_source uuid, p_reason text` | 1 | jsonb | no |
| `admin_nominate_recognition` | `p_user_id uuid, p_gift_id uuid, p_reason text, p_evidence jsonb, p_review_id uuid` | 2 | jsonb | no |
| `admin_ok` | `-` | 0 | boolean | no |
| `admin_reply_ticket` | `p_ticket_id uuid, p_body text, p_internal boolean, p_template_id uuid` | 2 | jsonb | no |
| `admin_reply_to_member` | `p_id uuid, p_body text, p_channel text` | 1 | jsonb | no |
| `admin_revoke_invitation` | `p_id uuid, p_reason text` | 1 | jsonb | no |
| `admin_role_of` | `p_user_id uuid` | 1 | text | no |
| `admin_save_communication` | `p_data jsonb` | 0 | jsonb | no |
| `admin_save_config` | `p_key text, p_value text, p_description text` | 1 | jsonb | no |
| `admin_save_gift` | `p_gift jsonb` | 0 | jsonb | no |
| `admin_save_milestone` | `p_data jsonb` | 0 | jsonb | no |
| `admin_save_setting` | `p_key text, p_value text` | 0 | jsonb | no |
| `admin_save_site_item` | `p_kind text, p_data jsonb` | 0 | jsonb | no |
| `admin_save_support_template` | `p_template jsonb` | 0 | jsonb | no |
| `admin_save_task` | `p_data jsonb` | 0 | jsonb | no |
| `admin_save_theme` | `p_data jsonb` | 0 | jsonb | no |
| `admin_save_token` | `p_data jsonb` | 0 | jsonb | no |
| `admin_send_member_notification` | `p_user_id uuid, p_title text, p_body text, p_link text, p_kind text` | 3 | jsonb | no |
| `admin_set_gift_active` | `p_id uuid, p_is_active boolean` | 0 | jsonb | no |
| `admin_set_member_tier` | `p_user_id uuid, p_member_tier integer, p_tier text` | 1 | jsonb | no |
| `admin_set_message_delivery` | `p_message_id uuid, p_status text, p_provider_message_id text, p_error text` | 2 | jsonb | no |
| `admin_set_points` | `p_user_id uuid, p_nectar integer, p_co2e numeric` | 1 | jsonb | no |
| `admin_set_review_status` | `p_id uuid, p_status text, p_note text, p_reason text` | 2 | jsonb | no |
| `admin_set_team_role` | `p_user_id uuid, p_role_key text, p_reason text` | 1 | jsonb | no |
| `admin_set_team_status` | `p_user_id uuid, p_status text, p_reason text` | 1 | jsonb | no |
| `admin_sync_review_queue` | `-` | 0 | jsonb | no |
| `admin_update_inquiry` | `p_inquiry_id uuid, p_status text, p_notes text` | 1 | jsonb | no |
| `admin_update_subscription` | `p_id text, p_data jsonb` | 0 | jsonb | no |
| `admin_update_ticket` | `p_ticket jsonb` | 0 | jsonb | no |
| `admin_update_user` | `p_user_id uuid, p_data jsonb` | 0 | jsonb | no |
| `remove_admin` | `p_email text` | 0 | boolean | no |

<!-- END GENERATED ADMIN INVENTORY -->

### 23.12 Security remediation — the four approved findings closed (13 October 2026)

`sql/2026-10-13-12-security-remediation.sql`, applied live and proven by
`verification/apply_verify_migration12.py` (**34 PASS / 0 FAIL**). Full record:
`admin-crm/09-SECURITY-REMEDIATION.md`.

A live privilege sweep of all 139 `SECURITY DEFINER` functions found four that could
change money, accounts or another member's records with no check inside:

| function | was reachable by | impact |
|---|---|---|
| `handle_subscription_event(...)` | **anon** (carried a `PUBLIC` grant) | forge a Stripe event with a known customer id and the account is granted a paid tier, or a paying member is dropped to `free` |
| `downgrade_expired_subscriptions()` | any signed-in member | trigger a site-wide billing sweep |
| `reset_user_progress_by_id(uuid)` | any signed-in member | wipe any other member's progress across eleven tables and rewrite their profile |
| `unlock_all_tasks_for_user(uuid)` | any signed-in member | complete every task for any member and rewrite their points and level |

The fix: `handle_subscription_event` loses `PUBLIC`, `anon` and `authenticated` grants, and
keeps `service_role` only — which is how its one legitimate caller, the Stripe webhook edge
function (`information/supabase/functions/stripe-webhook/index.ts:11`), authenticates. The
other three keep their existing grants and open with `perform public.assert_admin_can(…)`
(`billing.manage` / `member.write`), plus an audit row naming the operation, so a refusal
now changes nothing.

How that is known rather than assumed: the verifier runs each call as `authenticated` with
a real member's claims via `set local role`, so the privilege check is genuine and not a
faked claims GUC; it measures the member's row counts and points before and after and
requires them unchanged; it repeats with no session at all (`anon`); it confirms the
primary administrator's identical call still succeeds and lands in `admin_action_logs`
(no false positive); and it posts to the real `/rest/v1/rpc/` endpoint with the public anon
key, which returns `401 {"code":"42501","message":"permission denied for function …"}`.

Ten further functions take an arbitrary `p_user_id` with no `auth.uid()` check and are
**deliberately untouched**: they are the existing member gameplay flow
(`increment_theme_stage_progress`, `update_user_levels`, `complete_task`,
`award_milestone`, `approve_badge_stage`, …) and changing them changes member-facing
behaviour, which the standing contract forbids without approval. Their names, and the exact
pattern the newer functions already use, are recorded in `09-SECURITY-REMEDIATION.md` for
the next batch.

### 23.13 Phase A read layer (14 October 2026)

`sql/2026-10-14-13-ops-read-layer.sql`, applied live and proven by
`verification/apply_verify_migration13.py` (**73 PASS / 0 FAIL**). Full record:
`admin-crm/11-PHASE-A-READ-LAYER.md`.

Eight read RPCs, all `SECURITY DEFINER`, all returning JSONB, all gated by
`assert_admin_can` and all with EXECUTE revoked from `public` and `anon`:
`admin_get_dashboard_metrics`, `admin_get_activity_feed`, `admin_get_reflections`,
`admin_get_sigma_inbox`, `admin_get_ticket_history`, `admin_get_sla_stats`,
`admin_get_member_360` and `admin_get_fulfilment_queue`. Each is deliberately
coarse where one screen shows several domains: the dashboard, activity feed and
member 360 attach the billing, support, audit and health blocks only when the caller
also holds `billing.read`, `support.read`, `audit.read` or `health.read`, and shipping
addresses appear only for `fulfilment.manage`. The negative path for that last gate is
not measurable live (the single administrator is a super admin, so every permission
check returns true), so the verifier asserts the privileged path and proves the gate
from the function source (`pg_get_functiondef … like '%fulfilment.manage%'`) rather
than weakening the check.

Three real defects closed alongside it:

- **The review queue was permanently empty.** `member_reviews` held 0 rows while 3
  reflections and 9 sigma logs existed: `admin_sync_review_queue()` existed since
  migration 11 but nothing ever called it and no trigger fired, so the Review Centre
  could never show brief §6's new submissions. An `after insert` trigger on
  `task_sigma_logs` and `sigma_logs` now enqueues a review item, the existing rows were
  backfilled (12 queued), and the trigger's exception guard means a queue failure can
  never block a member's submission — stage 4 of the verifier submits a reflection as
  the member, sees exactly one queued item, then removes its own test rows.
- **SLA targets were never computed.** `sla_due_at` was set on 1 of 6 tickets and
  `first_response_at` on none, so every response-time figure was blank. A
  `before insert` trigger now derives `sla_due_at` from `app_config` keys
  `sla_hours_urgent|high|normal|low` (defaults 4/8/24/72 hours, editable by an
  administrator without a deploy) and the open tickets were backfilled.
- **The Rewards/Fulfilment role could not read its own module.**
  `fulfilment_manager` holds `recognition.approve` and `fulfilment.manage`, but the
  gift and recognition read RPCs guard on `recognition.read`, which it lacked — the
  role the superset brief creates for physical-gift fulfilment could not list gifts.
  Its permissions now include `recognition.read`.

### 23.14 The admin navigation and the Phase A screens

The sidebar is no longer a flat list. It is six collapsible groups (OVERVIEW, MEMBERS &
RECOGNITION, THE MEADOW, COMMUNICATIONS, CONTENT & BUSINESS, OPERATIONS) holding thirty-two
sections; the header buttons carry `aria-expanded`/`aria-controls`, the open state is
remembered per group, and the group hosting the active section is always rendered open, so a
deep link cannot land on a hidden entry. Grouping is presentational: every section id is in
`NAV_TARGETS` (`admin-crm/verification/verify_admin_module_graph.py` fails if one is missing).

A section exists only when the app can back it with real data. The brief's PollenPop, TRail /
Resources, FAQ & Knowledge Base, Feedback & Suggestions and Billing & Payments screens have no
data model yet and are therefore absent from the navigation rather than rendered dead.

**Dashboard** reads `admin_get_dashboard_metrics(p_from, p_to)` with 7/30/90-day presets and a
validated custom range, draws its charts from the RPC's `series[]`, and shows a role-gated
block as "Not available for your role" instead of a zero. Metric cards navigate through the
app's own `onNavigate` and are gated by `NAV_TARGETS`.

**Phase A screens**: Activity Feed (the live event stream, admin-action rows only to
`audit.read` holders), Reflections and Sigma Logs (with the full DMAIC drawer), Ticket History
(status/priority/overdue filters plus the `admin_get_sla_stats` strip), Physical Gift
Fulfilment (pipeline counts, low stock, addresses only to `fulfilment.manage`), and the
Member 360 drawer - one RPC, twelve tabs, outstanding-review counts, PII gated on
`fulfilment.manage`.

Two integration hazards are worth recording. First, linking the 360 drawer into the existing
member record would have closed an import cycle between `sections.jsx` and
`sections-phase-a.jsx`; the bundle still builds when that happens, so `React.lazy` +
`Suspense` is used and a dedicated verifier now fails on any cycle. Second, the existing member
drawer is write-capable (edit, set points, revoke completions, delete) while the 360 drawer is
read-only, so both are kept and the 360 view opens from the member record instead of replacing
it.

Verified 14 October 2026 by `verify_admin_module_graph.py` (5/0), `verify_admin_ui_wiring.py`
(90/0/0), `verify_guide_admin_section.py` (25/0), `verify_crm_payload_shapes.py` (25/0),
`verify_admin_rpc_path.py` (33/0), migrations 13/12/11/10/09/06/03/02/01 (73/34/137/24/46/20/
18/29/16 PASS, 0 FAIL), the reflections flow (6/6), `oxlint` 0 errors and `vite build` 0 -
581 checks PASS, 0 FAIL. See `admin-crm/12-PHASE-A-UI.md`.
