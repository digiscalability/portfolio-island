import { initializeApp, type FirebaseApp } from 'firebase/app';
import { getAuth, signInAnonymously } from 'firebase/auth';
import { getDatabase, type Database } from 'firebase/database';

// Public Firebase web config for the `life-island` project. The apiKey is a
// public client identifier (NOT a secret) — access is gated by the Realtime
// Database security rules (see database.rules.json), which only allow an
// authenticated user to write their OWN presence node.
const firebaseConfig = {
  apiKey: 'AIzaSyAJLMuOpBKZRdt7XHQ0HKmMBn_qEtZKb_s',
  authDomain: 'life-island.firebaseapp.com',
  databaseURL: 'https://life-island-default-rtdb.firebaseio.com',
  projectId: 'life-island',
  storageBucket: 'life-island.firebasestorage.app',
  messagingSenderId: '813194014051',
  appId: '1:813194014051:web:52ce78d5fd47354fdcf756',
};

let ready: Promise<{ app: FirebaseApp; db: Database; uid: string }> | null = null;

/**
 * App Check (env-gated). When VITE_APPCHECK_SITE_KEY is set at build time, every
 * Firebase request is attested with reCAPTCHA v3 so only the genuine web app —
 * not a scripted anonymous client hammering RTDB — can reach the backend. The
 * addon is dynamically imported so it costs nothing until configured.
 *
 * To turn it on (two console steps, then set the env var):
 *   1. Firebase console → App Check → register this web app with the
 *      reCAPTCHA v3 provider; copy the site key.
 *   2. App Check → Realtime Database → set enforcement to "Enforced".
 *   3. Set VITE_APPCHECK_SITE_KEY=<site key> in the Vercel project env + local
 *      .env, then redeploy. Until enforcement is on, unattested requests are
 *      still allowed, so you can verify metrics before flipping the switch.
 */
async function maybeInitAppCheck(app: FirebaseApp): Promise<void> {
  const siteKey = (import.meta.env.VITE_APPCHECK_SITE_KEY as string | undefined)?.trim();
  if (!siteKey) return;
  try {
    // reCAPTCHA ENTERPRISE provider — the key is a score-based Enterprise key
    // (created via gcloud, registered with App Check via the REST API; free
    // tier 10k assessments/mo covers this site's traffic). Must stay in sync
    // with the provider type registered in App Check, or attestation fails
    // (which only degrades: unattested calls fall back / are rejected only
    // where enforcement is on).
    const { initializeAppCheck, ReCaptchaEnterpriseProvider } = await import('firebase/app-check');
    initializeAppCheck(app, {
      provider: new ReCaptchaEnterpriseProvider(siteKey),
      isTokenAutoRefreshEnabled: true,
    });
  } catch (e) {
    console.warn('App Check init skipped:', e);
  }
}

/**
 * Lazily initialise Firebase, sign in anonymously, and return the Realtime
 * Database handle + this session's uid. Cached so repeat callers share one
 * app/auth/connection.
 */
export function getFirebaseRealtime(): Promise<{ app: FirebaseApp; db: Database; uid: string }> {
  if (!ready) {
    ready = (async () => {
      const app: FirebaseApp = initializeApp(firebaseConfig);
      await maybeInitAppCheck(app);
      const cred = await signInAnonymously(getAuth(app));
      return { app, db: getDatabase(app), uid: cred.user.uid };
    })();
    // DO NOT CACHE A REJECTION. `if (!ready)` is false for a rejected promise,
    // so one transient failure — a blip during the idle subscribe window, an
    // anonymous-auth rate limit, a privacy blocker on the RTDB host — used to
    // disable the backend for the ENTIRE session: every later call re-rejected
    // instantly off the cached rejection, with no retry and no 'online'
    // re-arm. The visible symptom was the contact form failing forever. Clear
    // the cache on failure so the next caller gets a real attempt, and
    // re-throw so this attempt still reports the error.
    ready = ready.catch((e: unknown) => {
      ready = null;
      throw e;
    });
  }
  return ready;
}

/** The shared FirebaseApp (for callable Cloud Functions, etc.). */
export async function getFirebaseApp(): Promise<FirebaseApp> {
  return (await getFirebaseRealtime()).app;
}
