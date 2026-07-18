# Firebase Deployment Guide

This guide provides step-by-step instructions for deploying the DigiScalability Life Island project to Firebase.

## Prerequisites

Before deploying, ensure you have:

1. **Node.js 18+** installed
2. **Firebase CLI** installed globally: `npm install -g firebase-tools`
3. **A Firebase project** created at <https://console.firebase.google.com/>
4. **Project dependencies** installed: `pnpm install` and `cd functions && npm install`

## Step 1: Firebase Project Setup

### 1.1 Create a Firebase Project

1. Go to <https://console.firebase.google.com/>
2. Click "Add project"
3. Enter a project name (e.g., "digiscalability-life-island")
4. Follow the setup wizard
5. Note your **Project ID** (you'll need this later)

### 1.2 Enable Required Services

In the Firebase Console, enable the following services:

**Authentication**

- Go to Authentication > Sign-in method
- Enable "Anonymous" provider
- Enable "Google" provider (optional)

**Firestore Database**

- Go to Firestore Database
- Click "Create database"
- Start in production mode
- Choose a location close to your users

**Cloud Functions**

- Functions will be automatically set up when you deploy
- Upgrade to Blaze (pay-as-you-go) plan if needed for external API calls

**Cloud Storage**

- Go to Storage
- Click "Get started"
- Use production mode
- Choose the same location as Firestore

**Firebase Hosting**

- Go to Hosting
- Click "Get started"
- Follow the setup wizard

**Firebase Analytics** (Optional)

- Go to Analytics
- Enable Google Analytics for your project

## Step 2: Configure Your Local Project

### 2.1 Login to Firebase CLI

```bash
firebase login
```

This will open a browser window for authentication.

### 2.2 Set Your Firebase Project

```bash
firebase use your-project-id
```

Or update `.firebaserc`:

```json
{
  "projects": {
    "default": "your-project-id"
  }
}
```

### 2.3 Get Firebase Configuration

1. Go to Firebase Console > Project Settings
2. Scroll down to "Your apps"
3. Click the web icon (</>)
4. Register your app
5. Copy the configuration object

### 2.4 Update Firebase Config in Code

Edit `src/core/FirebaseConfig.ts`:

```typescript
export const firebaseConfig = {
  apiKey: "AIza...",
  authDomain: "your-project-id.firebaseapp.com",
  projectId: "your-project-id",
  storageBucket: "your-project-id.appspot.com",
  messagingSenderId: "123456789",
  appId: "1:123456789:web:abc123",
  measurementId: "G-XXXXXXXXXX"
};
```

### 2.5 Update Security Rules

**Firestore Rules** (`firestore.rules`):

- Replace `YOUR_OWNER_UID` with your actual Firebase Auth UID
- To get your UID: Go to Authentication > Users after you sign in

**Storage Rules** (`storage.rules`):

- Replace `YOUR_OWNER_UID` with your actual Firebase Auth UID

## Step 3: Configure Firebase Functions

### 3.1 Install Functions Dependencies

```bash
cd functions
npm install
cd ..
```

### 3.2 Set Up Gemini API (Optional)

If you want to enable AI chat functionality:

1. Get a Gemini API key from <https://makersuite.google.com/app/apikey>
2. Set the config:

```bash
firebase functions:config:set gemini.apikey="YOUR_GEMINI_API_KEY"
```

### 3.3 Update Functions Code (Optional)

Edit `functions/src/index.ts` to uncomment and configure the Gemini API integration in the `askAI` function.

## Step 4: Build the Project

```bash
pnpm build
```

This will:

1. Compile TypeScript to JavaScript
2. Bundle the application with Vite
3. Output to the `dist/` directory

Verify the build succeeded and check the `dist/` folder.

## Step 5: Deploy to Firebase

### 5.1 Deploy Everything

```bash
firebase deploy
```

This deploys:

- Hosting (your website)
- Functions (backend API)
- Firestore rules
- Storage rules

### 5.2 Deploy Specific Services

You can also deploy services individually:

**Hosting only:**

```bash
firebase deploy --only hosting
```

**Functions only:**

```bash
firebase deploy --only functions
```

**Firestore rules only:**

```bash
firebase deploy --only firestore:rules
```

**Storage rules only:**

```bash
firebase deploy --only storage:rules
```

### 5.3 Monitor Deployment

Watch the console output for:

- ✓ Deploy complete!
- Hosting URL: <https://your-project-id.web.app>

## Step 6: Post-Deployment Configuration

### 6.1 Set Up Custom Domain (Optional)

1. Go to Hosting > Add custom domain
2. Follow the instructions to verify domain ownership
3. Add DNS records as instructed
4. Wait for SSL certificate provisioning (can take up to 24 hours)

### 6.2 Configure CORS for Functions

If you encounter CORS issues, ensure your functions have proper CORS headers (already included in the template).

### 6.3 Test Your Deployment

1. Visit your Hosting URL: `https://your-project-id.web.app`
2. Test all features:
   - Character movement
   - Zone interactions
   - AI chat (if configured)
   - Feedback submission
   - Appointment booking

### 6.4 Monitor Performance

- Go to Firebase Console > Performance
- Check for any issues or slow load times
- Optimize as needed

## Step 7: Continuous Deployment (Optional)

### 7.1 Set Up GitHub Actions

Create `.github/workflows/firebase-hosting.yml`:

```yaml
name: Deploy to Firebase Hosting

on:
  push:
    branches:
      - main

jobs:
  build_and_deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v2
      - uses: actions/setup-node@v2
        with:
          node-version: '18'
      - uses: pnpm/action-setup@v2
        with:
          version: 8
      - run: pnpm install
      - run: pnpm build
      - uses: FirebaseExtended/action-hosting-deploy@v0
        with:
          repoToken: '${{ secrets.GITHUB_TOKEN }}'
          firebaseServiceAccount: '${{ secrets.FIREBASE_SERVICE_ACCOUNT }}'
          channelId: live
          projectId: your-project-id
```

### 7.2 Add Firebase Service Account

1. Go to Firebase Console > Project Settings > Service accounts
2. Generate new private key
3. Add the JSON content as a GitHub secret named `FIREBASE_SERVICE_ACCOUNT`

## Troubleshooting

### Build Fails

**Issue:** TypeScript compilation errors

**Solution:**

```bash
pnpm install
cd functions && npm install && cd ..
pnpm build
```

### Deployment Fails

**Issue:** "Permission denied" or authentication errors

**Solution:**

```bash
firebase login --reauth
firebase use your-project-id
```

### Functions Don't Work

**Issue:** Functions return 500 errors

**Solution:**

1. Check Firebase Console > Functions > Logs
2. Ensure Blaze plan is enabled
3. Verify all environment variables are set
4. Check CORS configuration

### Firestore Rules Error

**Issue:** "Missing or insufficient permissions"

**Solution:**

1. Verify you've replaced `YOUR_OWNER_UID` in `firestore.rules`
2. Redeploy rules: `firebase deploy --only firestore:rules`
3. Check rules in Firebase Console > Firestore > Rules

### Hosting Shows Old Version

**Issue:** Changes don't appear after deployment

**Solution:**

1. Clear browser cache
2. Try incognito/private mode
3. Wait a few minutes for CDN propagation
4. Verify deployment: `firebase hosting:channel:list`

## Maintenance

### Update Dependencies

```bash
pnpm update
cd functions && npm update && cd ..
```

### View Logs

**Hosting logs:**

```bash
firebase hosting:channel:list
```

**Functions logs:**

```bash
firebase functions:log
```

Or view in Firebase Console > Functions > Logs

### Rollback Deployment

```bash
firebase hosting:rollback
```

## Cost Estimation

Firebase offers a generous free tier. Typical costs for this project:

- **Hosting**: Free for most use cases
- **Firestore**: Free up to 50K reads/day, 20K writes/day
- **Functions**: Free up to 2M invocations/month
- **Storage**: Free up to 5GB stored, 1GB/day downloaded

Monitor usage in Firebase Console > Usage and billing.

## Security Best Practices

1. **Never commit** `FirebaseConfig.ts` with real credentials to public repos
2. **Use environment variables** for sensitive data
3. **Regularly review** Firestore and Storage rules
4. **Enable App Check** to prevent abuse
5. **Set up budget alerts** in Firebase Console

## Support

For issues or questions:

- Check Firebase documentation: <https://firebase.google.com/docs>
- Visit Firebase support: <https://firebase.google.com/support>
- Review project README.md

---

**Congratulations!** Your DigiScalability Life Island is now deployed and accessible to the world! 🎉
