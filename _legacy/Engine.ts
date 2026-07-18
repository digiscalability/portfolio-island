import * as THREE from 'three';

import { AudioManager } from './AudioManager';
import { CameraController } from './Camera';
import { DeliverySystem } from './DeliverySystem';
import { InputManager } from './InputManager';
import { InteractionSystem } from './InteractionSystem';
import { Island } from './Island';
import type { NPC } from './NPC';
import { ObjectPlacement } from './ObjectPlacement';
import { Player } from './Player';
import { Renderer } from './Renderer';
import { SceneManager } from './SceneManager';
import type { UIManager } from './UIManager';
import { ZonesManager } from './Zones';

type InteractableTarget =
  | {
      mesh: THREE.Object3D & { position: THREE.Vector3 };
      name?: string;
      bubbleText?: string;
      hasDelivery?: boolean;
      label?: string;
      userData?: Record<string, unknown>;
    }
  | (THREE.Object3D & {
      userData?: Record<string, unknown>;
      name?: string;
    });

type UiManagerMethodKeys =
  | 'update'
  | 'showDialogue'
  | 'showSpeechBubbleTimed'
  | 'showSpeechBubble'
  | 'showSpeechBubbleForObject'
  | 'showEmojiTooltip'
  | 'hideEmojiTooltip'
  | 'showInteractionHint'
  | 'hideInteractionHint';

type UiManagerAPI = Pick<UIManager, UiManagerMethodKeys>;

export class Engine {
  private sceneManager: SceneManager;
  private renderer: Renderer;
  private island: Island;
  private zonesManager: ZonesManager;
  private objectPlacement: ObjectPlacement;
  private deliverySystem!: DeliverySystem;
  private player: Player;
  private cameraController: CameraController;
  private interactionSystem: InteractionSystem;
  private audioManager?: AudioManager;
  private currentAmbientKey?: string | null = null;
  private inputManager: InputManager;
  private clock: THREE.Clock;
  private isRunning: boolean = false;
  private isWorldVisible: boolean = false;
  // cooldown tracker for speech bubbles to avoid spamming every frame
  private _bubbleLastShown: Map<InteractableTarget, number> = new Map();
  // Track event handlers for cleanup
  private boundHandlers: {
    f1KeyHandler?: (ev: KeyboardEvent) => void;
  } = {};

