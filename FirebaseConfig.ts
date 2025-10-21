// Firebase configuration
// Uses environment variables from .env.local file
// Copy .env.example to .env.local and fill in your values

export const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY || "YOUR_API_KEY",
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN || "YOUR_PROJECT_ID.firebaseapp.com",
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID || "YOUR_PROJECT_ID",
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET || "YOUR_PROJECT_ID.appspot.com",
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID || "YOUR_MESSAGING_SENDER_ID",
  appId: import.meta.env.VITE_FIREBASE_APP_ID || "YOUR_APP_ID",
  measurementId: import.meta.env.VITE_FIREBASE_MEASUREMENT_ID || "YOUR_MEASUREMENT_ID"
};

// Owner UID for security rules
export const OWNER_UID = import.meta.env.VITE_OWNER_UID || "YOUR_OWNER_UID";

// Validate configuration
if (firebaseConfig.apiKey === "YOUR_API_KEY") {
  console.warn(
    "⚠️ Firebase not configured! Copy .env.example to .env.local and add your Firebase credentials."
  );
}

