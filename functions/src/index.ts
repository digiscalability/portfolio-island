/**
 * Cloud Functions entrypoint.
 *
 * The original HTTP functions (askAI, scheduleAppointment, submitFeedback,
 * getAvailableSlots) were retired on 2026-07-27 — unused, unauthenticated,
 * open-CORS leftovers (askAI also called the paid Gemini API).
 *
 * Two functions live here:
 *  - janitor: a scheduled backstop that prunes stale multiplayer nodes the
 *    client-side cleanup (onDisconnect + 12s TTL) can miss when a client dies
 *    before its onDisconnect registers, or a clock misbehaves.
 *  - onLeadCreated: emails the site owner when the contact form writes a new
 *    lead under leads/island (see the block at the bottom for setup + security).
 *
 * NOTE: deploying either provisions infra (janitor → Cloud Scheduler;
 *   onLeadCreated → an Eventarc RTDB trigger + a Secret Manager grant); do it in
 *   a supervised deploy. onLeadCreated needs its SMTP_PASSWORD secret + .env
 *   params to exist first (see below), or the deploy fails/blocks.
 *   firebase deploy --only functions --account digiscalability@gmail.com
 */

import { onSchedule } from 'firebase-functions/v2/scheduler';
import { onValueCreated } from 'firebase-functions/v2/database';
import { defineSecret, defineString } from 'firebase-functions/params';
import * as admin from 'firebase-admin';
import * as nodemailer from 'nodemailer';

admin.initializeApp();

const STALE_PRESENCE_MS = 2 * 60 * 1000; // 2 min without a heartbeat ⇒ dead client
const STALE_EPHEMERAL_MS = 60 * 1000; // chat/voice: client TTL is 12s, so 60s is safe

/** Remove children of `path` whose `t` timestamp is older than `maxAgeMs`. */
async function prune(
  db: admin.database.Database,
  path: string,
  now: number,
  maxAgeMs: number,
): Promise<number> {
  const snap = await db.ref(path).get();
  const val = snap.val() as Record<string, { t?: number }> | null;
  if (!val) return 0;
  const updates: Record<string, null> = {};
  for (const [key, entry] of Object.entries(val)) {
    const t = typeof entry?.t === 'number' ? entry.t : 0;
    if (now - t > maxAgeMs) updates[key] = null;
  }
  const count = Object.keys(updates).length;
  if (count) await db.ref(path).update(updates);
  return count;
}

export const janitor = onSchedule(
  {
    schedule: 'every 6 hours',
    region: 'us-central1',
    timeoutSeconds: 120,
    memory: '256MiB',
  },
  async () => {
    const db = admin.database();
    const now = Date.now();
    const [presence, chat, voice] = await Promise.all([
      prune(db, 'presence/island', now, STALE_PRESENCE_MS),
      prune(db, 'chat/island', now, STALE_EPHEMERAL_MS),
      prune(db, 'voice/island', now, STALE_EPHEMERAL_MS),
    ]);
    console.log(`janitor pruned presence=${presence} chat=${chat} voice=${voice}`);
  },
);

// ── Lead-notification email ─────────────────────────────────────────────────
// Fires when the island contact form (Boards.ts::submitLead) writes a new child
// under leads/island. Emails the site owner via provider-agnostic SMTP
// (Nodemailer): swapping Gmail → Resend → SendGrid → SES is an env change, never
// a code change (all connection values come from SMTP_*/LEAD_* config).
//
// Security (threat model applied): CRLF header sanitisation + server-side email
// re-validation (the client validator is untrusted); retry OFF + maxInstances
// cap; plain-text body only (no markup/beacon injection); TLS in transit; no
// PII/secrets in logs (only the URL-safe entryId); null/shape guard + swallow-
// and-return on error. No address is ever derived from lead data — from/to are
// operator config; the lead's address only lands in a re-validated Reply-To and
// the body.

// Secret (Google Secret Manager). Read with .value() INSIDE the handler only —
// .value() throws at deploy/module-load time.
const SMTP_PASSWORD = defineSecret('SMTP_PASSWORD');

