import type { Object3D, Vector3 } from 'three';

import { Player } from './Player';
import { Zone, ZonesManager } from './Zones';

export type InteractionCallback = (zone: Zone) => void;
export type InteractableObject =
  | (Object3D & { position: Vector3 })
  | {
      mesh: Object3D & { position: Vector3 };
      [key: string]: unknown;
    };

export class InteractionSystem {
  private player: Player;
  private zonesManager: ZonesManager;
  private interactionDistance: number = 3;
  private onInteractionCallback?: InteractionCallback;
  // provider for interactable world objects (returns array of objects with .mesh)
  private interactableProvider?: () => InteractableObject[];
  // callback invoked when player interacts with a nearby object (E/Action)
  private onObjectInteractionCallback?: (obj: InteractableObject) => void;

  constructor(player: Player, zonesManager: ZonesManager) {
    this.player = player;
    this.zonesManager = zonesManager;
  }

  public onInteraction(callback: InteractionCallback): void {
    this.onInteractionCallback = callback;
  }

  // Register a provider function that returns an array of interactable objects (mailboxes, NPC groups, etc.)
  public setInteractableProvider(provider: () => InteractableObject[]): void {
    this.interactableProvider = provider;
  }

  // Register a callback to be invoked when the player presses the action near an interactable object
  public onObjectInteraction(callback: (obj: InteractableObject) => void): void {
    this.onObjectInteractionCallback = callback;
  }

  public getNearbyZone(): Zone | null {
    return this.zonesManager.findNearbyZone(
      this.player.getPosition(),
      this.interactionDistance
    );
  }

  // Find the nearest interactable object from the provider (within interactionDistance)
  public getNearbyInteractable(): InteractableObject | null {
    try {
      if (!this.interactableProvider) return null;
      const list = this.interactableProvider() || [];
      if (!Array.isArray(list) || list.length === 0) return null;
      const pos = this.player.getPosition();
      let nearest: InteractableObject | null = null;
      let nearestDist = this.interactionDistance;
      for (const obj of list) {
        try {
          const mesh = 'mesh' in obj ? obj.mesh : obj;
          if (!mesh?.position) continue;
          const d = mesh.position.distanceTo(pos);
          if (d < nearestDist) {
            nearest = obj;
            nearestDist = d;
          }
        } catch {
          /* ignore per-object errors */
        }
      }
      return nearest;
    } catch {
      return null;
    }
  }

  public setInteractionDistance(distance: number): void {
    this.interactionDistance = distance;
  }

  // Update: check for nearby zones as before, and also trigger object interaction callbacks
  public update(actionPressed: boolean): void {
    // preserve existing zone behavior
    const nearbyZone = this.zonesManager.findNearbyZone(
      this.player.getPosition(),
      this.interactionDistance
    );

    if (nearbyZone && actionPressed && this.onInteractionCallback) {
      this.onInteractionCallback(nearbyZone);
    }

    // Check for nearby interactable objects and invoke callback when action pressed
    if (this.onObjectInteractionCallback && this.interactableProvider) {
      try {
        const obj = this.getNearbyInteractable();
        if (obj && actionPressed) {
          this.onObjectInteractionCallback(obj);
        }
      } catch {
        /* tolerate errors */
      }
    }
  }
}
