-- =============================================================================
-- THE MEADOW – Theme Token Milestones
-- Run this in Supabase SQL Editor after deploying token SVG assets.
-- Tokens appear in Achievements (milestones + user_milestones tables).
-- Unlock rule: complete N tasks in a theme (5 / 15 / 30).
-- =============================================================================

-- Optional helper columns (run if you want easier admin filtering in Supabase)
-- ALTER TABLE milestones ADD COLUMN IF NOT EXISTS token_code text;
-- ALTER TABLE milestones ADD COLUMN IF NOT EXISTS theme_slug text;

-- Remove old theme_token rows before re-seeding (safe to re-run)
DELETE FROM milestones WHERE category = 'theme_token';

INSERT INTO milestones (name, icon_url, category, requirement_value, description) VALUES
-- Connecting / Belonging (Roots)
('Roots Seed', 'assets/tokens/Connecting-Belonging/TE-001_RootsSeed.svg', 'theme_token', 5,
 '{"core_theme":"🌱 Connecting / Belonging","token_code":"TE-001","stage":"Seeds","tasks_required":5,"copy":"You showed up for belonging — five roots planted."}'),
('Roots Sprout', 'assets/tokens/Connecting-Belonging/TE-006_RootsSprout.svg', 'theme_token', 15,
 '{"core_theme":"🌱 Connecting / Belonging","token_code":"TE-006","stage":"Sprout","tasks_required":15,"copy":"Connection is growing — your roots are sprouting."}'),
('Roots Bloom', 'assets/tokens/Connecting-Belonging/TE-011_RootsBloom.svg', 'theme_token', 30,
 '{"core_theme":"🌱 Connecting / Belonging","token_code":"TE-011","stage":"Bloom","tasks_required":30,"copy":"Belonging in full bloom — sustained presence."}'),

-- Creating / Circularity (Forge)
('Forge Hands', 'assets/tokens/Creative/TE-002_ForgeHands.svg', 'theme_token', 5,
 '{"core_theme":"✨ Creating / Circularity","token_code":"TE-002","stage":"Seeds","tasks_required":5,"copy":"Five acts of making — hands on the forge."}'),
('Forge Shape', 'assets/tokens/Creative/TE-007_ForgeShape.svg', 'theme_token', 15,
 '{"core_theme":"✨ Creating / Circularity","token_code":"TE-007","stage":"Sprout","tasks_required":15,"copy":"Your craft is taking shape."}'),
('Forge Craft', 'assets/tokens/Creative/TE-012_ForgeCraft.svg', 'theme_token', 30,
 '{"core_theme":"✨ Creating / Circularity","token_code":"TE-012","stage":"Bloom","tasks_required":30,"copy":"Circularity mastered through repeated creation."}'),

-- Innovation / Shift (add Innovation tasks in Supabase with this core_theme)
('Shift Nudge', 'assets/tokens/Innovation/TE-003_ShiftNudge.svg', 'theme_token', 5,
 '{"core_theme":"💡 Innovation / Shift","token_code":"TE-003","stage":"Seeds","tasks_required":5,"copy":"Five small shifts — innovation begins with a nudge."}'),
('Shift Angle', 'assets/tokens/Innovation/TE-008_ShiftAngle.svg', 'theme_token', 15,
 '{"core_theme":"💡 Innovation / Shift","token_code":"TE-008","stage":"Sprout","tasks_required":15,"copy":"A new angle on familiar problems."}'),
('Shift Current', 'assets/tokens/Innovation/TE-013_ShiftCurrent.svg', 'theme_token', 30,
 '{"core_theme":"💡 Innovation / Shift","token_code":"TE-013","stage":"Bloom","tasks_required":30,"copy":"You ride the current of change."}'),

-- Acting / Motivating (Rhythm)
('Rhythm Beat', 'assets/tokens/Action-Motivating/TE-005_RhythmBeat.svg', 'theme_token', 5,
 '{"core_theme":"⚡ Acting / Motivating","token_code":"TE-005","stage":"Seeds","tasks_required":5,"copy":"Five beats of action — momentum starts here."}'),
('Rhythm Groove', 'assets/tokens/Action-Motivating/TE-010_RhythmGroove.svg', 'theme_token', 15,
 '{"core_theme":"⚡ Acting / Motivating","token_code":"TE-010","stage":"Sprout","tasks_required":15,"copy":"Action has found its groove."}'),
('Rhythm Ensemble', 'assets/tokens/Action-Motivating/TE-015_RhythmEnsemble.svg', 'theme_token', 30,
 '{"core_theme":"⚡ Acting / Motivating","token_code":"TE-015","stage":"Bloom","tasks_required":30,"copy":"Sustained motivation — leading the ensemble."}'),

-- Reflecting / Learning (Echo)
('Echo Signal', 'assets/tokens/Reflective/TE-004_EchoSignal.svg', 'theme_token', 5,
 '{"core_theme":"🌙 Reflecting / Learning","token_code":"TE-004","stage":"Seeds","tasks_required":5,"copy":"Five moments of reflection — a signal received."}'),
('Echo Resonance', 'assets/tokens/Reflective/TE-009_EchoResonance.svg', 'theme_token', 15,
 '{"core_theme":"🌙 Reflecting / Learning","token_code":"TE-009","stage":"Sprout","tasks_required":15,"copy":"Learning resonates deeper."}'),
('Echo Still', 'assets/tokens/Reflective/TE-014_EchoStill.svg', 'theme_token', 30,
 '{"core_theme":"🌙 Reflecting / Learning","token_code":"TE-014","stage":"Bloom","tasks_required":30,"copy":"Stillness earned through sustained reflection."}');

-- =============================================================================
-- RLS (if client-side award insert fails, add this policy in Supabase):
-- CREATE POLICY "users_insert_own_milestones" ON user_milestones
--   FOR INSERT TO authenticated
--   WITH CHECK (auth.uid() = user_id);
--
-- NEXT STEPS
-- 1. Deploy assets/tokens/ with your static site (GitHub Pages / hivenectar.earth)
-- 2. Ensure tasks.core_theme matches the JSON core_theme values exactly
-- 3. Add Innovation tasks (core_theme: 💡 Innovation / Shift) if not in DB yet
-- 4. Edit copy/tasks_required in milestones rows anytime via Supabase Table Editor
-- 5. Optional: move award logic into check_and_award_milestones RPC (server-side)
-- =============================================================================
