/**
 * Cloud Functions entrypoint.
 *
 * The original HTTP functions (askAI, scheduleAppointment, submitFeedback,
 * getAvailableSlots) were retired on 2026-07-27. They were leftovers from an
 * earlier portfolio concept, unused by the Life Island app, and exposed
 * unauthenticated open-CORS endpoints (askAI also called the paid Gemini API).
 * They have been deleted from production and removed here so a stray
 * `firebase deploy --only functions` cannot recreate them.
 *
 * This file is intentionally left export-free. Add new functions below —
 * e.g. a scheduled RTDB janitor to prune stale chat/voice/presence nodes.
 */

export {};
