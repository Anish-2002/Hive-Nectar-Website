# Live admin RPC signatures (generated)

Generated from `pg_proc` on the production project `gxboojbfmpejbjolfmjq` by
`dump_live_admin_sigs.py`. Do not hand-edit: rerun the script (117 functions).

`defaults` = trailing parameters carrying a DEFAULT, which PostgREST may omit.
`public` = PUBLIC still holds EXECUTE (an anon-key caller can reach the guard).

| function | arguments | defaults | returns | security | public |
|---|---|---|---|---|---|
| `add_admin` | `p_email text` | 0 | boolean | definer | no |
| `admin_accept_invitation` | `p_token text` | 0 | jsonb | definer | no |
| `admin_actor_email` | `p_user_id uuid` | 1 | text | definer | no |
| `admin_adjust_gift_stock` | `p_gift_id uuid, p_delta integer, p_kind text, p_note text` | 2 | jsonb | definer | no |
| `admin_adjust_nectar` | `p_user_id uuid, p_delta integer, p_reason text, p_category text` | 1 | jsonb | definer | no |
| `admin_advance_recognition` | `p_id uuid, p_status text, p_payload jsonb` | 1 | jsonb | definer | no |
| `admin_assign_review` | `p_id uuid, p_assignee uuid, p_reason text` | 2 | jsonb | definer | no |
| `admin_can` | `p_perm text, p_user_id uuid` | 1 | boolean | definer | no |
| `admin_create_ticket` | `p_ticket jsonb` | 0 | jsonb | definer | no |
| `admin_decide_recognition` | `p_id uuid, p_decision text, p_reason text` | 1 | jsonb | definer | no |
| `admin_delete_collab_invite` | `p_invite_id uuid` | 0 | jsonb | definer | no |
| `admin_delete_collaboration` | `p_collab_id uuid` | 0 | jsonb | definer | no |
| `admin_delete_communication` | `p_id uuid` | 0 | jsonb | definer | no |
| `admin_delete_config` | `p_key text` | 0 | jsonb | definer | no |
| `admin_delete_inquiry` | `p_inquiry_id uuid` | 0 | jsonb | definer | no |
| `admin_delete_milestone` | `p_milestone_id integer` | 0 | jsonb | definer | no |
| `admin_delete_setting` | `p_key text` | 0 | jsonb | definer | no |
| `admin_delete_sigma` | `p_sigma_id uuid` | 0 | jsonb | definer | no |
| `admin_delete_site_item` | `p_kind text, p_id text` | 0 | jsonb | definer | no |
| `admin_delete_support_template` | `p_id uuid` | 0 | jsonb | definer | no |
| `admin_delete_task` | `p_task_id uuid` | 0 | jsonb | definer | no |
| `admin_delete_theme` | `p_theme_id text` | 0 | jsonb | definer | no |
| `admin_delete_theme_progress` | `p_user_id uuid, p_theme_id text, p_stage text` | 0 | jsonb | definer | no |
| `admin_delete_token` | `p_token_id uuid` | 0 | jsonb | definer | no |
| `admin_delete_user` | `p_user_id uuid` | 0 | jsonb | definer | no |
| `admin_delete_user_milestone` | `p_user_id uuid, p_milestone_id integer` | 0 | jsonb | definer | no |
| `admin_delete_user_task` | `p_user_id uuid, p_task_id uuid` | 0 | jsonb | definer | no |
| `admin_delete_user_token` | `p_user_id uuid, p_token_id uuid` | 0 | jsonb | definer | no |
| `admin_get_action_logs` | `p_limit integer, p_action text, p_actor_id uuid, p_target_type text, p_target_id text, p_search text` | 6 | jsonb | definer | no |
| `admin_get_activity_feed` | `p_limit integer, p_from timestamp with time zone, p_to timestamp with time zone, p_kind text` | 4 | jsonb | definer | no |
| `admin_get_admins` | `-` | 0 | jsonb | definer | no |
| `admin_get_analytics` | `p_days integer` | 1 | jsonb | definer | no |
| `admin_get_audit_actions` | `-` | 0 | jsonb | definer | no |
| `admin_get_collab_invites` | `-` | 0 | jsonb | definer | no |
| `admin_get_collaborations` | `-` | 0 | jsonb | definer | no |
| `admin_get_communications` | `p_limit integer, p_offset integer` | 2 | jsonb | definer | no |
| `admin_get_config` | `-` | 0 | jsonb | definer | no |
| `admin_get_dashboard_metrics` | `p_from timestamp with time zone, p_to timestamp with time zone` | 2 | jsonb | definer | no |
| `admin_get_fulfilment_queue` | `p_status text, p_limit integer` | 2 | jsonb | definer | no |
| `admin_get_gift_stock_movements` | `p_gift_id uuid, p_limit integer` | 1 | jsonb | definer | no |
| `admin_get_gifts` | `p_search text, p_include_inactive boolean` | 2 | jsonb | definer | no |
| `admin_get_inquiries` | `-` | 0 | jsonb | definer | no |
| `admin_get_integration_health` | `-` | 0 | jsonb | definer | no |
| `admin_get_mail_outbox` | `p_status text, p_limit integer, p_offset integer` | 3 | jsonb | definer | no |
| `admin_get_member_360` | `p_user_id uuid` | 0 | jsonb | definer | no |
| `admin_get_member_subscription` | `p_user_id uuid` | 0 | jsonb | definer | no |
| `admin_get_milestones` | `-` | 0 | jsonb | definer | no |
| `admin_get_my_context` | `-` | 0 | jsonb | definer | no |
| `admin_get_my_pending_invitations` | `-` | 0 | jsonb | definer | no |
| `admin_get_nectar_ledger` | `p_user_id uuid, p_limit integer, p_offset integer` | 3 | jsonb | definer | no |
| `admin_get_notifications` | `p_user_id uuid, p_limit integer` | 2 | jsonb | definer | no |
| `admin_get_recognition` | `p_id uuid` | 0 | jsonb | definer | no |
| `admin_get_recognition_candidates` | `p_limit integer` | 1 | jsonb | definer | no |
| `admin_get_recognition_dashboard` | `-` | 0 | jsonb | definer | no |
| `admin_get_recognitions` | `p_status text, p_search text, p_limit integer, p_offset integer` | 4 | jsonb | definer | no |
| `admin_get_reflections` | `p_status text, p_limit integer, p_offset integer` | 3 | jsonb | definer | no |
| `admin_get_review_item` | `p_id uuid` | 0 | jsonb | definer | no |
| `admin_get_review_queue` | `p_status text, p_source text, p_search text, p_assignee uuid, p_limit integer, p_offset integer` | 6 | jsonb | definer | no |
| `admin_get_settings` | `-` | 0 | jsonb | definer | no |
| `admin_get_sigma_inbox` | `p_status text, p_limit integer, p_offset integer` | 3 | jsonb | definer | no |
| `admin_get_sigma_logs` | `-` | 0 | jsonb | definer | no |
| `admin_get_site_content` | `p_kind text` | 0 | jsonb | definer | no |
| `admin_get_sla_stats` | `p_from timestamp with time zone, p_to timestamp with time zone` | 2 | jsonb | definer | no |
| `admin_get_stats` | `-` | 0 | jsonb | definer | no |
| `admin_get_subscriptions` | `p_limit integer, p_offset integer` | 2 | jsonb | definer | no |
| `admin_get_support_templates` | `-` | 0 | jsonb | definer | no |
| `admin_get_tasks` | `-` | 0 | jsonb | definer | no |
| `admin_get_team_overview` | `-` | 0 | jsonb | definer | no |
| `admin_get_themes` | `-` | 0 | jsonb | definer | no |
| `admin_get_ticket` | `p_id uuid` | 0 | jsonb | definer | no |
| `admin_get_ticket_history` | `p_status text, p_priority text, p_limit integer, p_offset integer, p_overdue boolean` | 5 | jsonb | definer | no |
| `admin_get_tickets` | `p_status text, p_priority text, p_assignee uuid, p_search text, p_limit integer, p_offset integer` | 6 | jsonb | definer | no |
| `admin_get_tokens` | `-` | 0 | jsonb | definer | no |
| `admin_get_user` | `p_user_id uuid` | 0 | jsonb | definer | no |
| `admin_get_users` | `-` | 0 | jsonb | definer | no |
| `admin_import_inquiries` | `p_limit integer` | 1 | jsonb | definer | no |
| `admin_invite_admin` | `p_email text, p_role_key text, p_note text` | 1 | jsonb | definer | no |
| `admin_list_jar_decorations` | `-` | 0 | jsonb | definer | no |
| `admin_list_theme_progress` | `-` | 0 | jsonb | definer | no |
| `admin_list_user_milestones` | `-` | 0 | jsonb | definer | no |
| `admin_list_user_tasks` | `-` | 0 | jsonb | definer | no |
| `admin_list_user_tokens` | `-` | 0 | jsonb | definer | no |
| `admin_log_action` | `p_action text, p_target_type text, p_target_id text, p_reason text` | 3 | jsonb | definer | no |
| `admin_mail_flush_claim` | `p_ids uuid[], p_limit integer` | 2 | jsonb | definer | no |
| `admin_merge_ticket` | `p_target uuid, p_source uuid, p_reason text` | 1 | jsonb | definer | no |
| `admin_nominate_recognition` | `p_user_id uuid, p_gift_id uuid, p_reason text, p_evidence jsonb, p_review_id uuid` | 2 | jsonb | definer | no |
| `admin_ok` | `-` | 0 | boolean | definer | no |
| `admin_queue_test_email` | `p_to text` | 1 | jsonb | definer | no |
| `admin_reply_ticket` | `p_ticket_id uuid, p_body text, p_internal boolean, p_template_id uuid` | 2 | jsonb | definer | no |
| `admin_reply_to_member` | `p_id uuid, p_body text, p_channel text` | 1 | jsonb | definer | no |
| `admin_retry_mail` | `p_id uuid` | 0 | jsonb | definer | no |
| `admin_revoke_invitation` | `p_id uuid, p_reason text` | 1 | jsonb | definer | no |
| `admin_role_of` | `p_user_id uuid` | 1 | text | definer | no |
| `admin_save_communication` | `p_data jsonb` | 0 | jsonb | definer | no |
| `admin_save_config` | `p_key text, p_value text, p_description text` | 1 | jsonb | definer | no |
| `admin_save_gift` | `p_gift jsonb` | 0 | jsonb | definer | no |
| `admin_save_milestone` | `p_data jsonb` | 0 | jsonb | definer | no |
| `admin_save_setting` | `p_key text, p_value text` | 0 | jsonb | definer | no |
| `admin_save_site_item` | `p_kind text, p_data jsonb` | 0 | jsonb | definer | no |
| `admin_save_support_template` | `p_template jsonb` | 0 | jsonb | definer | no |
| `admin_save_task` | `p_data jsonb` | 0 | jsonb | definer | no |
| `admin_save_theme` | `p_data jsonb` | 0 | jsonb | definer | no |
| `admin_save_token` | `p_data jsonb` | 0 | jsonb | definer | no |
| `admin_send_member_notification` | `p_user_id uuid, p_title text, p_body text, p_link text, p_kind text` | 3 | jsonb | definer | no |
| `admin_set_gift_active` | `p_id uuid, p_is_active boolean` | 0 | jsonb | definer | no |
| `admin_set_member_tier` | `p_user_id uuid, p_member_tier integer, p_tier text` | 1 | jsonb | definer | no |
| `admin_set_message_delivery` | `p_message_id uuid, p_status text, p_provider_message_id text, p_error text` | 2 | jsonb | definer | no |
| `admin_set_points` | `p_user_id uuid, p_nectar integer, p_co2e numeric` | 1 | jsonb | definer | no |
| `admin_set_review_status` | `p_id uuid, p_status text, p_note text, p_reason text` | 2 | jsonb | definer | no |
| `admin_set_team_role` | `p_user_id uuid, p_role_key text, p_reason text` | 1 | jsonb | definer | no |
| `admin_set_team_status` | `p_user_id uuid, p_status text, p_reason text` | 1 | jsonb | definer | no |
| `admin_sync_review_queue` | `-` | 0 | jsonb | definer | no |
| `admin_update_inquiry` | `p_inquiry_id uuid, p_status text, p_notes text` | 1 | jsonb | definer | no |
| `admin_update_subscription` | `p_id text, p_data jsonb` | 0 | jsonb | definer | no |
| `admin_update_ticket` | `p_ticket jsonb` | 0 | jsonb | definer | no |
| `admin_update_user` | `p_user_id uuid, p_data jsonb` | 0 | jsonb | definer | no |
| `remove_admin` | `p_email text` | 0 | boolean | definer | no |