  constructor(canvas: HTMLCanvasElement) {
    // Initialize core systems
    this.renderer = new Renderer(canvas);
    this.sceneManager = new SceneManager();
    this.clock = new THREE.Clock();
    this.inputManager = new InputManager();
    // By default, world is hidden until onboarding completes
    this.isWorldVisible = false;
    // attach canvas to input manager so touch/pointer-lock behavior works
    try {
      this.inputManager.attachToCanvas(canvas);
    } catch {
      // ignore canvas binding issues (tests may not provide DOM)
    }

    // Create world
    this.island = new Island(18);
    this.island.addToScene(this.sceneManager.getScene());

    // Create zones
    this.zonesManager = new ZonesManager(this.island);
    this.zonesManager.addToScene(this.sceneManager.getScene());

    // Place objects
    this.objectPlacement = new ObjectPlacement(this.island, this.sceneManager.getScene());
    this.objectPlacement.placeObjects();

    // Create delivery system and generate deliveries for mailboxes
    this.deliverySystem = new DeliverySystem();
    // Note: Delivery system now uses predefined quests instead of dynamic deliveries
    // this.objectPlacement.mailboxes.forEach((mb) => {
    //   this.deliverySystem.addDelivery(mb, 'A friendly letter');
    // });

    // Create player
    this.player = new Player(this.island);
    this.player.addToScene(this.sceneManager.getScene());

    // Setup camera (pass scene so controller can test occlusion)
    // Pass island as groundProvider so camera can query surface normals and adapt to slopes
    this.cameraController = new CameraController(
      this.sceneManager.getCamera(),
      this.player,
      this.sceneManager.getScene(),
      this.island,
    );
    // Apply third-person action game preset (like GTA, Fortnite, etc.)
    // Offset: (0.8, 1.8, 4.5) = slightly right of player's shoulder, closer and lower for action feel
    try {
      this.cameraController.setThirdPersonPreset({
        offset: new (require('three').Vector3)(0.8, 1.8, 4.5), // Over-shoulder view
        smoothness: 0.12, // Stable but responsive
        lookAtSmooth: 5.0, // Moderate look-at speed
        yawFollow: 0.5, // Moderate yaw follow (reduced for stability)
        minHeight: 0.5, // Can get closer to ground
      });
      // Build a small occluder list to improve camera occlusion performance: include large meshes and exclude decorative leaves/planes
      try {
        const scene = this.sceneManager.getScene();
        const occluders: THREE.Object3D[] = [];
        scene.traverse((o) => {
          if (!o) return;
          // skip player and small helpers
          if (o === this.player.mesh) return;
          if (o.name && /foliage|leaf|grass|bush|decal|plane|sprite/i.test(o.name)) return;
          if (o.userData && o.userData.ignoreOcclusion) return;
          // Heuristic: include Mesh and Group nodes that have geometry or bounding boxes
          try {
            if ('isMesh' in o || 'isGroup' in o) {
              occluders.push(o);
            }
          } catch {
            /* ignore */
          }
        });
        if (occluders.length) {
          this.cameraController.setOccluderObjects(occluders);
        }
      } catch {
        /* tolerate traversal errors */
      }
    } catch {
      // ignore camera preset failures
    }

    // Setup interaction system
    this.interactionSystem = new InteractionSystem(this.player, this.zonesManager);
    // Provide a combined interactable provider: mailboxes, houses, emojis and island NPCs
    try {
      this.interactionSystem.setInteractableProvider(() => this.collectInteractables());

      // Register object interaction handler: show richer NPC dialogue or panel when player presses action near an object
      this.interactionSystem.onObjectInteraction((obj: InteractableTarget) => {
        const uiMgr = this.getUiManager();
        if (!uiMgr) return;

        const info = this.describeInteractable(obj);
        const userData = this.getUserData(info.mesh);
        const dialogue = this.getUserDataString(userData, 'dialogue');
        const body = info.bubbleText ?? dialogue ?? 'Hello!';

        try {
          const cam = this.sceneManager.getCamera();
          const canvas = document.getElementById('game-canvas') as HTMLCanvasElement | null;
          const targetPos = info.mesh.getWorldPosition(new THREE.Vector3());
          if (cam && canvas && targetPos) {
            const vec = targetPos.clone().project(cam);
            if (vec.z < 1 && vec.z > -1) {
              const crect = canvas.getBoundingClientRect();
              const x = (vec.x * 0.5 + 0.5) * crect.width + crect.left;
              const y = (-vec.y * 0.5 + 0.5) * crect.height + crect.top;
              uiMgr.showDialogue?.(info.name, body, x, y - 16);
              if (!uiMgr.showDialogue) {
                uiMgr.showSpeechBubbleTimed?.(info.name, body, x, y - 16, 4);
              }
            }
          }
        } catch {
          /* ignore projection errors */
        }
      });
    } catch {
      // non-fatal interaction setup issue
    }

    // Audio manager (if provided globally)
    this.audioManager = this.getAudioManager();
    // Debug: toggle camera presets with F1 (cycles through default/close/wide)
    try {
      let presetIndex = 0;
      const presets: ('default' | 'close' | 'wide')[] = ['default', 'close', 'wide'];
      this.boundHandlers.f1KeyHandler = (ev: KeyboardEvent) => {
        try {
          if (ev.key === 'F1') {
            ev.preventDefault();
            presetIndex = (presetIndex + 1) % presets.length;
            try {
              this.cameraController.applyPreset(presets[presetIndex]);
              console.info('[Engine] camera preset ->', presets[presetIndex]);
            } catch {
              /* ignore preset errors */
            }
          }
        } catch {
          /* ignore key handling errors */
        }
      };
      window.addEventListener('keydown', this.boundHandlers.f1KeyHandler);
    } catch {
      // ignore keyboard hook issues
    }
  }

  // Allow external code to enable/disable player input and pointer lock behavior
  public setControlsEnabled(enabled: boolean) {
    try {
      this.inputManager.controlsEnabled = !!enabled;
      // If disabling controls, ensure action/reset states
      if (!enabled) {
        try {
          this.inputManager.resetAction();
        } catch {
          /* ignore reset failures */
        }
      }
    } catch {
      /* ignore control toggling errors */
    }
  }

  // Separately initialize post-processing after Engine is constructed
  public async initPostProcessing(): Promise<void> {
    try {
      await this.renderer.setupPostProcessing(
        this.sceneManager.getScene(),
        this.sceneManager.getCamera(),
      );
    } catch {
      // ignore
    }
  }

