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

let ready: Promise<{ db: Database; uid: string }> | null = null;

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
    const { initializeAppCheck, ReCaptchaV3Provider } = await import('firebase/app-check');
    initializeAppCheck(app, {
      provider: new ReCaptchaV3Provider(siteKey),
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
export function getFirebaseRealtime(): Promise<{ db: Database; uid: string }> {
  if (!ready) {
    ready = (async () => {
      const app: FirebaseApp = initializeApp(firebaseConfig);
      await maybeInitAppCheck(app);
      const cred = await signInAnonymously(getAuth(app));
      return { db: getDatabase(app), uid: cred.user.uid };
    })();
  }
  return ready;
}
