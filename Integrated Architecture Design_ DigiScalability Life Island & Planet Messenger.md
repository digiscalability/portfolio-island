# Integrated Architecture Design: DigiScalability Life Island & Planet Messenger

## 1. Introduction

This document outlines the architectural design for the integrated project, combining the personalized interactive 3D environment of "DigiScalability Life Island" with the engaging gameplay mechanics of the "3D Planet Messenger Game MVP." The goal is to create a cohesive and performant full-stack application that leverages Three.js for the frontend and Firebase for the backend.

## 2. Core Architectural Principles

- **Modularity:** Components will be designed to be independent and reusable, facilitating easier development, testing, and maintenance.
- **Scalability:** Utilizing Firebase's serverless architecture to ensure the application can scale with user demand.
- **Performance:** Optimizing 3D rendering and asset loading for smooth 60 FPS experience on various devices.
- **Extensibility:** Designing systems to allow for future additions of new zones, interactions, and gameplay elements.
- **Security:** Implementing robust Firebase security rules for data access and user authentication.

## 3. Technical Stack Overview

| Component     | Technology/Service                               | Purpose                                                                                             |
| :------------ | :----------------------------------------------- | :-------------------------------------------------------------------------------------------------- |
| **Frontend**  | Three.js (r180+)                                 | 3D rendering engine for the interactive island/planet and all its elements.                         |
|               | Vite                                             | Fast build tool and development server for the TypeScript frontend.                                 |
|               | TypeScript                                       | Primary language for frontend logic, providing type safety and improved code quality.               |
|               | React (or Vanilla JS + HTML/CSS)                 | For UI overlays, menus, interaction panels, and character customization.                            |
|               | WebGL Shaders                                    | Custom shaders for toon shading, outlines, water, and planet terrain effects.                       |
|               | Firebase SDK (v10+)                              | Client-side interaction with Firebase services (Firestore, Auth, Storage).                          |
| **Backend**   | Firebase Firestore                               | NoSQL database for storing dynamic data: user profiles, island zone content, feedback, appointments, conversations. |
|               | Firebase Authentication                          | Manages user identities, supporting anonymous and Google sign-in for visitors, and full control for the owner. |
|               | Firebase Functions                               | Serverless backend logic for AI Q&A (Gemini API integration), appointment scheduling, notifications, and message routing. |
|               | Firebase Storage                                 | Stores static assets like 3D models (GLTF/GLB), textures, audio files, and user-uploaded content. |
|               | Firebase Hosting                                 | Provides fast, secure, and reliable hosting for the frontend application and handles SSL.          |
|               | Firebase Cloud Messaging (FCM)                   | Enables sending notifications to users (e.g., appointment reminders, feedback alerts).              |
|               | Firebase Extensions (Google Calendar API)        | Simplifies integration with Google Calendar for appointment management.                             |
|               | Firebase Analytics, Performance, Crashlytics     | Tools for monitoring user engagement, application performance, and crash reporting.                 |

## 4. Frontend Architecture

The frontend will be a single-page application (SPA) built with Vite and TypeScript, utilizing Three.js for 3D rendering. React will be used for UI components that overlay the 3D scene, ensuring a responsive and interactive user experience.

### 4.1. Core 3D Engine (`src/core/Engine.ts`)

This module will act as the central orchestrator for the Three.js scene. It will be responsible for:
- Initializing the WebGL renderer, scene, and camera.
- Managing the animation loop (`requestAnimationFrame`).
- Handling window resizing and camera aspect ratio updates.
- Integrating core game/experience systems (Player, World, UI, etc.).

### 4.2. World Management (`src/world/`)

- **`Island.ts`:** Generates the spherical planet mesh, applies base materials (toon-shaded), and handles procedural terrain generation or texture mapping. It will also provide utilities for calculating surface normals and positions.
- **`Zones.ts`:** Defines the boundaries and content for each interactive zone (Business Hub, Hobby Cove, etc.). It will manage the visual representation of zones (e.g., floating labels, portals) and trigger interaction events.
- **`ObjectPlacement.ts`:** A utility class for placing 3D objects (houses, mailboxes, trees, NPCs, emojis) onto the spherical surface, ensuring correct alignment with the planet's normal.
- **`Environment.ts`:** Manages ambient lighting, directional lights, day/night cycles, and integrates ambient soundscapes using the Web Audio API.

### 4.3. Gameplay & Interaction Systems (`src/gameplay/`)

- **`Player.ts`:** Manages the player character's 3D model, animations, movement (WASD/touch), and interaction with the spherical gravity system. It will handle character customization data.
- **`InteractionSystem.ts`:** Utilizes Three.js raycasting to detect player interaction with 3D objects (e.g., clicking on a zone portal, approaching a mailbox). It will dispatch events to relevant UI or gameplay modules.
- **`DeliverySystem.ts`:** Implements the core messenger gameplay loop. It will manage delivery tasks, track destinations, provide visual cues (arrows/glows), and handle delivery completion logic.
- **`Camera.ts`:** Controls the camera's behavior, implementing a smooth third-person follow for the player character and potentially a free-fly mode for initial exploration.

### 4.4. Backend Interaction Systems (`src/systems/`)