// Non-secret operator config (functions/.env). Never sourced from lead data.
const SMTP_HOST = defineString('SMTP_HOST'); // e.g. smtp.gmail.com
const SMTP_PORT = defineString('SMTP_PORT'); // e.g. 465
const SMTP_USER = defineString('SMTP_USER'); // Gmail: the address; Resend: "resend"
const LEAD_FROM = defineString('LEAD_FROM'); // authorised sender address
const LEAD_TO = defineString('LEAD_TO'); // owner inbox

// Strip CR/LF + control chars from anything that touches a mail header.
const headerSafe = (v: unknown, max = 200): string =>
  String(v ?? '')
    .replace(/[\r\n]+/g, ' ')
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1F\x7F]/g, '')
    .trim()
    .slice(0, max);

// Strict single-address check — the client-side validator is not trusted.
const EMAIL_RE = /^[^\s@"'<>()[\]\\,;:]+@[^\s@"'<>()[\]\\,;:]+\.[^\s@"'<>()[\]\\,;:]+$/;

export const onLeadCreated = onValueCreated(
  {
    ref: '/leads/island/{entryId}',
    region: 'us-central1', // matches the life-island RTDB (…firebaseio.com = US)
    secrets: [SMTP_PASSWORD],
    retry: false, // no retry storm / duplicate-email storm
    maxInstances: 3, // cap concurrency = cap cost / inbox blast radius
    timeoutSeconds: 60,
    memory: '256MiB',
  },
  async (event) => {
    const entryId = event.params.entryId; // push key: URL-safe, no CRLF — log-safe

    // Null/shape guard — a partial write or delete-before-read yields null.
    const lead = event.data.val() as
      | { name?: unknown; email?: unknown; message?: unknown }
      | null;
    if (!lead || typeof lead !== 'object') {
      console.warn(`lead ${entryId} missing/invalid`); // entryId only, no PII
      return; // return, never throw
    }

    // Header-safe display name; server-re-validated reply-to.
    const email = String(lead.email ?? '').trim().slice(0, 254);
    const validReplyTo = EMAIL_RE.test(email) ? email : null;
    const name = headerSafe(lead.name, 80); // matches the ≤80 rule cap
    const message = String(lead.message ?? '').slice(0, 1000); // body: cap only

    const port = Number(SMTP_PORT.value()) || 465;
    const secure = port === 465; // 465 = implicit TLS; else STARTTLS
    const transporter = nodemailer.createTransport({
      host: SMTP_HOST.value(),
      port,
      secure,
      requireTLS: !secure, // enforce STARTTLS on 587 — never plaintext
      auth: { user: SMTP_USER.value(), pass: SMTP_PASSWORD.value() },
      // NEVER logger:true / debug:true in prod — it dumps the SMTP conversation.
    });

    try {
      await transporter.sendMail({
        // from is a fixed authorised address, not the lead's email.
        from: { name: 'Island Leads', address: LEAD_FROM.value() },
        to: LEAD_TO.value(), // operator config; no CC/BCC
        // address-object form → Nodemailer does RFC-2047/address encoding.
        replyTo: validReplyTo ? { name, address: validReplyTo } : undefined,
        subject: headerSafe(`New island lead from ${name || 'anonymous'}`, 150),
        // PLAIN TEXT only — no html: field, so no markup/beacon injection.
        text:
          `New lead (${entryId})\n` +
          `Name: ${name || '(blank)'}\n` +
          `Email: ${validReplyTo ?? '(invalid/blank)'}\n\n` +
          `Message:\n${message}\n`,
      });
      console.log(`lead ${entryId} email sent`); // entryId only, no PII
    } catch (err) {
      const e = err as { code?: string; message?: string };
      // Sanitised — no secrets, no PII, no full error object. The distinct
      // "ALERT lead-email-failed" marker is a stable match key for a Cloud
      // Logging log-based alert (see the header/README): with retry off + swallow,
      // the email IS the notification channel, so a systemic break (revoked app
      // password, bad SMTP config, outage) would otherwise silently drop every
      // lead. Leads still persist in RTDB and can be recovered from the console.
      console.error(`ALERT lead-email-failed ${entryId}`, { code: e.code, msg: e.message });
      return; // swallow — retry is off, the lead persists in RTDB
    }
  },
);
