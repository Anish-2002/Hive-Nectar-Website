import { createClient } from '@supabase/supabase-js';

// Keys come from .env — see .env.example. Same project as the live site.
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || 'https://gxboojbfmpejbjolfmjq.supabase.co';
const supabaseKey = import.meta.env.VITE_SUPABASE_ANON_KEY || '';

// The edge functions live on the Supabase host, NOT on the website domain —
// export it so callers (e.g. sendEmail) build the right URL.
export const SUPABASE_URL = supabaseUrl;

// Never throw at import time (that kills the whole app on a missing key).
// If the anon key is absent, auth calls fail with a clear message instead.
export const supabase = supabaseKey
  ? createClient(supabaseUrl, supabaseKey)
  : new Proxy(
      {},
      {
        get() {
          return () => {
            throw new Error(
              'Supabase not configured: copy .env.example to .env and set VITE_SUPABASE_ANON_KEY (see README.md).'
            );
          };
        },
      }
    );

// ── Config helper — mirrors js/config.js on the vanilla site ──
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
  if (!configCache) await getConfig();
  return { ...configCache };
}

export function clearConfigCache() {
  configCache = null;
  configPromise = null;
}

// ── sendEmail via edge function — mirrors js/config.js ──
export async function sendEmail(to, subject, html) {
  // Edge functions are served by the Supabase project, not the website domain —
  // using site_url here pointed the request at the marketing host and got a 404.
  const functionUrl = `${SUPABASE_URL.replace(/\/$/, '')}/functions/v1/send-email`;
  try {
    const { data: { session } } = await supabase.auth.getSession();
    const response = await fetch(functionUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(session?.access_token && { Authorization: `Bearer ${session.access_token}` }),
      },
      body: JSON.stringify({ to, subject, html }),
    });
    const result = await response.json();
    if (!result.success) console.warn('send-email returned:', result.message);
    return result;
  } catch (err) {
    console.warn('send-email error:', err.message);
    return { success: false, message: err.message };
  }
}
