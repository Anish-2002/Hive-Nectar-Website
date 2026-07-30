/**
 * Config helper — fetches settings from the app_config table in Supabase.
 * Caches in memory so it's only fetched once per page load.
 */
import { supabase } from './supabase-config.js';

let configCache = null;
let configPromise = null;

export async function getConfig(key) {
  if (!configCache) {
    if (!configPromise) {
      configPromise = (async () => {
        const { data, error } = await supabase.rpc('get_all_config');
        if (error) {
          console.warn('Failed to load config:', error.message);
          configCache = {};
        } else {
          configCache = typeof data === 'string' ? JSON.parse(data) : data;
        }
      })();
    }
    await configPromise;
  }
  return configCache?.[key] ?? null;
}

export async function getAllConfig() {
  if (!configCache) {
    const { data, error } = await supabase.rpc('get_all_config');
    if (error) {
      console.warn('Failed to load config:', error.message);
      configCache = {};
    } else {
      configCache = typeof data === 'string' ? JSON.parse(data) : data;
    }
  }
  return { ...configCache };
}

export function clearConfigCache() {
  configCache = null;
  configPromise = null;
}

/**
 * Send email via the send-email edge function.
 * Used by contact form, broadcast notifications, and welcome email.
 */
export async function sendEmail(to, subject, html) {
  const siteUrl = await getConfig('site_url') || 'https://hivernectar.earth';
  const functionUrl = `${siteUrl.replace(/\/$/, '')}/functions/v1/send-email`;

  try {
    const { data: { session } } = await supabase.auth.getSession();

    const response = await fetch(functionUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(session?.access_token && { 'Authorization': `Bearer ${session.access_token}` }),
      },
      body: JSON.stringify({ to, subject, html }),
    });

    const result = await response.json();
    if (!result.success) {
      console.warn('send-email returned:', result.message);
    }
    return result;
  } catch (err) {
    console.warn('send-email error:', err.message);
    return { success: false, message: err.message };
  }
}