  public getRendererController() {
    return this.renderer;
  }

  public getScene(): import('three').Scene {
    return this.sceneManager.getScene();
  }

  public getSceneManager(): SceneManager {
    return this.sceneManager;
  }

  public start(): void {
    this.isRunning = true;
    this.animate();
  }

  // Call this to make the world visible after onboarding
  public setWorldVisible(visible: boolean) {
    this.isWorldVisible = visible;
    // Optionally, fade in the canvas or scene here if needed
    const canvas = this.renderer.getCanvas && this.renderer.getCanvas();
    if (canvas) {
      canvas.style.transition = 'opacity 0.7s';
      canvas.style.opacity = visible ? '1' : '0';
    }
  }

  public stop(): void {
    this.isRunning = false;
  }

  private animate = (): void => {
    if (!this.isRunning) return;

    requestAnimationFrame(this.animate);

    const deltaTime = this.clock.getDelta();
    const elapsedTime = this.clock.getElapsedTime();

    // Only update and render if world is visible
    if (this.isWorldVisible) {
      this.update(deltaTime, elapsedTime);
      this.render();
    }
  };

  private update(deltaTime: number, elapsedTime: number): void {
    // Update input
    const input = this.inputManager.getInput();

    // Update player (pass camera so movement is interpreted relative to camera yaw)
    try {
      const cam = this.sceneManager.getCamera();
      this.player.update(input, deltaTime, cam, this.inputManager);
    } catch {
      this.player.update(input, deltaTime, undefined, this.inputManager);
    }

    // Update camera (pass deltaTime for time-based damping)
    this.cameraController.update(deltaTime);
    // Update UI manager (reposition anchored bubbles, tooltips)
    try {
      const uiMgrTmp = this.getUiManager();
      uiMgrTmp?.update?.(deltaTime);
    } catch {
      /* ignore UI manager update errors */
    }

    // Update zones
    this.zonesManager.update(elapsedTime);

    // Update objects
    this.objectPlacement.update(elapsedTime);

    // Emoji proximity interaction
    const playerPos = this.player.getPosition();
    let nearestEmoji = null;
    let minDist = 1.2; // proximity threshold
    for (const emoji of this.objectPlacement.emojis) {
      const dist = emoji.mesh.position.distanceTo(playerPos);
      if (dist < minDist) {
        nearestEmoji = emoji;
        minDist = dist;
      }
    }
    // Throttle proximity tooltip updates via simple timestamp check
    const uiMgr = this.getUiManager();
    // Mailbox / NPC speech bubble: show short lines when player is near (generalized)
    try {
      if (uiMgr) {
        const candidates: InteractableTarget[] = [
          ...this.objectPlacement.mailboxes,
          ...this.objectPlacement.houses,
          ...this.objectPlacement.emojis,
        ];
        const npcInstances = this.island.getNPCInstances();
        let nearestObj: InteractableTarget | null = null;
        let nearestDist = 2.0;
        for (const npc of npcInstances) {
          if (npc.group) {
            candidates.push(npc.group as InteractableTarget);
          }
        }

        for (const candidate of candidates) {
          const mesh = this.getInteractableMesh(candidate);
          const distance = mesh.position.distanceTo(playerPos);
          if (distance < nearestDist) {
            nearestObj = candidate;
            nearestDist = distance;
          }
        }

        if (nearestObj) {
          // determine whether to show a bubble (object must provide bubbleText or status)
          const info = this.describeInteractable(nearestObj);
          const text =
            info.bubbleText ?? (info.hasDelivery ? 'You have mail!' : undefined) ?? info.label;
          if (text) {
            // cooldown per-object to avoid spamming every frame (seconds)
            const now = performance.now() / 1000;
            const last = this._bubbleLastShown.get(nearestObj) || 0;
            const COOLDOWN = 4.0;
            if (now - last >= COOLDOWN) {
              // ask UI manager to show an anchored speech bubble for the world object (uses pool + tail clamping)
              try {
                if (typeof uiMgr.showSpeechBubbleForObject === 'function') {
                  uiMgr.showSpeechBubbleForObject(nearestObj, info.name, text, 4);
                } else {
                  // fallback to legacy screen-projection path
                  const cam = this.sceneManager.getCamera();
                  const objectMesh = info.mesh;
                  const pos = objectMesh.position.clone();
                  const vec = pos.project(cam);
                  if (vec.z < 1 && vec.z > -1) {
                    const canvas = document.getElementById(
                      'game-canvas',
                    ) as HTMLCanvasElement | null;
                    if (canvas) {
                      const crect = canvas.getBoundingClientRect();
                      const x = (vec.x * 0.5 + 0.5) * crect.width + crect.left;
                      const y = (-vec.y * 0.5 + 0.5) * crect.height + crect.top;
                      if (typeof uiMgr.showSpeechBubbleTimed === 'function')
                        uiMgr.showSpeechBubbleTimed(info.name, text, x, y - 16, 4);
                      else uiMgr.showSpeechBubble(info.name, text, x, y - 16);
                    }
                  }
                }
                this._bubbleLastShown.set(nearestObj, now);
              } catch {
                /* ignore */
              }
            }
          }

          // Note: action-press dialogue handling is performed centrally by InteractionSystem.onObjectInteraction
          // to avoid duplicate dialogs. We keep proximity bubble display here but let InteractionSystem handle full
          // anchored dialogues when the player presses the action key.
        }
      }
    } catch {
      /* non-fatal */
    }
    if (nearestEmoji && uiMgr) {
      uiMgr.showEmojiTooltip(nearestEmoji, '😊');
    } else if (uiMgr) {
      uiMgr.hideEmojiTooltip();
    }

    // Show interaction hint above nearest object when close
    try {
      let showHint = false;
      if (uiMgr) {
        // reuse nearestObj logic (simple recompute)
        let nearestObj: InteractableTarget | null = null;
        let nearestDist = 2.0;
        const candidates: InteractableTarget[] = [
          ...this.objectPlacement.mailboxes,
          ...this.objectPlacement.houses,
        ];
        for (const obj of candidates) {
          const mesh = this.getInteractableMesh(obj);
          const d = mesh.position.distanceTo(playerPos);
          if (d < nearestDist) {
            nearestObj = obj;
            nearestDist = d;
          }
        }
        if (nearestObj) {
          const cam = this.sceneManager.getCamera();
          const mesh = this.getInteractableMesh(nearestObj);
          const vec = mesh.position.clone().project(cam);
          if (vec.z < 1 && vec.z > -1) {
            const canvas = document.getElementById('game-canvas') as HTMLCanvasElement | null;
            if (canvas) {
              const crect = canvas.getBoundingClientRect();
              const x = (vec.x * 0.5 + 0.5) * crect.width + crect.left;
              const y = (-vec.y * 0.5 + 0.5) * crect.height + crect.top;
              uiMgr.showInteractionHint(x, y - 36);
              showHint = true;
            }
          }
        }
      }
      if (!showHint && uiMgr) uiMgr.hideInteractionHint();
    } catch {}

    // Update delivery system (check player proximity/actions)
    if (this.deliverySystem) {
      this.deliverySystem.update(this.player.getPosition(), input.action);
    }

    // Update scene manager (lighting, etc.)
    this.sceneManager.update(deltaTime);

    // Update island animations
    this.island.update(deltaTime);

    // Update interaction system
    this.interactionSystem.update(input.action);
    if (input.action) {
      this.inputManager.resetAction();
    }

    // Update audio listener to player's position if audio manager present
    const am = this.audioManager ?? this.getAudioManager();
    if (am) {
      const pos = this.player.getPosition();
      // Attempt to use camera forward vector for orientation
      const cam = this.sceneManager.getCamera();
      const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion);
      const up = new THREE.Vector3(0, 1, 0).applyQuaternion(cam.quaternion);
      am.updateListener(
        { x: pos.x, y: pos.y, z: pos.z },
        { x: forward.x, y: forward.y, z: forward.z },
        { x: up.x, y: up.y, z: up.z },
      );
    }

