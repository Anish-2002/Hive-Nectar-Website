# Live admin RPC signatures

Ground truth pulled from the production project (`gxboojbfmpejbjolfmjq`) with
`pg_get_function_identity_arguments`. This is the contract the admin UI is built
against — argument names below are the JSON keys PostgREST expects (use these
exact names; a misspelled key is a silent 404 on the RPC).

> **Superseded for machine-checked use.** `05-LIVE-RPC-SIGNATURES.md` is generated from
> `pg_proc` by `verification/dump_live_admin_sigs.py` and is what the wiring verifier
> reads, so it cannot go stale. This page is the original hand-written inventory of the
> RPCs that existed before migrations 01 and 02; prefer the generated file.

Total: **44** functions at the time of writing (the live surface is now **51**: this
inventory plus the three communication RPCs from migration 01 and the four
subscription/analytics RPCs from migration 02). `secdef` = SECURITY DEFINER.

| function | arguments | returns | secdef | anon |
|---|---|---|---|---|
| `admin_delete_collab_invite` | `p_invite_id uuid` | jsonb | True | True |
| `admin_delete_collaboration` | `p_collab_id uuid` | jsonb | True | True |
| `admin_delete_communication` | `p_id uuid` | jsonb | True | False |
| `admin_delete_config` | `p_key text` | jsonb | True | True |
| `admin_delete_inquiry` | `p_inquiry_id uuid` | jsonb | True | True |
| `admin_delete_milestone` | `p_milestone_id integer` | jsonb | True | True |
| `admin_delete_sigma` | `p_sigma_id uuid` | jsonb | True | True |
| `admin_delete_task` | `p_task_id uuid` | jsonb | True | True |
| `admin_delete_theme` | `p_theme_id text` | jsonb | True | True |
| `admin_delete_theme_progress` | `p_user_id uuid, p_theme_id text, p_stage text` | jsonb | True | True |
| `admin_delete_token` | `p_token_id uuid` | jsonb | True | True |
| `admin_delete_user` | `p_user_id uuid` | jsonb | True | True |
| `admin_delete_user_milestone` | `p_user_id uuid, p_milestone_id integer` | jsonb | True | True |
| `admin_delete_user_task` | `p_user_id uuid, p_task_id uuid` | jsonb | True | True |
| `admin_delete_user_token` | `p_user_id uuid, p_token_id uuid` | jsonb | True | True |
| `admin_get_admins` | `-` | jsonb | True | True |
| `admin_get_collab_invites` | `-` | jsonb | True | True |
| `admin_get_collaborations` | `-` | jsonb | True | True |
| `admin_get_communications` | `p_limit integer, p_offset integer` | jsonb | True | False |
| `admin_get_config` | `-` | jsonb | True | True |
| `admin_get_inquiries` | `-` | jsonb | True | True |
| `admin_get_milestones` | `-` | jsonb | True | True |
| `admin_get_sigma_logs` | `-` | jsonb | True | True |
| `admin_get_stats` | `-` | jsonb | True | True |
| `admin_get_tasks` | `-` | jsonb | True | True |
| `admin_get_themes` | `-` | jsonb | True | True |
| `admin_get_tokens` | `-` | jsonb | True | True |
| `admin_get_user` | `p_user_id uuid` | jsonb | True | True |
| `admin_get_users` | `-` | jsonb | True | True |
| `admin_list_jar_decorations` | `-` | jsonb | True | True |
| `admin_list_theme_progress` | `-` | jsonb | True | True |
| `admin_list_user_milestones` | `-` | jsonb | True | True |
| `admin_list_user_tasks` | `-` | jsonb | True | True |
| `admin_list_user_tokens` | `-` | jsonb | True | True |
| `admin_ok` | `-` | boolean | True | True |
| `admin_save_communication` | `p_data jsonb` | jsonb | True | False |
| `admin_save_config` | `p_key text, p_value text, p_description text` | jsonb | True | True |
| `admin_save_milestone` | `p_data jsonb` | jsonb | True | True |
| `admin_save_task` | `p_data jsonb` | jsonb | True | True |
| `admin_save_theme` | `p_data jsonb` | jsonb | True | True |
| `admin_save_token` | `p_data jsonb` | jsonb | True | True |
| `admin_set_points` | `p_user_id uuid, p_nectar integer, p_co2e numeric` | jsonb | True | True |
| `admin_update_inquiry` | `p_inquiry_id uuid, p_status text, p_notes text` | jsonb | True | True |
| `admin_update_user` | `p_user_id uuid, p_data jsonb` | jsonb | True | True |

## Grouped by verb

**delete** (15)
- `admin_delete_collab_invite(p_invite_id uuid)`
- `admin_delete_collaboration(p_collab_id uuid)`
- `admin_delete_communication(p_id uuid)`
- `admin_delete_config(p_key text)`
- `admin_delete_inquiry(p_inquiry_id uuid)`
- `admin_delete_milestone(p_milestone_id integer)`
- `admin_delete_sigma(p_sigma_id uuid)`
- `admin_delete_task(p_task_id uuid)`
- `admin_delete_theme(p_theme_id text)`
- `admin_delete_theme_progress(p_user_id uuid, p_theme_id text, p_stage text)`
- `admin_delete_token(p_token_id uuid)`
- `admin_delete_user(p_user_id uuid)`
- `admin_delete_user_milestone(p_user_id uuid, p_milestone_id integer)`
- `admin_delete_user_task(p_user_id uuid, p_task_id uuid)`
- `admin_delete_user_token(p_user_id uuid, p_token_id uuid)`

**get** (14)
- `admin_get_admins()`
- `admin_get_collab_invites()`
- `admin_get_collaborations()`
- `admin_get_communications(p_limit integer, p_offset integer)`
- `admin_get_config()`
- `admin_get_inquiries()`
- `admin_get_milestones()`
- `admin_get_sigma_logs()`
- `admin_get_stats()`
- `admin_get_tasks()`
- `admin_get_themes()`
- `admin_get_tokens()`
- `admin_get_user(p_user_id uuid)`
- `admin_get_users()`

**list** (5)
- `admin_list_jar_decorations()`
- `admin_list_theme_progress()`
- `admin_list_user_milestones()`
- `admin_list_user_tasks()`
- `admin_list_user_tokens()`

**ok** (1)
- `admin_ok()`

**save** (6)
- `admin_save_communication(p_data jsonb)`
- `admin_save_config(p_key text, p_value text, p_description text)`
- `admin_save_milestone(p_data jsonb)`
- `admin_save_task(p_data jsonb)`
- `admin_save_theme(p_data jsonb)`
- `admin_save_token(p_data jsonb)`

**set** (1)
- `admin_set_points(p_user_id uuid, p_nectar integer, p_co2e numeric)`

**update** (2)
- `admin_update_inquiry(p_inquiry_id uuid, p_status text, p_notes text)`
- `admin_update_user(p_user_id uuid, p_data jsonb)`
