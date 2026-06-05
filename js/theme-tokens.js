import { supabase } from './supabase-config.js';
import { showToast } from './app.js';

/**
 * Theme token definitions – icons live in /assets/tokens/
 * First token unlocks at 5 completed tasks per theme, then 15 and 30.
 */
export const THEME_TOKEN_DEFINITIONS = [
    {
        core_theme: '🌱 Connecting / Belonging',
        theme_slug: 'connecting-belonging',
        tokens: [
            { code: 'TE-001', name: 'Roots Seed', stage: 'Seeds', tasks_required: 5, icon: 'assets/tokens/Connecting-Belonging/TE-001_RootsSeed.svg', description: 'You showed up for belonging — five roots planted.' },
            { code: 'TE-006', name: 'Roots Sprout', stage: 'Sprout', tasks_required: 15, icon: 'assets/tokens/Connecting-Belonging/TE-006_RootsSprout.svg', description: 'Connection is growing — your roots are sprouting.' },
            { code: 'TE-011', name: 'Roots Bloom', stage: 'Bloom', tasks_required: 30, icon: 'assets/tokens/Connecting-Belonging/TE-011_RootsBloom.svg', description: 'Belonging in full bloom — sustained presence.' }
        ]
    },
    {
        core_theme: '✨ Creating / Circularity',
        theme_slug: 'creative',
        tokens: [
            { code: 'TE-002', name: 'Forge Hands', stage: 'Seeds', tasks_required: 5, icon: 'assets/tokens/Creative/TE-002_ForgeHands.svg', description: 'Five acts of making — hands on the forge.' },
            { code: 'TE-007', name: 'Forge Shape', stage: 'Sprout', tasks_required: 15, icon: 'assets/tokens/Creative/TE-007_ForgeShape.svg', description: 'Your craft is taking shape.' },
            { code: 'TE-012', name: 'Forge Craft', stage: 'Bloom', tasks_required: 30, icon: 'assets/tokens/Creative/TE-012_ForgeCraft.svg', description: 'Circularity mastered through repeated creation.' }
        ]
    },
    {
        core_theme: '💡 Innovation / Shift',
        theme_slug: 'innovation',
        tokens: [
            { code: 'TE-003', name: 'Shift Nudge', stage: 'Seeds', tasks_required: 5, icon: 'assets/tokens/Innovation/TE-003_ShiftNudge.svg', description: 'Five small shifts — innovation begins with a nudge.' },
            { code: 'TE-008', name: 'Shift Angle', stage: 'Sprout', tasks_required: 15, icon: 'assets/tokens/Innovation/TE-008_ShiftAngle.svg', description: 'A new angle on familiar problems.' },
            { code: 'TE-013', name: 'Shift Current', stage: 'Bloom', tasks_required: 30, icon: 'assets/tokens/Innovation/TE-013_ShiftCurrent.svg', description: 'You ride the current of change.' }
        ]
    },
    {
        core_theme: '⚡ Acting / Motivating',
        theme_slug: 'action-motivating',
        tokens: [
            { code: 'TE-005', name: 'Rhythm Beat', stage: 'Seeds', tasks_required: 5, icon: 'assets/tokens/Action-Motivating/TE-005_RhythmBeat.svg', description: 'Five beats of action — momentum starts here.' },
            { code: 'TE-010', name: 'Rhythm Groove', stage: 'Sprout', tasks_required: 15, icon: 'assets/tokens/Action-Motivating/TE-010_RhythmGroove.svg', description: 'Action has found its groove.' },
            { code: 'TE-015', name: 'Rhythm Ensemble', stage: 'Bloom', tasks_required: 30, icon: 'assets/tokens/Action-Motivating/TE-015_RhythmEnsemble.svg', description: 'Sustained motivation — leading the ensemble.' }
        ]
    },
    {
        core_theme: '🌙 Reflecting / Learning',
        theme_slug: 'reflective',
        tokens: [
            { code: 'TE-004', name: 'Echo Signal', stage: 'Seeds', tasks_required: 5, icon: 'assets/tokens/Reflective/TE-004_EchoSignal.svg', description: 'Five moments of reflection — a signal received.' },
            { code: 'TE-009', name: 'Echo Resonance', stage: 'Sprout', tasks_required: 15, icon: 'assets/tokens/Reflective/TE-009_EchoResonance.svg', description: 'Learning resonates deeper.' },
            { code: 'TE-014', name: 'Echo Still', stage: 'Bloom', tasks_required: 30, icon: 'assets/tokens/Reflective/TE-014_EchoStill.svg', description: 'Stillness earned through sustained reflection.' }
        ]
    }
];

