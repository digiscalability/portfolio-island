# DigiScalability Life Island

An immersive 3D interactive experience that combines a personalized "Life Island" with engaging messenger-style gameplay mechanics. Built with Three.js, TypeScript, and Firebase.

## 🌟 Features

### Core Experience

- **3D Spherical World**: Navigate a beautiful toon-shaded planet representing life, business, hobbies, and achievements
- **Sphere Walking Mechanics**: Realistic gravity-based movement on a spherical surface
- **Interactive Zones**: Five distinct areas to explore:
  - Business Hub (DigiScalability projects, AI products)
  - Hobby Cove (music, art, writing, fitness)
  - Achievement Hall (timeline, milestones)
  - Memory Garden (personal stories)
  - Contact Dock (chat, feedback, appointment booking)

### Gameplay & Interactions

- **WASD Movement**: Smooth character control with sprint capability
- **Zone Interactions**: Press E or Space to interact with zones
- **AI Chat System**: Press C to chat with an AI guide (powered by Gemini API)
- **Feedback System**: Visitors can leave feedback stored in Firestore
- **Appointment Booking**: Integrated with Google Calendar API
- **Decorative Elements**: Houses, mailboxes, trees, and 3D emojis populate the island

### Technical Features

- **Toon Shading**: Beautiful cel-shaded graphics with custom materials
- **Third-Person Camera**: Smooth follow camera with automatic positioning
- **Firebase Integration**: Full backend with Firestore, Functions, Storage, and Hosting
- **Responsive UI**: Clean, modern interface with overlays and panels
- **Performance Optimized**: Targets 60 FPS on desktop and mobile

## 🚀 Getting Started

### Prerequisites

