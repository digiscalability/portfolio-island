# Integrated Project Requirements: DigiScalability Life Island & Planet Messenger

## 1. Project Overview

This project aims to create a unique, interactive 3D experience that combines the personal representation of a "DigiScalability Life Island" with the engaging gameplay mechanics of a "3D Planet Messenger Game MVP." The user will navigate a personalized 3D spherical world (the "Life Island") that visually represents their life, business, hobbies, and achievements. Visitors can explore this world, interact with various zones, and engage in a "messenger" style gameplay loop where they deliver messages or interact with AI agents to learn more about the owner.

## 2. Core Purpose & Vision

To provide an immersive, living digital representation of the owner's world, allowing visitors to explore, learn, interact, and connect. The "messenger" gameplay will serve as a guided interaction mechanism, encouraging exploration and engagement with the island's content and features.

## 3. Technical Stack

### Frontend

- **3D Engine:** Three.js (r180+)
- **Build Tool:** Vite
- **Language:** TypeScript
- **UI Framework:** React (for UI overlays and panels) or Vanilla Three.js + HTML/CSS overlay
- **Shaders:** WebGL shaders (toon, outline, water, planet terrain)
- **Firebase SDK:** v10+

### Backend

- **Cloud Platform:** Firebase
  - **Database:** Firestore (for data models, visitor tracking, feedback, conversations, appointments)
  - **Authentication:** Firebase Authentication (anonymous + Google login for visitors, owner full control)
  - **Functions:** Firebase Functions (chat/AI Q&A, appointment scheduling, notifications, message routing)
  - **Storage:** Firebase Storage (for 3D assets, textures, audio, user uploads)
  - **Hosting:** Firebase Hosting (for deployment, with SSL domain)
  - **Messaging:** Firebase Cloud Messaging (for notifications)
  - **Extensions:** Firebase Extensions (e.g., Google Calendar API sync for appointments)
  - **Analytics:** Firebase Analytics, Performance, Crashlytics

## 4. Integrated Features

### 4.1. 3D World & Environment

- **Spherical Island/Planet:** A central spherical 3D environment representing the

Life Island, with a radius of 15-20 units.

- **Toon Shading & Art Style:** Consistent toon-shaded graphics with pastel color palettes, 2-3 step cel shading, and optional outline shaders. This applies to the planet, character, and all interactive objects.
- **Surface Objects:** Procedurally or manually placed houses, mailboxes, trees, decorative objects, and 3D emojis on the island surface, aligned with the planet's normal.
- **Dynamic Environment:** Day/night lighting cycle, ambient soundscape (WebAudio API), and optional water/cloud shaders.
- **Optimization:** Optimized for 60 FPS on desktop/mobile, using frustum culling, low-poly models, texture atlasing, and limited lights.

### 4.2. Player Character & Navigation

- **Player Character:** A low-poly humanoid character (500-2000 triangles), rigged with basic skeleton for animations (idle, walk, delivery).
- **Movement:** WASD or touch controls for free exploration. Character walks on the spherical surface, with gravity pulling towards the center. Smooth rotation to match surface normal using quaternion SLERP.
- **Camera System:** Third-person follow camera (60-75° FOV), positioned behind and above the player, with smooth following and damping. No manual camera rotation for MVP.
- **Character Customization:** In-game menu for skin tone, outfit/color variations, hair styles, and accessory toggles. Preferences stored in memory.

### 4.3. Interactive Zones & Content (Life Island Specific)

- **Interactive Zones:** Clearly defined zones on the island, each representing a different aspect of the owner's life:
  1. **Business Hub:** DigiScalability projects, AI products.
  2. **Hobby Cove:** Music, art, writing, fitness.
  3. **Achievement Hall:** Timeline, milestones.
  4. **Memory Garden:** Personal stories.
  5. **Contact Dock:** Chat, feedback, appointment booking.
- **Interaction:** 3D floating labels or portals for each zone. On-click interaction panels (React or HTML overlays) to display detailed information.
- **Q&A System:** Voice or text Q&A powered by Firebase Function + Gemini API, allowing visitors to ask questions about the owner's life/work/hobbies.

### 4.4. Gameplay & Messenger Mechanics

- **Delivery System:** Start with 3-5

messages/tasks to deliver within the Life Island. Each message has a destination (e.g., a specific zone or interactive object).

- **Visual Indicators:** Floating arrows or glows to show the next destination.
- **Interaction:** Walk to the destination, trigger interaction with proximity + keypress (E or Space). Play delivery animation and sound effect.
- **Feedback System:** Visitors can leave feedback or comments, stored in Firestore.
- **Appointment Booking:** Integrated with Google Calendar API via Firebase Extensions. Visitors can schedule meetings or calls.
- **Chat System:** Chat window overlay connects to an AI agent (Firebase Function + Gemini API) for Q&A.
- **Visitor Tracking:** Via Firebase Analytics.
- **Optional Multi-user Exploration:** Via Firestore presence.

