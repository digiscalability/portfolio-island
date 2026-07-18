# 🚀 Quick Start Deployment Guide

## Prerequisites Checklist

- [ ] Node.js 18+ installed
- [ ] npm or pnpm installed
- [ ] Firebase CLI installed (`npm install -g firebase-tools`)
- [ ] Git installed (optional)

---

## Step 1: Install Dependencies (5 minutes)

### Install frontend dependencies

```powershell
npm install
```

### Install Firebase Functions dependencies

```powershell
cd functions
npm install
cd ..
```

---

## Step 2: Create Firebase Project (10 minutes)

### 2.1 Create Project

1. Go to [Firebase Console](https://console.firebase.google.com/)
2. Click "Add project"
3. Enter project name: `digiscalability-life-island`
4. Disable Google Analytics (or enable if you want)
5. Click "Create project"

### 2.2 Enable Services

In Firebase Console, enable these services:

**Authentication:**

- Go to Authentication > Sign-in method
- Enable "Anonymous"
- Enable "Google" (optional)

**Firestore Database:**

- Go to Firestore Database
- Click "Create database"
- Start in "production mode"
- Choose your region (e.g., `us-central1`)

**Cloud Storage:**

- Go to Storage
- Click "Get started"
- Start in "production mode"

**Cloud Functions:**

- Already enabled by default

**Hosting:**

- Already enabled by default

---

## Step 3: Configure Firebase (10 minutes)

### 3.1 Login to Firebase CLI

```powershell
firebase login
```

### 3.2 Link Your Project

```powershell
firebase use --add
```

- Select your project from the list
- Use alias: `default`

### 3.3 Get Firebase Configuration

1. In Firebase Console, go to Project Settings (⚙️ icon)
2. Scroll down to "Your apps"
3. Click the Web icon `</>`
4. Register app name: "DigiScalability Life Island"
5. **Copy the firebaseConfig object**

### 3.4 Create .env.local File

```powershell
cp .env.example .env.local
```

Edit `.env.local` and paste your Firebase config:

```env
VITE_FIREBASE_API_KEY=AIzaSyXXXXXXXXXXXXXXXXXXXXXXXXX
VITE_FIREBASE_AUTH_DOMAIN=your-project.firebaseapp.com
VITE_FIREBASE_PROJECT_ID=your-project-id
VITE_FIREBASE_STORAGE_BUCKET=your-project.appspot.com
VITE_FIREBASE_MESSAGING_SENDER_ID=123456789
VITE_FIREBASE_APP_ID=1:123456789:web:xxxxx
VITE_FIREBASE_MEASUREMENT_ID=G-XXXXXXXXXX

# Leave this for now, we'll update it later
VITE_OWNER_UID=YOUR_OWNER_UID
```

---

## Step 4: Update Security Rules (5 minutes)

### 4.1 Get Your Owner UID

**Option A: Sign in first, then get UID**

1. Build and run the app locally (see Step 5)
2. Open the app in browser
3. Sign in with Google (if enabled) or it will sign in anonymously
4. Open browser console and run:

   ```javascript
   firebase.auth().currentUser.uid
   ```

5. Copy the UID

**Option B: Create a user in Firebase Console**

1. Go to Authentication > Users
2. Click "Add user"
3. Enter email and password
4. Copy the UID from the user list

### 4.2 Update Firestore Rules

Edit `firestore.rules` and replace `YOUR_OWNER_UID` with your actual UID:

```javascript
// Find this line (appears multiple times):
request.auth.uid == "YOUR_OWNER_UID"

// Replace with your actual UID:
request.auth.uid == "abc123xyz789yourActualUID"
```

### 4.3 Update Storage Rules

Edit `storage.rules` and replace `YOUR_OWNER_UID` with your actual UID.

### 4.4 Update .env.local

Add your UID to `.env.local`:

```env
VITE_OWNER_UID=abc123xyz789yourActualUID
```

---

## Step 5: Test Locally (10 minutes)

### 5.1 Generate Asset Manifest (Optional)

```powershell
npm run generate:manifest
```

### 5.2 Start Development Server

```powershell
npm run dev
```

Open browser to `http://localhost:5173`

**Expected Result:**

- 3D island loads
- You can move with WASD keys
- No Firebase errors in console

### 5.3 Test Firebase Functions Locally (Optional)

```powershell
npm run functions:serve
```

This starts the Firebase emulator at `http://localhost:5001`

---

## Step 6: Build for Production (5 minutes)

```powershell
npm run build
```

**Expected Output:**

```
✓ built in 3.45s
dist/index.html                   0.XX kB
dist/assets/index-XXXXX.js      514.XX kB
```

### Test Production Build Locally

```powershell
npm run preview
```

Open `http://localhost:4173` and verify everything works.

---

## Step 7: Deploy to Firebase (5 minutes)

### 7.1 Deploy Everything

```powershell
npm run deploy
```

This deploys:

- Hosting (your website)
- Functions (backend APIs)
- Firestore rules
- Storage rules

**Expected Output:**

```
✔ Deploy complete!

Project Console: https://console.firebase.google.com/project/your-project/overview
Hosting URL: https://your-project.web.app
```

### 7.2 Alternative: Deploy Separately

**Deploy only hosting:**

```powershell
npm run deploy:hosting
```

**Deploy only functions:**

```powershell
npm run deploy:functions
```

**Deploy only database rules:**

```powershell
firebase deploy --only firestore:rules
firebase deploy --only storage:rules
```

---

## Step 8: Configure Gemini AI (Optional, 10 minutes)

### 8.1 Get Gemini API Key

1. Go to [Google AI Studio](https://makersuite.google.com/app/apikey)
2. Click "Create API Key"
3. Copy the key

### 8.2 Set Function Config

```powershell
firebase functions:config:set gemini.apikey="YOUR_GEMINI_API_KEY"
```

### 8.3 Redeploy Functions

```powershell
npm run deploy:functions
```

Now the AI chat will work with actual Gemini responses!

---

## Step 9: Post-Deployment Verification (5 minutes)

### 9.1 Visit Your Site

Open: `https://your-project.web.app`

### 9.2 Test Features

- [ ] Island loads and renders
- [ ] Movement works (WASD)
- [ ] Zones are visible
- [ ] Click on zones to see interaction panels
- [ ] Chat window opens (press C)
- [ ] Feedback form works
- [ ] Appointment form works

### 9.3 Check Firebase Console

- [ ] Conversations appear in Firestore after chatting
- [ ] Feedback appears in Firestore after submission
- [ ] Appointments appear in Firestore after booking

---

## Step 10: Set Up Custom Domain (Optional, 15 minutes)

### 10.1 Add Domain in Firebase

1. Go to Hosting in Firebase Console
2. Click "Add custom domain"
3. Enter your domain (e.g., `island.yourdomain.com`)
4. Follow DNS setup instructions

### 10.2 Update DNS Records

Add the provided DNS records to your domain registrar:

- A record pointing to Firebase IP
- TXT record for verification

Wait 24-48 hours for DNS propagation.

---

## Troubleshooting

### Build Errors

**"Module not found"**

```powershell
rm -rf node_modules package-lock.json
npm install
```

**TypeScript errors**

```powershell
npm run build -- --force
```

### Deployment Errors

**"Functions failed to deploy"**

```powershell
cd functions
npm install
npm run build
cd ..
firebase deploy --only functions
```

**"Firestore rules syntax error"**

- Check `firestore.rules` for syntax errors
- Validate at: Firebase Console > Firestore > Rules

**"Permission denied"**

- Make sure you're logged in: `firebase login`
- Make sure you selected the right project: `firebase use your-project-id`

### Runtime Errors

**"Firebase not configured" warning**

- Check `.env.local` exists and has correct values
- Restart dev server after changing `.env.local`

**"CORS error" when calling functions**

- Functions include CORS headers by default
- If still errors, check browser console for actual error
- Make sure functions are deployed: `firebase deploy --only functions`

**"Permission denied" in Firestore**

- Check you updated `YOUR_OWNER_UID` in `firestore.rules`
- Redeploy rules: `firebase deploy --only firestore:rules`

---

## Quick Commands Reference

```powershell
# Development
npm run dev                    # Start dev server
npm run build                  # Build for production
npm run preview                # Preview production build

# Firebase Functions
npm run functions:serve        # Test functions locally
npm run functions:build        # Build functions
npm run functions:deploy       # Deploy only functions

# Deployment
npm run deploy                 # Deploy everything
npm run deploy:hosting         # Deploy only website
firebase deploy --only firestore:rules   # Deploy only Firestore rules

# Utilities
npm run generate:manifest      # Generate asset manifest
firebase emulators:start       # Start all emulators
firebase functions:log         # View function logs
```

---

## Next Steps

After deployment:

1. **Add Content**: Update zone descriptions in `Zones.ts`
2. **Add 3D Models**: Replace placeholder geometries with GLTF models
3. **Add Audio**: Add background music and sound effects
4. **Analytics**: Enable Firebase Analytics to track visitors
5. **SEO**: Add meta tags in `index.html`
6. **Social**: Add Open Graph tags for better social sharing

---

## Need Help?

- **Firebase Documentation**: <https://firebase.google.com/docs>
- **Three.js Documentation**: <https://threejs.org/docs>
- **Vite Documentation**: <https://vitejs.dev/guide>

---

**Estimated Total Time: 60-90 minutes**

Once completed, your DigiScalability Life Island will be live! 🎉
