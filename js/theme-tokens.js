import { supabase } from './supabase-config.js';
import { showToast } from './app.js';

/**
 * Theme token award system.
 * Tokens reference data lives in the `tokens` table (seeded by SQL).
 * Earned tokens are stored in `user_tokens`.
 * Award logic runs server-side via `award_theme_tokens` RPC (called from `complete_task`).
 */

export function parseTokenMeta(description) {
    if (!description) return {};
    try {
        const parsed = JSON.parse(description);
        return typeof parsed === 'object' ? parsed : {};
    } catch {
        return {};
    }
}

/**
 * Fetch all token definitions from the `tokens` table
 */
export async function getAllTokenDefs() {
    const { data, error } = await supabase
        .from('tokens')
        .select('*')
        .order('theme_id')
        .order('stage');
    if (error) {
        console.warn('Could not fetch token defs:', error.message);
        return [];
    }
    return data || [];
}

/**
 * Fetch tokens the user has earned
 */
export async function getUserTokens(userId) {
    const { data, error } = await supabase
        .from('user_tokens')
        .select('token_id, awarded_at, viewed')
        .eq('user_id', userId);
    if (error) {
        console.warn('Could not fetch user tokens:', error.message);
        return [];
    }
    return data || [];
}

/**
 * Build a map of earned token_ids for quick lookup
 */
export async function getEarnedTokenMap(userId) {
    const tokens = await getUserTokens(userId);
    const map = {};
    tokens.forEach(t => { map[t.token_id] = { viewed: t.viewed, awarded_at: t.awarded_at }; });
    return map;
}

/**
 * Server-side token award check — runs the RPC that the complete_task
 * RPC already calls internally. Use this for initial-page-load catch-up.
 * Returns array of newly awarded token objects.
 */
export async function checkAndAwardThemeTokens(userId, updateBadgeFn) {
    if (!userId) return [];

    const { data, error } = await supabase.rpc('award_theme_tokens', {
        p_user_id: userId
    });

    if (error) {
        console.warn('Theme token award RPC failed:', error.message);
        return [];
    }

    const awarded = data || [];
    if (awarded.length) {
        awarded.forEach(t => {
            showToast(`🎁 New token: ${t.token_name} (${t.stage})`, 'success');
        });
        if (updateBadgeFn) await updateBadgeFn();
    }
    return awarded;
}

/**
 * Get per-theme task completion counts from user_tasks
 */
export async function getThemeCompletionCounts(userId) {
    const { data, error } = await supabase
        .from('user_tasks')
        .select('task_id, tasks ( core_theme, theme_id, stage )')
        .eq('user_id', userId);

    if (error) throw error;

    // Count per (theme_id, stage)
    const counts = {};
    (data || []).forEach((row) => {
        const themeId = row.tasks?.theme_id;
        const stage = row.tasks?.stage;
        if (!themeId) return;
        const key = `${themeId}::${stage}`;
        counts[key] = (counts[key] || 0) + 1;
    });
    return counts;
}

// ======================== DISPLAY HELPERS ========================

/**
 * Build a combined view: token definitions + user's earned status
 * Returns array of { id, name, theme_id, stage, tasks_required, icon_url,
 *                      description, earned, viewed, awarded_at }
 */
export async function buildTokenDisplayList(userId) {
    const [allTokens, earnedMap] = await Promise.all([
        getAllTokenDefs(),
        getEarnedTokenMap(userId)
    ]);

    return allTokens.map(t => ({
        ...t,
        earned: !!earnedMap[t.id],
        viewed: earnedMap[t.id]?.viewed ?? false,
        awarded_at: earnedMap[t.id]?.awarded_at ?? null
    }));
}

/**
 * Legacy display helpers for milestone-based achievements (unchanged)
 */
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
