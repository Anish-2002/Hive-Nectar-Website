import { supabase } from '../lib/supabase.js';

/**
 * Thin wrapper over the admin_* RPCs.
 *
 * Every admin RPC follows one contract: SECURITY DEFINER, gated inside by
 * admin_ok(), returning { success: boolean, data?: ..., error?: string }.
 *
 * Callers must never query tables directly. Row level security on these tables
 * exposes a member's own row only, so a direct `.from()` read in an admin page
 * silently returns the wrong thing (or nothing) instead of failing loudly.
 * That is exactly how the previous admin pages came to be broken.
 */
export async function rpc(name, args = {}) {
  const { data, error } = await supabase.rpc(name, args);
  if (error) throw new Error(`${name}: ${error.message}`);
  const payload = typeof data === 'string' ? JSON.parse(data) : data;
  if (payload && typeof payload === 'object' && payload.success === false) {
    throw new Error(payload.error || `${name} refused the operation`);
  }
  return payload;
}

/** List-shaped RPCs return `data` as an array; anything else yields []. */
export function rows(payload) {
  return Array.isArray(payload?.data) ? payload.data : [];
}

/** Raw object payloads (admin_get_user, admin_get_stats). */
export function obj(payload) {
  return payload?.data && typeof payload.data === 'object' && !Array.isArray(payload.data)
    ? payload.data
    : {};
}

/**
 * The roles / audit / invitation RPCs return their payload unwrapped, so that a
 * screen can ask for exactly the shape it needs (a team overview is not a list
 * of rows). Both accessors below normalise those shapes.
 */
export function raw(payload) {
  return payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
}

export function rawList(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.data)) return payload.data;
  return [];
}

export const fmtDate = (value) => {
  if (!value) return '—';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? String(value) : d.toLocaleString();
};

export const fmtDay = (value) => {
  if (!value) return '—';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? String(value) : d.toLocaleDateString();
};

export const text = (value) => {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
};

/**
 * Send only the keys the admin actually filled in.
 *
 * The save RPCs use COALESCE(p_data->>'k', column), which treats an omitted key
 * as "leave alone" — an empty string is NOT ignored, it would be written. So a
 * blank form field must be dropped rather than sent as ''.
 */
export function cleanPayload(values) {
  const out = {};
  for (const [k, v] of Object.entries(values)) {
    if (v === undefined || v === null) continue;
    if (typeof v === 'boolean') { out[k] = v; continue; }
    if (typeof v === 'string' && v.trim() === '') continue;
    out[k] = v;
  }
  return out;
}

/** 'Mirror Key.svg' -> 'mirror-key.svg' (stable, URL-safe, extension kept). */
export function slugifyFile(name, fallback = 'asset') {
  const raw = String(name || '');
  const dot = raw.lastIndexOf('.');
  const ext = dot > 0 ? raw.slice(dot + 1).toLowerCase().replace(/[^a-z0-9]/g, '') : 'png';
  const base = (dot > 0 ? raw.slice(0, dot) : raw)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return `${base || fallback}.${ext || 'png'}`;
}

/**
 * Upload a file to a public Storage bucket and return its public URL.
 *
 * The write is authorised by the bucket's own admin policy (gated on
 * storage_admin(), i.e. the signed-in user is in admin_users). Nothing here
 * holds a privileged key — an unauthorised session is refused by the database,
 * not by client-side code. The returned URL is the same shape the member site
 * already stores in icon_url / thumbnail_url / file_url.
 */
export async function uploadPublic(bucket, path, file) {
  const { error } = await supabase.storage
    .from(bucket)
    .upload(path, file, { upsert: true, cacheControl: '3600', contentType: file.type || undefined });
  if (error) throw new Error(`${bucket}: ${error.message}`);
  const { data } = supabase.storage.from(bucket).getPublicUrl(path);
  return data.publicUrl;
}