export function parseTokenMeta(description) {
    if (!description) return {};
    try {
        const parsed = JSON.parse(description);
        return typeof parsed === 'object' ? parsed : {};
    } catch {
        return {};
    }
}

export async function getThemeCompletionCounts(userId) {
    const { data, error } = await supabase
        .from('user_tasks')
        .select('task_id, tasks ( core_theme, theme_id )')
        .eq('user_id', userId);

    if (error) throw error;

    const counts = {};
    (data || []).forEach((row) => {
        const coreTheme = row.tasks?.core_theme;
        if (!coreTheme) return;
        counts[coreTheme] = (counts[coreTheme] || 0) + 1;
    });
    return counts;
}

/**
 * Awards theme tokens via milestones table (category = theme_token).
 * Run the SQL seed in supabase/seed_theme_tokens.sql first.
 */
export async function checkAndAwardThemeTokens(userId, updateBadgeFn) {
    if (!userId) return [];

    const awarded = [];

    try {
        const [counts, milestonesRes, userMilestonesRes] = await Promise.all([
            getThemeCompletionCounts(userId),
            supabase.from('milestones').select('*').eq('category', 'theme_token'),
            supabase.from('user_milestones').select('milestone_id').eq('user_id', userId)
        ]);

        if (milestonesRes.error) {
            console.warn('Theme token milestones not loaded:', milestonesRes.error.message);
            return awarded;
        }

        const earnedIds = new Set((userMilestonesRes.data || []).map((row) => row.milestone_id));
        const milestones = milestonesRes.data || [];

        for (const milestone of milestones) {
            const meta = parseTokenMeta(milestone.description);
            const coreTheme = meta.core_theme;
            const tasksRequired = milestone.requirement_value || meta.tasks_required || 5;
            if (!coreTheme) continue;

            const completed = counts[coreTheme] || 0;
            if (completed < tasksRequired || earnedIds.has(milestone.id)) continue;

            const { error: insertError } = await supabase.from('user_milestones').insert({
                user_id: userId,
                milestone_id: milestone.id,
                viewed: false
            });

            if (insertError) {
                console.warn('Could not award theme token:', insertError.message);
                continue;
            }

            earnedIds.add(milestone.id);
            awarded.push(milestone);
            showToast(`🏆 Token unlocked: ${milestone.name}`, 'success');
        }

        if (awarded.length && updateBadgeFn) {
            await updateBadgeFn();
        }
    } catch (err) {
        console.error('Theme token award failed:', err);
    }

    return awarded;
}

export function getAchievementSubtext(milestone) {
    if (milestone.category === 'theme_token') {
        const meta = parseTokenMeta(milestone.description);
        const stage = meta.stage || 'Token';
        const theme = (meta.core_theme || '').replace(/^[^\s]+\s/, '');
        return `${stage} · ${theme || 'Theme Token'}`;
    }
    const categoryLabel = milestone.category.charAt(0).toUpperCase() + milestone.category.slice(1);
    return `${categoryLabel} Milestone ${milestone.requirement_value}`;
}

export function getMilestoneDisplayDescription(milestone) {
    const meta = parseTokenMeta(milestone.description);
    if (meta.copy) return meta.copy;
    if (typeof milestone.description === 'string' && !milestone.description.startsWith('{')) {
        return milestone.description;
    }
    return 'Great achievement!';
}
