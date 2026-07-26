import * as THREE from 'three';
import { cleanChatText } from './Moderation';

export const PROXIMITY_RADIUS = 14;
export const BUBBLE_TTL = 6;
export const TEXT_MAX = 120;
export const VOICE_MAX_MS = 8000;
export const VOICE_MAX_BYTES = 40_000;

/** Is `peer` within `radius` world-units of `local`? (inclusive boundary) */
export function withinProximity(
  local: THREE.Vector3,
  peer: THREE.Vector3,
  radius: number,
): boolean {
  return local.distanceTo(peer) <= radius;
}

/** Guard: reject an over-budget voice clip before it hits the wire. */
export function voiceClipFits(byteLength: number, max: number): boolean {
  return byteLength <= max;
}

/** Smoothstep gain: 1 at distance 0, easing to 0 at `radius`, 0 beyond. */
export function distanceGain(dist: number, radius: number): number {
  if (dist <= 0) return 1;
  if (dist >= radius) return 0;
  const t = 1 - dist / radius; // 1 near → 0 far
  return t * t * (3 - 2 * t);  // smoothstep
}

interface Bubble { sprite: THREE.Sprite; until: number; parent: THREE.Object3D; }

/** The slice of Multiplayer that Chat needs. Multiplayer implements this. */
export interface ChatHost {
  /** Send a wire message through the active transport (RTDB/WS/BroadcastChannel). */
  sendWire(msg: { kind: 'chat' | 'voice'; id: string; text?: string; audio?: string; dur?: number }): void;
  /** Local player's world position (cloned; safe to keep). */
  getSelfWorldPosition(): THREE.Vector3;
  /** A peer's current world position, or null if unknown/gone. */
  getPeerWorldPosition(id: string): THREE.Vector3 | null;
  /** A peer's avatar group to hang a bubble/indicator on, or null. */
  getPeerAvatar(id: string): THREE.Object3D | null;
  /** Local player object to hang own bubble on. */
  getSelfAvatar(): THREE.Object3D;
  /** Local player's own id (to stamp outgoing + ignore self echoes). */
  readonly selfId: string;
}

export class Chat {
  private host: ChatHost;
  private bubbles: Bubble[] = [];
  private muted = new Set<string>();

  constructor(host: ChatHost) {
    this.host = host;
    try {
      const saved = localStorage.getItem('ds_muted_peers');
      if (saved) this.muted = new Set(JSON.parse(saved) as string[]);
    } catch { /* none */ }
  }

  /** Local player composed a message: sanitize, show over self, broadcast. */
  public sendText(raw: string): void {
    const text = cleanChatText(raw);
    if (!text) return;
    this.showBubble(this.host.getSelfAvatar(), text);
    this.host.sendWire({ kind: 'chat', id: this.host.selfId, text });
  }

  /** Route an incoming wire message from Multiplayer.setChatHandler. Param is
   *  broad (`kind: string`) because setChatHandler is typed with the full
   *  WireMessage union; we narrow on kind below. */
  public onWire(msg: { kind: string; id: string; text?: string; audio?: string; dur?: number }): void {
    if (msg.id === this.host.selfId || this.muted.has(msg.id)) return;
    const peerPos = this.host.getPeerWorldPosition(msg.id);
    if (!peerPos) return; // unknown peer → out of range
    if (!withinProximity(this.host.getSelfWorldPosition(), peerPos, PROXIMITY_RADIUS)) return;
    if (msg.kind === 'chat' && msg.text) {
      const text = cleanChatText(msg.text);
      if (!text) return;
      const avatar = this.host.getPeerAvatar(msg.id);
      if (avatar) this.showBubble(avatar, text);
    }
    // voice handled in a later task
  }

  /** Client-side mute of a peer's messages (persisted). */
  public mutePeer(id: string): void {
    this.muted.add(id);
    try { localStorage.setItem('ds_muted_peers', JSON.stringify([...this.muted])); } catch { /* ignore */ }
  }

  /** Attach a speech-bubble sprite above `parent`, expiring after BUBBLE_TTL.
   *  Replaces any bubble already live on the same parent so rapid messages
   *  from one speaker don't stack overlapping sprites. */
  private showBubble(parent: THREE.Object3D, text: string): void {
    for (let i = this.bubbles.length - 1; i >= 0; i--) {
      if (this.bubbles[i].parent === parent) {
        this.disposeBubble(this.bubbles[i]);
        this.bubbles.splice(i, 1);
      }
    }
    const sprite = Chat.makeBubbleSprite(text);
    sprite.position.set(0, 1.95, 0); // above the name label (which sits at 1.35)
    parent.add(sprite);
    this.bubbles.push({ sprite, until: performance.now() / 1000 + BUBBLE_TTL, parent });
  }

  /** Detach a bubble from its parent and free its texture/material. */
  private disposeBubble(b: Bubble): void {
    b.parent.remove(b.sprite);
    (b.sprite.material as THREE.SpriteMaterial).map?.dispose();
    b.sprite.material.dispose();
  }

  /** Per-frame: fade+expire bubbles. Call from the app update loop. */
  public update(_deltaTime: number): void {
    const now = performance.now() / 1000;
    for (let i = this.bubbles.length - 1; i >= 0; i--) {
      const b = this.bubbles[i];
      const remaining = b.until - now;
      if (remaining <= 0) {
        this.disposeBubble(b);
        this.bubbles.splice(i, 1);
      } else {
        (b.sprite.material as THREE.SpriteMaterial).opacity = Math.min(1, remaining); // fade last second
      }
    }
  }

  /** Tear down: drop all live bubbles and free their textures/materials. */
  public dispose(): void {
    for (const b of this.bubbles) this.disposeBubble(b);
    this.bubbles = [];
  }

  /** Word-wrapped speech bubble on a canvas → sprite (mirrors Multiplayer.makeTextSprite). */
  private static makeBubbleSprite(text: string): THREE.Sprite {
    const canvas = document.createElement('canvas');
    const pad = 16, lineH = 30, maxW = 260, font = '600 24px system-ui, sans-serif';
    const ctx = canvas.getContext('2d');
    if (!ctx) return new THREE.Sprite(new THREE.SpriteMaterial());
    ctx.font = font;
    const words = text.split(' ');
    const lines: string[] = [];
    let line = '';
    for (const w of words) {
      const test = line ? `${line} ${w}` : w;
      if (ctx.measureText(test).width > maxW && line) { lines.push(line); line = w; }
      else line = test;
    }
    if (line) lines.push(line);
    const textW = Math.min(maxW, Math.max(...lines.map((l) => ctx.measureText(l).width)));
    canvas.width = textW + pad * 2;
    canvas.height = lines.length * lineH + pad * 2;
    // Resizing the canvas resets its 2D state, so font must be re-applied
    // before drawing (measurements above already used it once, pre-resize).
    ctx.font = font;
    ctx.fillStyle = 'rgba(20,20,28,0.82)';
    ctx.beginPath();
    ctx.roundRect(0, 0, canvas.width, canvas.height, 14);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    lines.forEach((l, i) => ctx.fillText(l, canvas.width / 2, pad + lineH / 2 + i * lineH));
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    const sprite = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }),
    );
    const scale = 0.010; // canvas px → world units
    sprite.scale.set(canvas.width * scale, canvas.height * scale, 1);
    return sprite;
  }
}