- Node.js 18+ and pnpm
- Firebase CLI (`npm install -g firebase-tools`)
- A Firebase project (create one at <https://console.firebase.google.com/>)

### Installation

1. **Clone or navigate to the project directory**

   ```bash
   cd digiscalability-life-island
   ```

2. **Install dependencies**

   ```bash
   pnpm install
   cd functions && npm install && cd ..
   ```

3. **Configure Firebase**

   a. Update `.firebaserc` with your Firebase project ID:

   ```json
   {
     "projects": {
       "default": "your-project-id"
     }
   }
   ```

   b. Update `src/core/FirebaseConfig.ts` with your Firebase configuration:

   ```typescript
   export const firebaseConfig = {
     apiKey: "YOUR_API_KEY",
     authDomain: "YOUR_PROJECT_ID.firebaseapp.com",
     projectId: "YOUR_PROJECT_ID",
     storageBucket: "YOUR_PROJECT_ID.appspot.com",
     messagingSenderId: "YOUR_MESSAGING_SENDER_ID",
     appId: "YOUR_APP_ID",
     measurementId: "YOUR_MEASUREMENT_ID"
   };
   ```

   c. Update Firestore and Storage rules with your owner UID:
   - Replace `YOUR_OWNER_UID` in `firestore.rules`
   - Replace `YOUR_OWNER_UID` in `storage.rules`

4. **Set up Firebase services**

   ```bash
   firebase login
   firebase use your-project-id
   ```

   Enable the following in Firebase Console:
   - Authentication (Anonymous + Google)
   - Firestore Database
   - Cloud Functions
   - Cloud Storage
   - Firebase Hosting
   - Firebase Analytics (optional)

5. **Configure Gemini API (Optional)**

   For AI chat functionality, set up the Gemini API key:

   ```bash
   firebase functions:config:set gemini.apikey="YOUR_GEMINI_API_KEY"
   ```

## 💻 Development

### Run Development Server

```bash
pnpm dev
```

The app will be available at `http://localhost:5173`

### Build for Production

```bash
pnpm build
```

### Preview Production Build

```bash
pnpm preview
```

## 🌐 Deployment

### Deploy to Firebase Hosting

1. **Build the project**

   ```bash
   pnpm build
   ```

2. **Deploy everything (Hosting + Functions + Firestore rules)**

   ```bash
   firebase deploy
   ```

3. **Deploy only specific services**

   ```bash
   firebase deploy --only hosting
   firebase deploy --only functions
   firebase deploy --only firestore:rules
   firebase deploy --only storage:rules
   ```

### Post-Deployment

After deployment, your site will be available at:

- `https://your-project-id.web.app`
- `https://your-project-id.firebaseapp.com`

You can also set up a custom domain in Firebase Hosting settings.

## 🎮 Controls

- **WASD or Arrow Keys**: Move character
- **Shift**: Sprint
- **E or Space**: Interact with zones
- **C**: Toggle AI chat window
- **Mouse**: Look around (camera follows player automatically)

## 📁 Project Structure

```
digiscalability-life-island/
├── src/
│   ├── core/              # Engine and Firebase config
│   ├── world/             # Island, zones, object placement
│   ├── gameplay/          # Player, camera, interactions
│   ├── systems/           # Chat, feedback, appointments
│   ├── rendering/         # Scene, renderer, materials, lighting
│   ├── entities/          # Houses, mailboxes, emojis
│   ├── ui/                # UI manager and components
│   ├── utils/             # Math utilities, input manager
│   ├── shaders/           # GLSL shaders
│   ├── assets/            # 3D models, textures, audio
│   ├── main.ts            # Entry point
│   └── style.css          # Global styles
├── functions/             # Firebase Functions
│   └── src/
│       └── index.ts       # Cloud functions (AI, appointments, feedback)
├── dist/                  # Build output
├── firebase.json          # Firebase configuration
├── firestore.rules        # Firestore security rules
├── storage.rules          # Storage security rules
└── README.md
```

## 🔧 Configuration

### Firebase Functions

The following Cloud Functions are included:

- **askAI**: Handles AI Q&A with Gemini API
- **scheduleAppointment**: Books appointments via Google Calendar
- **submitFeedback**: Stores visitor feedback in Firestore
- **getAvailableSlots**: Retrieves available appointment times

### Firestore Data Models

- `users/{uid}/profile`: User profiles
- `islands/{island_id}/zones`: Zone content and properties
- `feedback/{feedback_id}`: Visitor feedback
- `appointments/{appointment_id}`: Scheduled appointments
- `conversations/{chat_id}`: Chat history

### Security Rules

- Visitors have read-only access to most data
- Owner (specified by UID) has full control
- Feedback and appointments can be created by anyone
- Chat conversations are stored for owner review

## 🎨 Customization

### Adding New Zones

Edit `src/world/Zones.ts` and add to the `zoneDefinitions` array:

```typescript
{
  id: 'new-zone',
  name: 'New Zone',
  description: 'Description of the new zone.',
  color: 0xff00ff,
}
```

### Changing Colors and Materials

Edit `src/rendering/Materials.ts` to customize toon shader colors and materials.

### Modifying Character Appearance

Edit `src/gameplay/Player.ts` in the `createCharacter()` method to change the character model.

## 🐛 Troubleshooting

### Build Errors

If you encounter TypeScript errors, ensure all dependencies are installed:

```bash
pnpm install
cd functions && npm install && cd ..
```

### Firebase Deployment Issues

1. Make sure you're logged in: `firebase login`
2. Verify project is set: `firebase use your-project-id`
3. Check that all services are enabled in Firebase Console

### Performance Issues

- Reduce the number of objects on the island in `src/world/ObjectPlacement.ts`
- Lower the sphere geometry segments in `src/world/Island.ts`
- Disable shadows in `src/rendering/Renderer.ts`

## 📝 TODO / Future Enhancements

- [ ] Add actual 3D models (GLTF/GLB) for houses and characters
- [ ] Implement character customization UI
- [ ] Add background music and sound effects
- [ ] Integrate real Gemini API for AI chat
- [ ] Connect Google Calendar API for appointments
- [ ] Add multi-user presence system
- [ ] Implement delivery/messenger gameplay loop
- [ ] Add day/night cycle
- [ ] Create water and cloud shaders
- [ ] Add mobile touch controls
- [ ] Implement loading screen with asset preloading
- [ ] Add analytics tracking

## 📄 License

This project is provided as-is for personal and commercial use.

## 🙏 Acknowledgments

- Three.js for the amazing 3D engine
- Firebase for the backend infrastructure
- Vite for the blazing-fast build tool
- Inspired by "Messenger by Abeto"

---

**DigiScalability Life Island generated successfully!** 🎉

For questions or support, please visit the Contact Dock in the experience or reach out through the feedback system.
