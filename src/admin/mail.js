import { supabase, SUPABASE_URL } from '../lib/supabase.js';

/**
 * The transmission leg of the CRM mail pipeline.
 *
 * The database owns the queue (mail_outbox) and the permissions; the edge
 * function `send-mail` owns nothing but the Brevo call. This module is the only
 * place the admin UI talks to it, so every screen reports delivery the same way.
 *
 * Why the session token is forwarded: the function asks the DATABASE whether the
 * caller may send mail (admin_mail_flush_claim is gated on the same admin
 * permissions as the reply screens). Nothing is decided in the browser, and a
 * signed-out caller is refused with the server's own message rather than a
 * cheerful fake success.
 */
export async function flushMail(ids = null, limit = 10) {
  const { data: sessionData } = await supabase.auth.getSession();
  const token = sessionData?.session?.access_token;
  if (!token) {
    throw new Error('Not signed in — sign in to the admin portal before sending mail.');
  }

  const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY || '';
  const headers = {
    'content-type': 'application/json',
    Authorization: `Bearer ${token}`,
  };
  if (anonKey) headers.apikey = anonKey;

  let res;
  try {
    res = await fetch(`${SUPABASE_URL}/functions/v1/send-mail`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ ids: ids && ids.length ? ids : null, limit }),
    });
  } catch (e) {
    throw new Error(`Could not reach the mail function: ${e.message}`);
  }

  const body = await res.text();
  let payload = null;
  try {
    payload = body ? JSON.parse(body) : null;
  } catch {
    payload = null;
  }

  if (!payload) {
    throw new Error(`send-mail ${res.status}: ${body.slice(0, 200) || 'empty response'}`);
  }
  return { httpStatus: res.status, ...payload };
}

/** Human line for a flush result. Never says "sent" unless a row came back sent. */
export function mailSummary(result) {
  if (!result) return 'No mail result returned.';
  if (result.error) {
    return `${result.error}${result.detail ? ` — ${result.detail}` : ''}`;
  }
  const rows = Array.isArray(result.results) ? result.results : [];
  const sent = rows.filter((r) => r.status === 'sent');
  const bad = rows.filter((r) => r.status !== 'sent');
  if (sent.length && !bad.length) {
    const id = sent[0].provider_message_id;
    return `Email sent${id ? ` (Brevo id ${id})` : ''}`;
  }
  if (bad.length) {
    const b = bad[0];
    return `Email NOT sent — ${b.error || b.record_error || b.status}`;
  }
  if (result.processed === 0) return result.message || 'Nothing to send.';
  return `${result.sent ?? 0} sent, ${result.failed ?? 0} failed`;
}

export function mailTone(result) {
  if (!result) return 'error';
  if (result.error) return 'error';
  const rows = Array.isArray(result.results) ? result.results : [];
  if (!rows.length) return 'ok';
  return rows.every((r) => r.status === 'sent' && r.recorded !== false) ? 'ok' : 'error';
}

/**
 * Try to transmit one just-queued message and describe what really happened.
 * Delivery problems are returned, not thrown: the reply itself is already
 * recorded in-app and must not be lost because the mail leg failed.
 */
export async function sendQueuedMail(mailId) {
  if (!mailId) {
    return { message: 'No email was queued for this message.', tone: 'error', result: null, row: null };
  }
  try {
    const result = await flushMail([mailId], 1);
    return {
      message: mailSummary(result),
      tone: mailTone(result),
      result,
      // The row's own recorded state — 'sent' only when the provider answered.
      row: (Array.isArray(result.results) ? result.results[0] : null) || null,
    };
  } catch (e) {
    return { message: `Email not sent — ${e.message}`, tone: 'error', result: null, row: null };
  }
}

/** Queue status reported by the reply RPCs, for when nothing was even queued. */
export function queueLine(payload, statusKey = 'delivery_status') {
  const status = payload?.[statusKey] || 'unknown';
  const reason = payload?.error;
  return `Email not queued (${status})${reason ? ` — ${reason}` : ''}`;
}
