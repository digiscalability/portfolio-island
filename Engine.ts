import * as THREE from 'three';
import { AudioManager } from './AudioManager';
import { CameraController } from './Camera';
import { DeliverySystem } from './DeliverySystem';
import { InputManager } from './InputManager';
import { InteractionSystem } from './InteractionSystem';
import { Island } from './Island';
import { ObjectPlacement } from './ObjectPlacement';
import { Player } from './Player';
import { Renderer } from './Renderer';
import { SceneManager } from './SceneManager';
import { ZonesManager } from './Zones';

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
  private _bubbleLastShown: Map<any, number> = new Map();
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
    try { this.inputManager.attachToCanvas(canvas); } catch (e) { }

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
    this.objectPlacement.mailboxes.forEach((mb) => {
      this.deliverySystem.addDelivery(mb, 'A friendly letter');
    });

    // Create player
    this.player = new Player(this.island);
    this.player.addToScene(this.sceneManager.getScene());

    // Setup camera (pass scene so controller can test occlusion)
  // Pass island as groundProvider so camera can query surface normals and adapt to slopes
  this.cameraController = new CameraController(this.sceneManager.getCamera(), this.player, this.sceneManager.getScene(), this.island);
    // Apply third-person action game preset (like GTA, Fortnite, etc.)
    // Offset: (0.8, 1.8, 4.5) = slightly right of player's shoulder, closer and lower for action feel
    try {
      this.cameraController.setThirdPersonPreset({
        offset: new (require('three').Vector3)(0.8, 1.8, 4.5),  // Over-shoulder view
        smoothness: 0.12,        // Stable but responsive
        lookAtSmooth: 5.0,       // Moderate look-at speed
        yawFollow: 0.5,          // Moderate yaw follow (reduced for stability)
        minHeight: 0.5           // Can get closer to ground
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
            if ((o as any).isMesh || (o as any).isGroup) {
              occluders.push(o);
            }
          } catch (e) { /* ignore */ }
        });
        if (occluders.length) {
          this.cameraController.setOccluderObjects(occluders);
        }
      } catch (e) { /* tolerate traversal errors */ }
    } catch (e) { }

    // Setup interaction system
    this.interactionSystem = new InteractionSystem(this.player, this.zonesManager);
    // Provide a combined interactable provider: mailboxes, houses, emojis and island NPCs
    try {
      this.interactionSystem.setInteractableProvider(() => {
        const list: any[] = [];
        try { if (Array.isArray(this.objectPlacement?.mailboxes)) list.push(...this.objectPlacement.mailboxes as any[]); } catch (e) {}
        try { if (Array.isArray((this.objectPlacement as any)?.houses)) list.push(...(this.objectPlacement as any).houses as any[]); } catch (e) {}
        try { if (Array.isArray(this.objectPlacement?.emojis)) list.push(...this.objectPlacement.emojis as any[]); } catch (e) {}
        try { const npcs = (this.island && typeof (this.island as any).getNPCInstances === 'function') ? (this.island as any).getNPCInstances() : []; if (Array.isArray(npcs) && npcs.length) { for (const n of npcs) { if (n && n.group) list.push(n.group); } } } catch (e) {}
        return list;
      });

      // Register object interaction handler: show richer NPC dialogue or panel when player presses action near an object
      this.interactionSystem.onObjectInteraction((obj: any) => {
        try {
          const uiMgr = (window as any).uiManager as import('./UIManager').UIManager | undefined;
          if (!uiMgr) return;
          // If object is an NPC group with dialogue, use the anchored dialogue UI
          const title = obj.name || (obj.userData && obj.userData.name) || 'Friend';
          const body = (obj.userData && (obj.userData.dialogue || obj.userData.bubbleText)) || 'Hello!';
          // compute anchored screen position
          try {
            const cam = this.sceneManager.getCamera();
            const canvas = document.getElementById('game-canvas') as HTMLCanvasElement | null;
            const targetPos = (obj.mesh && obj.mesh.position) ? obj.mesh.position : (obj.position || (obj.getWorldPosition ? obj.getWorldPosition(new THREE.Vector3()) : undefined));
            if (cam && canvas && targetPos) {
              const vec = (targetPos as THREE.Vector3).clone().project(cam);
              if (vec.z < 1 && vec.z > -1) {
                const crect = canvas.getBoundingClientRect();
                const x = (vec.x * 0.5 + 0.5) * crect.width + crect.left;
                const y = (-vec.y * 0.5 + 0.5) * crect.height + crect.top;
                if (typeof uiMgr.showDialogue === 'function') uiMgr.showDialogue(title, body, x, y - 16);
                else uiMgr.showSpeechBubbleTimed(title, body, x, y - 16, 4);
              }
            }
          } catch (e) { }
        } catch (e) { }
      });
    } catch (e) { }

    // Audio manager (if provided globally)
    this.audioManager = (window as any).audioManager as AudioManager | undefined;
    // Debug: toggle camera presets with F1 (cycles through default/close/wide)
    try {
      let presetIndex = 0; const presets: ('default'|'close'|'wide')[] = ['default', 'close', 'wide'];
      this.boundHandlers.f1KeyHandler = (ev: KeyboardEvent) => {
        try {
          if (ev.key === 'F1') {
            ev.preventDefault();
            presetIndex = (presetIndex + 1) % presets.length;
            try { this.cameraController.applyPreset(presets[presetIndex]); console.info('[Engine] camera preset ->', presets[presetIndex]); } catch (e) {}
          }
        } catch (e) {}
      };
      window.addEventListener('keydown', this.boundHandlers.f1KeyHandler);
    } catch (e) {}
  }

  // Allow external code to enable/disable player input and pointer lock behavior
  public setControlsEnabled(enabled: boolean) {
    try {
      (this.inputManager as any).controlsEnabled = !!enabled;
      // If disabling controls, ensure action/reset states
      if (!enabled) {
        try { this.inputManager.resetAction(); } catch (e) { }
      }
    } catch (e) { }
  }

  // Separately initialize post-processing after Engine is constructed
  public async initPostProcessing(): Promise<void> {
    try {
      await this.renderer.setupPostProcessing(this.sceneManager.getScene(), this.sceneManager.getCamera());
    } catch (e) {
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
    } catch (e) {
      this.player.update(input, deltaTime, undefined, this.inputManager);
    }

    // Update camera (pass deltaTime for time-based damping)
    this.cameraController.update(deltaTime);
    // Update UI manager (reposition anchored bubbles, tooltips)
    try {
      const uiMgrTmp = (window as any).uiManager as any;
      if (uiMgrTmp && typeof uiMgrTmp.update === 'function') uiMgrTmp.update(deltaTime);
    } catch (e) { }

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
    const uiMgr = (window as any).uiManager;
    // Mailbox / NPC speech bubble: show short lines when player is near (generalized)
    try {
      if (uiMgr && this.objectPlacement) {
        // Build candidate list: mailboxes, houses, emojis and NPCs (if they have bubbleText)
        const candidates: any[] = [];
        if (Array.isArray(this.objectPlacement.mailboxes)) candidates.push(...this.objectPlacement.mailboxes as any[]);
        if (Array.isArray((this.objectPlacement as any).houses)) candidates.push(...(this.objectPlacement as any).houses as any[]);
        if (Array.isArray(this.objectPlacement.emojis)) candidates.push(...this.objectPlacement.emojis as any[]);
        // include NPCs from the island (they provide group with userData and mesh)
        try {
          const npcs = (this.island && typeof (this.island as any).getNPCInstances === 'function') ? (this.island as any).getNPCInstances() : [];
          if (Array.isArray(npcs) && npcs.length) {
            for (const n of npcs) {
              if (n && n.group) candidates.push(n.group);
            }
          }
        } catch (e) { }

        let nearestObj: any = null;
        let nearestDist = 2.0;
        for (const obj of candidates) {
          if (!obj || !obj.mesh) continue;
          const d = obj.mesh.position.distanceTo(playerPos);
          if (d < nearestDist) { nearestObj = obj; nearestDist = d; }
        }

        if (nearestObj) {
          // determine whether to show a bubble (object must provide bubbleText or status)
          const text = (nearestObj as any).bubbleText || ((nearestObj as any).hasDelivery ? 'You have mail!' : undefined) || (nearestObj?.label || undefined);
          if (text) {
            // cooldown per-object to avoid spamming every frame (seconds)
            const now = performance.now() / 1000;
            const last = this._bubbleLastShown.get(nearestObj) || 0;
            const COOLDOWN = 4.0;
            if (now - last >= COOLDOWN) {
              // ask UI manager to show an anchored speech bubble for the world object (uses pool + tail clamping)
              try {
                if (typeof uiMgr.showSpeechBubbleForObject === 'function') {
                  uiMgr.showSpeechBubbleForObject(nearestObj, nearestObj.name || 'NPC', text, 4);
                } else {
                  // fallback to legacy screen-projection path
                  const cam = this.sceneManager.getCamera();
                  const pos = nearestObj.mesh.position.clone();
                  const vec = pos.project(cam);
                  if (vec.z < 1 && vec.z > -1) {
                    const canvas = document.getElementById('game-canvas') as HTMLCanvasElement | null;
                    if (canvas) {
                      const crect = canvas.getBoundingClientRect();
                      const x = (vec.x * 0.5 + 0.5) * crect.width + crect.left;
                      const y = (-vec.y * 0.5 + 0.5) * crect.height + crect.top;
                      if (typeof uiMgr.showSpeechBubbleTimed === 'function') uiMgr.showSpeechBubbleTimed(nearestObj.name || 'NPC', text, x, y - 16, 4);
                      else uiMgr.showSpeechBubble(nearestObj.name || 'NPC', text, x, y - 16);
                    }
                  }
                }
                this._bubbleLastShown.set(nearestObj, now);
              } catch (e) { /* ignore */ }
            }
          }

          // Note: action-press dialogue handling is performed centrally by InteractionSystem.onObjectInteraction
          // to avoid duplicate dialogs. We keep proximity bubble display here but let InteractionSystem handle full
          // anchored dialogues when the player presses the action key.
        }
      }
    } catch (e) { /* non-fatal */ }
    if (nearestEmoji && uiMgr) {
      uiMgr.showEmojiTooltip(nearestEmoji, '😊');
    } else if (uiMgr) {
      uiMgr.hideEmojiTooltip();
    }

    // Show interaction hint above nearest object when close
    try {
      let showHint = false;
      if (uiMgr && this.objectPlacement) {
        // reuse nearestObj logic (simple recompute)
        let nearestObj: any = null; let nearestDist = 2.0;
        const candidates: any[] = [];
        if (Array.isArray(this.objectPlacement.mailboxes)) candidates.push(...this.objectPlacement.mailboxes as any[]);
        if (Array.isArray((this.objectPlacement as any).houses)) candidates.push(...(this.objectPlacement as any).houses as any[]);
        for (const obj of candidates) {
          if (!obj || !obj.mesh) continue;
          const d = obj.mesh.position.distanceTo(playerPos);
          if (d < nearestDist) { nearestObj = obj; nearestDist = d; }
        }
        if (nearestObj) {
          const cam = this.sceneManager.getCamera();
          const vec = nearestObj.mesh.position.clone().project(cam);
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
    } catch (e) { }

    // Update delivery system (check player proximity/actions)
    if (this.deliverySystem) {
      this.deliverySystem.update(this.player, this.objectPlacement.mailboxes, input.action);
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
    const am = (window as any).audioManager as import('./AudioManager').AudioManager | undefined;
    if (am) {
      const pos = this.player.getPosition();
      // Attempt to use camera forward vector for orientation
      const cam = this.sceneManager.getCamera();
      const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion);
      const up = new THREE.Vector3(0, 1, 0).applyQuaternion(cam.quaternion);
      am.updateListener({ x: pos.x, y: pos.y, z: pos.z }, { x: forward.x, y: forward.y, z: forward.z }, { x: up.x, y: up.y, z: up.z });
    }

      // Zone-based ambient audio: play ambient audio for nearest zone within radius
      if (this.audioManager && this.zonesManager) {
        const playerPos = this.player.getPosition();
        const nearby = this.zonesManager.findNearbyZone(playerPos, 12);
        if (nearby) {
          const key = (nearby as any).audioKey || nearby.id;
          // If ambient changed, start new first (fade-in) then stop previous (fade-out) to overlap for crossfade
          if (key !== this.currentAmbientKey) {
            const prev = this.currentAmbientKey;
            // start new ambient
            this.audioManager.playSpatial(key, { x: nearby.getPosition().x, y: nearby.getPosition().y, z: nearby.getPosition().z }, 12);
            // update current key
            this.currentAmbientKey = key;
            // stop previous after initiating new so fade overlaps
            if (prev) this.audioManager.stop(prev);
          } else {
            // update position of existing ambient source
            this.audioManager.updateSpatialPosition(key, { x: nearby.getPosition().x, y: nearby.getPosition().y, z: nearby.getPosition().z });
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
    } catch (e) {
      console.warn('Error disposing InputManager:', e);
    }

    // Clear maps
    this._bubbleLastShown.clear();
  }
}

