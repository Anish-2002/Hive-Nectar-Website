# Hive-Nectar — Project Map (Source of Truth)

> B.L.A.S.T. Protocol initialized. Protocol 0 complete.

## Project Context

Gamified sustainability/green productivity app ("The Meadow"). Users complete eco-themed tasks, earn nectar points, unlock badges/milestones, and progress through growth stages (Seed → Sprout → Bloom → Harvest).

## Data Schema

### Milestones (from Supabase `milestones` table)
```json
{
  "id": "number",
  "name": "string",
  "category": "nectar | tasks | membership | sigma | referrals | theme_token",
  "requirement_value": "number",
  "reward_type": "points | token",
  "reward_value": "string",
  "icon_url": "string (URL)",
  "description": "string"
}
```

### User Milestones (from Supabase `user_milestones` table)
```json
{
  "user_id": "UUID",
  "milestone_id": "number",
  "achieved_at": "timestamp",
  "viewed": "boolean"
}
```

## Current Status

- User can sign up with email (auto-confirm enabled)
- Profile page shows all 17 milestones — earned first, locked greyed out after
- Theme tokens (5 themes × 3 stages) not yet seeded in milestones table
- Badges table has 5 entries (KindHive, ZeroWaste Loop, EcoMind, GreenRhythm, SeedSower) but no icon_url set

## Behavioral Rules

- **Task unlocking**: One task per day. User must finish the previous task before the next unlocks.
- **Growth stages**: Seed → Sprout → Bloom → Harvest, tied to user tier.
- **Design**: Keep the existing bee/meadow/honey visual theme (golden gradients, earthy tones).
- **Auth**: Email-only signup (no OAuth). Auto-confirm enabled.
- **Tone**: Playful, nature-themed, bee colony metaphors (nectar points, hive, pollen, meadow).

## Integrations

| Service | Status | Notes |
|---------|--------|-------|
| Supabase | Active | Auth, DB, Storage (Badges bucket) |
| Stripe | Future | Replacing current free-tier upgrade flow |
| Wise | Potential | For payments if Stripe not suitable |
| Email | Future | Payment reminders, transactional emails |

## Delivery

- **Primary**: `hivernectar.earth` (web)
- **Secondary**: Mobile app (to be built)
- **Local dev**: `localhost:9090`

## Handoff Log

| Date | Context |
|------|---------|
| 2026-07-10 | Profile page achievements rewritten: all 17 milestones shown, earned first, locked greyed with unlock conditions. `getUnlockCondition()` helper. |
| 2026-07-10 | B.L.A.S.T. protocol initialized. Phase 1-3 complete: Blueprint, Link (Supabase verified), Architect (SOPs created). Next: Phase 4 Stylize / Phase 5 Trigger. |