These modules will encapsulate client-side logic for interacting with Firebase Functions and Firestore:
- **`ChatSystem.ts`:** Handles sending user queries to a Firebase Function (which then calls the Gemini API) and displaying AI responses in an overlay UI.
- **`AppointmentSystem.ts`:** Manages the UI for booking appointments and sends requests to a Firebase Function that interacts with the Google Calendar API.
- **`FeedbackSystem.ts`:** Provides an interface for visitors to submit feedback, which is then stored in Firestore.

### 4.5. Rendering & Shaders (`src/rendering/` & `src/shaders/`)

- **`SceneManager.ts`:** Sets up the initial Three.js scene, including lights and post-processing effects.
- **`Renderer.ts`:** Configures the WebGL renderer, including antialiasing, pixel ratio, and color space.
- **`Lighting.ts`:** Manages the various light sources in the scene (ambient, directional) and their properties.
- **`Materials.ts`:** Centralizes the creation and management of custom materials, especially for toon shading (using `MeshToonMaterial` with gradient maps or custom shaders) and outline effects.
- **`shaders/`:** Contains GLSL code for custom vertex and fragment shaders (e.g., `toon.vert`, `toon.frag`, `outline.frag`, `water.frag`).

### 4.6. User Interface (`src/ui/`)

- **`HUD.ts`:** Displays in-game information like delivery counters, objectives, and debug stats.
- **`Menu.ts`:** Manages the main menu, welcome screen, and navigation options.
- **`Customization.ts`:** Provides the UI for character customization.
- **`InteractionPanel.ts`:** A generic component for displaying contextual information and interactive forms (feedback, appointments, zone details) as overlays.
- **`LoadingScreen.ts`:** Shows progress during asset loading.

### 4.7. Utilities (`src/utils/`)

- **`MathUtils.ts`:** Contains helper functions for spherical coordinates, vector operations, and other mathematical calculations specific to the 3D environment.
- **`InputManager.ts`:** Handles keyboard, mouse, and touch input events, providing a normalized input state to other systems.
- **`AssetLoader.ts`:** Manages the loading of 3D models (GLTF/GLB), textures, and audio files, potentially with a loading progress indicator.

## 5. Backend Architecture (Firebase)

Firebase will serve as the complete backend solution, providing authentication, database, serverless functions, storage, and hosting.

### 5.1. Firestore Data Models

- **`users/{uid}/profile`:** Stores owner's profile information. Read-only for visitors.
- **`islands/{island_id}/zones`:** Defines the content and properties of each interactive zone (e.g., text descriptions, associated media, interaction triggers).
- **`visitors/{visitor_id}/feedback`:** Stores feedback submitted by visitors.
- **`appointments/{appointment_id}`:** Records appointment requests, linked to Google Calendar.
- **`conversations/{chat_id}`:** Stores chat history with the AI agent.

### 5.2. Firebase Authentication

- **Anonymous Authentication:** Allows visitors to explore the island without explicit login.
- **Google Sign-in:** Optional for visitors who wish to save preferences or interact more deeply.
- **Owner Authentication:** Secure login for the island owner with full administrative privileges.
- **Firestore Security Rules:** Will be configured to enforce read-only access for visitors on most data, while granting full control to the owner.

### 5.3. Firebase Functions (`functions/index.ts`)

- **`askAI`:** Receives text/voice queries from the frontend, calls the Gemini API, and returns AI-generated responses for the Q&A system.
- **`scheduleAppointment`:** Receives appointment requests, validates them, and uses Firebase Extensions (Google Calendar API) to create calendar events. Sends notifications via FCM.
- **`submitFeedback`:** Receives feedback submissions and writes them to Firestore. Can trigger notifications to the owner.
- **`processChat`:** Routes chat messages, potentially handling multi-user presence if implemented.
- **`sendNotification`:** Generic function for sending push notifications via FCM.

### 5.4. Firebase Storage

- **`assets/`:** Stores all 3D models, textures, and audio files required by the frontend.
- **`uploads/`:** (Optional) Directory for any user-generated content or owner-uploaded media.

### 5.5. Firebase Hosting

- Serves the compiled frontend application (HTML, CSS, JavaScript, assets).
- Configured with an SSL domain for secure access.
- Rewrites will be set up to handle client-side routing for the SPA.

## 6. Deployment Strategy

The project will be deployed entirely on Firebase. The `firebase.json` and `.firebaserc` files will be configured for seamless deployment of both the frontend (Hosting) and backend (Functions, Firestore rules, Storage rules).

## 7. CI/CD (Placeholder)

A basic CI/CD setup will be scaffolded, potentially using GitHub Actions, to automate:
- Building the frontend application.
- Deploying to Firebase Hosting.
- Deploying Firebase Functions.
- Running basic tests (if implemented).

## 8. Future Considerations

- **Multi-user Presence:** Further development of Firestore presence for real-time multi-user exploration.
- **Advanced AI Interactions:** Expanding Gemini API integration for more complex conversational flows.
- **Content Management System (CMS):** Potentially integrating a headless CMS for easier management of island content (zones, stories, achievements) by the owner.
- **WebXR Support:** Exploring VR/AR capabilities for an even more immersive experience.

This architecture provides a robust foundation for building the integrated DigiScalability Life Island and Planet Messenger experience, ensuring a rich, interactive, and scalable application.
