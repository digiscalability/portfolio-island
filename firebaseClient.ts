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
 * Lazily initialise Firebase, sign in anonymously, and return the Realtime
 * Database handle + this session's uid. Cached so repeat callers share one
 * app/auth/connection.
 */
export function getFirebaseRealtime(): Promise<{ db: Database; uid: string }> {
  if (!ready) {
    ready = (async () => {
      const app: FirebaseApp = initializeApp(firebaseConfig);
      const cred = await signInAnonymously(getAuth(app));
      return { db: getDatabase(app), uid: cred.user.uid };
    })();
  }
  return ready;
}