    // Zone-based ambient audio: play ambient audio for nearest zone within radius
    if (this.audioManager && this.zonesManager) {
      const playerPos = this.player.getPosition();
      const nearby = this.zonesManager.findNearbyZone(playerPos, 12);
      if (nearby) {
        const key = nearby.audioKey ?? nearby.id;
        // If ambient changed, start new first (fade-in) then stop previous (fade-out) to overlap for crossfade
        if (key !== this.currentAmbientKey) {
          const prev = this.currentAmbientKey;
          // start new ambient
          this.audioManager.playSpatial(
            key,
            { x: nearby.getPosition().x, y: nearby.getPosition().y, z: nearby.getPosition().z },
            12,
          );
          // update current key
          this.currentAmbientKey = key;
          // stop previous after initiating new so fade overlaps
          if (prev) this.audioManager.stop(prev);
        } else {
          // update position of existing ambient source
          this.audioManager.updateSpatialPosition(key, {
            x: nearby.getPosition().x,
            y: nearby.getPosition().y,
            z: nearby.getPosition().z,
          });
        }
      } else {
        // left all zones
        if (this.currentAmbientKey) {
          this.audioManager.stop(this.currentAmbientKey);
          this.currentAmbientKey = null;
        }
      }
    }
  }

  private getUiManager(): UiManagerAPI | undefined {
    return window.uiManager as UiManagerAPI | undefined;
  }

  private getAudioManager(): AudioManager | undefined {
    return window.audioManager;
  }

  private getInteractableMesh(
    target: InteractableTarget,
  ): THREE.Object3D & { position: THREE.Vector3 } {
    return 'mesh' in target ? target.mesh : target;
  }

  private getUserData(mesh: THREE.Object3D): Record<string, unknown> | undefined {
    const raw = mesh.userData;
    return raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : undefined;
  }

  private getUserDataString(
    userData: Record<string, unknown> | undefined,
    key: string,
  ): string | undefined {
    const value = userData?.[key];
    return typeof value === 'string' ? value : undefined;
  }

  private getUserDataBoolean(
    userData: Record<string, unknown> | undefined,
    key: string,
  ): boolean | undefined {
    const value = userData?.[key];
    return typeof value === 'boolean' ? value : undefined;
  }

  private describeInteractable(target: InteractableTarget): {
    mesh: THREE.Object3D & { position: THREE.Vector3 };
    name: string;
    bubbleText?: string;
    label?: string;
    hasDelivery: boolean;
  } {
    const mesh = this.getInteractableMesh(target);
    const userData = this.getUserData(mesh);
    const explicitName =
      'name' in target && typeof target.name === 'string' ? target.name : undefined;
    const bubbleText =
      ('bubbleText' in target && typeof target.bubbleText === 'string'
        ? target.bubbleText
        : undefined) ?? this.getUserDataString(userData, 'bubbleText');
    const label =
      ('label' in target && typeof target.label === 'string' ? target.label : undefined) ??
      this.getUserDataString(userData, 'label');
    const hasDelivery =
      ('hasDelivery' in target && typeof target.hasDelivery === 'boolean'
        ? target.hasDelivery
        : undefined) ??
      this.getUserDataBoolean(userData, 'hasDelivery') ??
      false;
    const name =
      explicitName ??
      this.getUserDataString(userData, 'name') ??
      (mesh.name && mesh.name.length ? mesh.name : 'Friend');

    return {
      mesh,
      name,
      bubbleText: bubbleText || undefined,
      label: label || undefined,
      hasDelivery,
    };
  }

  private collectInteractables(): InteractableTarget[] {
    const entries: InteractableTarget[] = [
      ...this.objectPlacement.mailboxes,
      ...this.objectPlacement.houses,
      ...this.objectPlacement.emojis,
    ];
    const npcInstances: NPC[] = this.island.getNPCInstances();
    for (const npc of npcInstances) {
      entries.push(npc.group);
    }
    return entries;
  }

  private render(): void {
    this.renderer.render(this.sceneManager.getScene(), this.sceneManager.getCamera());
  }

  public getInteractionSystem(): InteractionSystem {
    return this.interactionSystem;
  }

  public getPlayer(): Player {
    return this.player;
  }

  public getZonesManager(): ZonesManager {
    return this.zonesManager;
  }

  public getInputManager(): InputManager {
    return this.inputManager;
  }

  public getMailboxes(): import('./Mailbox').Mailbox[] {
    return this.objectPlacement.mailboxes;
  }

  public getDeliverySystem(): DeliverySystem {
    return this.deliverySystem;
  }

  /**
   * Cleanup method to remove event listeners and dispose resources
   */
  public dispose(): void {
    // Stop animation loop
    this.stop();

    // Remove event listeners
    if (this.boundHandlers.f1KeyHandler) {
      window.removeEventListener('keydown', this.boundHandlers.f1KeyHandler);
    }

    // Dispose InputManager
    try {
      this.inputManager.dispose();
    } catch (_e) {
      console.warn('Error disposing InputManager:', _e);
    }

    // Clear maps
    this._bubbleLastShown.clear();
  }
}