### 4.5. User Interface (UI/UX)

- **Entry Screen:** "Welcome to My Island" screen.
- **Character Selection/Free-fly Camera:** Option to choose between a character or a free-fly camera at the start.
- **HUD Elements:** Delivery counter (if applicable), current objective hint, FPS counter (debug only).
- **Main Menu:** "Start Exploration," "Customize Character," "About" info.
- **Interaction Panels:** On-click panels for zones, feedback, and appointment booking (React or HTML overlays).
- **Minimal Design:** Clean, minimal design with rounded corners and semi-transparent backgrounds.

### 4.6. Audio System

- **Sound Effects:** Footstep sounds, delivery success chime, UI click sounds.
- **Ambient Music:** Looping, calming track.
- **Implementation:** Web Audio API or Three.js Audio, with volume controls (mute toggle minimum).

### 4.7. Asset Management

- **Loading Screen:** Show loading screen with progress bar.
- **Preloading:** Preload all assets before the experience starts.
- **Formats:** Use GLTF/GLB for compressed 3D models, JPEG for color textures, PNG for alpha textures.

## 5. Firebase Setup

- **Authentication:** Anonymous + Google login for visitors, owner full control.
- **Firestore Rules:** Visitors read-only, owner full control.
- **Functions:** AI Q&A, appointment scheduling, feedback notifications, message routing.
- **Hosting:** Firebase Hosting + SSL domain.
- **Analytics, Performance, Crashlytics:** Enabled.

## 6. Project Structure (Combined & Adapted)

```
project-root/
├── index.html
├── package.json
├── vite.config.js
├── firebase.json
├── .firebaserc
├── functions/                # Firebase Functions
│   ├── index.ts
│   ├── package.json
│   └── tsconfig.json
├── src/
│   ├── main.ts                 # Entry point
│   ├── core/
│   │   ├── Engine.ts           # Main game/experience controller
│   │   └── AssetLoader.ts      # Asset loading manager
│   ├── world/
│   │   ├── Island.ts           # Planet sphere generation and base
│   │   ├── Zones.ts            # Definition and placement of interactive zones
│   │   ├── ObjectPlacement.ts  # Utility for placing objects on sphere
│   │   └── Environment.ts      # Day/night cycle, ambient sounds
│   ├── gameplay/
│   │   ├── Player.ts           # Player character logic, movement
│   │   ├── InteractionSystem.ts# Raycast triggers, object interactions
│   │   ├── DeliverySystem.ts   # Mail/task delivery mechanics
│   │   └── Camera.ts           # Camera controller (third-person/free-fly)
│   ├── systems/
│   │   ├── ChatSystem.ts       # AI agent chat integration
│   │   ├── AppointmentSystem.ts# Google Calendar integration
│   │   └── FeedbackSystem.ts   # Firestore feedback submission
│   ├── rendering/
│   │   ├── SceneManager.ts     # Three.js scene setup, lights
│   │   ├── Renderer.ts         # WebGL renderer config
│   │   ├── Lighting.ts         # Lighting setup
│   │   └── Materials.ts        # Toon shading materials, custom shaders
│   ├── entities/
│   │   ├── Character.ts        # NPC characters, owner character
│   │   ├── InteractiveObject.ts# Base class for interactive elements
│   │   ├── House.ts            # Building objects
│   │   ├── Mailbox.ts          # Mailbox objects (for delivery gameplay)
│   │   └── Emoji.ts            # 3D emoji objects
│   ├── ui/
│   │   ├── HUD.ts              # Heads-up display
│   │   ├── Menu.ts             # Main menu, entry screen
│   │   ├── Customization.ts    # Character customizer
│   │   ├── InteractionPanel.ts # Overlay for zone details, feedback, appointments
│   │   └── LoadingScreen.ts    # Asset loading progress
│   ├── utils/
│   │   ├── MathUtils.ts        # Sphere math utilities
│   │   └── InputManager.ts     # Keyboard/mouse/touch input
│   ├── shaders/
│   │   ├── toon.vert           # Toon vertex shader
│   │   ├── toon.frag           # Toon fragment shader
│   │   ├── outline.frag        # Outline fragment shader
│   │   └── water.frag          # Water fragment shader
│   └── assets/
│       ├── models/             # GLTF/GLB files (character, houses, props)
│       ├── textures/           # Texture images
│       ├── audio/              # Sound files, ambient music
│       └── images/             # UI images, icons
```

## 7. Deployment

- Ready-to-run on Firebase Hosting.
- Output message: "DigiScalability Life Island generated successfully" upon successful deployment scaffold generation.

## 8. Goal

Generate the full scaffold (frontend + backend + CI/CD setup) with placeholder assets and interaction templates ready for extension, integrating all specified features from both projects into a cohesive experience.
