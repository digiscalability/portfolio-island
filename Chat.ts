import * as THREE from 'three';

import { cleanChatText } from './Moderation';

export const PROXIMITY_RADIUS = 17.5; // scaled 14→17.5 with the R40→50 grow (×50/40) so voice/text proximity + the coach-mark keep the same fraction of the (now bigger) world's reach
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
  return t * t * (3 - 2 * t); // smoothstep
}

interface Bubble {
  sprite: THREE.Sprite;
  until: number;
  parent: THREE.Object3D;
}

/** A voice clip currently playing, spatialised via a PannerNode that tracks the
 *  speaker's avatar every frame so the sound emanates FROM the character. */
interface ActiveVoice {
  panner: PannerNode;
  avatar: THREE.Object3D | null;
}

/** The slice of Multiplayer that Chat needs. Multiplayer implements this. */
export interface ChatHost {
  /** Send a wire message through the active transport (RTDB/WS/BroadcastChannel). */
  sendWire(msg: {
    kind: 'chat' | 'voice';
    id: string;
    text?: string;
    audio?: string;
    dur?: number;
  }): void;
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

  private mediaRecorder: MediaRecorder | null = null;
  private recChunks: BlobPart[] = [];
  private recStopTimer = 0;
  private micStream: MediaStream | null = null;
  private audioCtx: AudioContext | null = null;
  private activeVoices: ActiveVoice[] = [];
  private static readonly _vp = new THREE.Vector3();
  private starting = false;
  // Fired when recording TRULY begins (mic granted + recorder started) and when
  // it ends — so the UI never shows "Recording" while a permission prompt is up
  // or after a denial. The UI subscribes to drive the on-screen indicator.
  private onRecStart: (() => void) | null = null;
  private onRecStop: (() => void) | null = null;
  public setOnRecordingStart(cb: () => void): void {
    this.onRecStart = cb;
  }
  public setOnRecordingStop(cb: () => void): void {
    this.onRecStop = cb;
  }
  public readonly voiceSupported =
    typeof navigator !== 'undefined' &&
    !!navigator.mediaDevices?.getUserMedia &&
    typeof MediaRecorder !== 'undefined' &&
    MediaRecorder.isTypeSupported('audio/webm;codecs=opus');

  constructor(host: ChatHost) {
    this.host = host;
    try {
      const saved = localStorage.getItem('ds_muted_peers');
      if (saved) this.muted = new Set(JSON.parse(saved) as string[]);
    } catch {
      /* none */
    }
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
  public onWire(msg: {
    kind: string;
    id: string;
    text?: string;
    audio?: string;
    dur?: number;
  }): void {
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
    if (msg.kind === 'voice' && msg.audio) {
      if (msg.audio.length > 60000) return; // defense-in-depth: WS/BroadcastChannel lack RTDB's size rule
      const dist = this.host.getSelfWorldPosition().distanceTo(peerPos);
      void this.playClip(msg.audio, this.host.getPeerAvatar(msg.id), peerPos, dist);
    }
  }

  /** Toggle client-side mute of a peer (drops their text AND voice). Persisted.
   *  Returns the new muted state. */
  public toggleMute(id: string): boolean {
    if (this.muted.has(id)) this.muted.delete(id);
    else this.muted.add(id);
    try {
      localStorage.setItem('ds_muted_peers', JSON.stringify([...this.muted]));
    } catch {
      /* ignore */
    }
    return this.muted.has(id);
  }

  /** Is this peer currently muted? */
  public isMuted(id: string): boolean {
    return this.muted.has(id);
  }

  /** Begin recording (push-to-talk DOWN). Prompts for mic the first time;
   *  subsequent holds re-acquire a fresh stream (permission persists
   *  per-origin so this does NOT re-prompt — only tens of ms of device-open
   *  latency) so the mic is never left open between clips.
   *  No-op if voice unsupported, already recording, or already starting. */
  public async startRecording(): Promise<void> {
    if (!this.voiceSupported || this.mediaRecorder || this.starting) return;
    this.starting = true;
    try {
      this.micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      this.recChunks = [];
      // Pin a low, speech-grade bitrate. Without this the browser default
      // (~48–128 kbps) makes a full-length (VOICE_MAX_MS) clip 48–100KB, which
      // blows past VOICE_MAX_BYTES and finishRecording silently drops it — so
      // longer clips never relayed. 24 kbps × 8s ≈ 24KB, well under the cap, and
      // opus at 24 kbps is clear for voice.
      const mr = new MediaRecorder(this.micStream, {
        mimeType: 'audio/webm;codecs=opus',
        audioBitsPerSecond: 24000,
      });
      mr.ondataavailable = (e) => {
        if (e.data.size) this.recChunks.push(e.data);
      };
      mr.onstop = () => void this.finishRecording();
      this.mediaRecorder = mr;
      mr.start();
      this.onRecStart?.(); // recording is truly live now — show the indicator
      this.recStopTimer = window.setTimeout(() => this.stopRecording(), VOICE_MAX_MS);
    } catch {
      this.releaseMic();
      this.mediaRecorder = null; // denied/unavailable — voice off, text unaffected
    } finally {
      this.starting = false;
    }
  }

  /** Stop recording (push-to-talk UP, or auto at VOICE_MAX_MS). */
  public stopRecording(): void {
    if (this.recStopTimer) {
      clearTimeout(this.recStopTimer);
      this.recStopTimer = 0;
    }
    const wasActive = !!this.mediaRecorder && this.mediaRecorder.state !== 'inactive';
    if (wasActive) this.mediaRecorder!.stop();
    // Hide the indicator the instant capture ends (on release or auto-stop),
    // not after the async encode/send in finishRecording.
    if (wasActive) this.onRecStop?.();
  }

  /** Release the mic (stop all tracks) so the browser/OS mic-in-use
   *  indicator turns off between clips — the privacy contract is that the
   *  mic is only live while the talk button is held. */
  private releaseMic(): void {
    if (this.micStream) {
      this.micStream.getTracks().forEach((t) => t.stop());
      this.micStream = null;
    }
  }

  /** Recorder stopped: package chunks, enforce the size budget, send or
   *  drop — and release the mic on every path (sent, too big, or empty). */
  private async finishRecording(): Promise<void> {
    const mr = this.mediaRecorder;
    this.mediaRecorder = null;
    try {
      if (!mr || this.recChunks.length === 0) return;
      const blob = new Blob(this.recChunks, { type: 'audio/webm;codecs=opus' });
      const buf = await blob.arrayBuffer();
      if (!voiceClipFits(buf.byteLength, VOICE_MAX_BYTES)) return; // too long/big — drop
      const audio = Chat.arrayBufferToBase64(buf);
      this.host.sendWire({ kind: 'voice', id: this.host.selfId, audio });
    } finally {
      this.releaseMic();
    }
  }

  /** ArrayBuffer → base64 string, for putting a binary clip on a JSON wire. */
  private static arrayBufferToBase64(buf: ArrayBuffer): string {
    let binary = '';
    const bytes = new Uint8Array(buf);
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
  }

  /** base64 string → ArrayBuffer, the inverse of arrayBufferToBase64. */
  private static base64ToArrayBuffer(b64: string): ArrayBuffer {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes.buffer;
  }

  /** Decode + play an incoming voice clip so it emanates FROM the speaker: a
   *  PannerNode positioned at their avatar (and tracked each frame in update()),
   *  played through the game's shared AudioContext whose listener follows the
   *  camera — the same 3D sound field as the rest of the game audio. Falls back
   *  to a flat distance-gain only if the game audio context isn't up yet. A
   *  transient 🔊 indicator rides the avatar; cleaned up on end and on failure. */
  private async playClip(
    audioB64: string,
    avatar: THREE.Object3D | null,
    speakerPos: THREE.Vector3,
    dist: number,
  ): Promise<void> {
    let indicator: THREE.Sprite | null = null;
    let active: ActiveVoice | null = null;
    const cleanup = () => {
      if (indicator && avatar) {
        avatar.remove(indicator);
        (indicator.material as THREE.SpriteMaterial).map?.dispose();
        indicator.material.dispose();
        indicator = null;
      }
      if (active) {
        const i = this.activeVoices.indexOf(active);
        if (i >= 0) this.activeVoices.splice(i, 1);
        active = null;
      }
    };
    try {
      const gameCtx = Chat.getGameAudioCtx();
      const ctx = gameCtx ?? this.ensureOwnCtx();
      if (!ctx) return; // no Web Audio → skip playback
      // Don't resume a master-muted ctx — the HUD mute suspends it on purpose,
      // and resuming here used to un-mute music+sfx as a side effect.
      if (ctx.state === 'suspended' && !Chat.masterMuted()) void ctx.resume().catch(() => {});
      const buf = await ctx.decodeAudioData(Chat.base64ToArrayBuffer(audioB64));
      const src = ctx.createBufferSource();
      src.buffer = buf;
      if (gameCtx) {
        // Spatial: place the sound at the speaker; the camera-driven listener
        // does the panning + distance falloff, so it comes from their direction.
        const panner = ctx.createPanner();
        panner.panningModel = 'HRTF';
        panner.distanceModel = 'linear';
        panner.refDistance = 1;
        panner.maxDistance = PROXIMITY_RADIUS; // fully faded by the proximity edge
        panner.rolloffFactor = 1;
        Chat.setPannerPosition(panner, avatar ? avatar.getWorldPosition(Chat._vp) : speakerPos);
        // Through the master bus: the one HUD mute/volume covers peer voice too.
        src.connect(panner).connect(Chat.getGameAudioDest() ?? ctx.destination);
        active = { panner, avatar };
        this.activeVoices.push(active);
      } else {
        // Fallback (audio system not up): flat gain by distance, non-directional.
        const gain = ctx.createGain();
        gain.gain.value = distanceGain(dist, PROXIMITY_RADIUS);
        src.connect(gain).connect(ctx.destination);
      }
      if (avatar) {
        indicator = Chat.makeBubbleSprite('🔊');
        indicator.position.set(0, 2.1, 0);
        avatar.add(indicator);
      }
      src.onended = cleanup;
      src.start();
    } catch {
      // undecodable / autoplay-blocked / etc. — clean up, then silently skip.
      cleanup();
    }
  }

  /** The game's shared AudioContext (whose listener the app drives from the
   *  camera each frame). null if the audio system isn't up yet. */
  private static getGameAudioCtx(): AudioContext | null {
    const am = (window as unknown as { audioManager?: { ensureCtx?: () => AudioContext } })
      .audioManager;
    if (am?.ensureCtx) {
      try {
        return am.ensureCtx();
      } catch {
        return null;
      }
    }
    return null;
  }

  /** The AudioManager master bus (one mute/volume for everything), if up. */
  private static getGameAudioDest(): AudioNode | null {
    const am = (window as unknown as { audioManager?: { getDestination?: () => AudioNode } })
      .audioManager;
    try {
      return am?.getDestination?.() ?? null;
    } catch {
      return null;
    }
  }

  /** Whether the app-wide HUD mute is on (false when audio isn't up yet). */
  private static masterMuted(): boolean {
    const am = (window as unknown as { audioManager?: { isMuted?: () => boolean } }).audioManager;
    try {
      return am?.isMuted?.() ?? false;
    } catch {
      return false;
    }
  }

  /** Lazily create Chat's own AudioContext (fallback playback path only). */
  private ensureOwnCtx(): AudioContext | null {
    if (this.audioCtx) return this.audioCtx;
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    this.audioCtx = new Ctor();
    return this.audioCtx;
  }

  /** Move a PannerNode to a world position (AudioParam API). */
  private static setPannerPosition(panner: PannerNode, p: THREE.Vector3): void {
    panner.positionX.value = p.x;
    panner.positionY.value = p.y;
    panner.positionZ.value = p.z;
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
    // Bottom-anchored bubble: 2.05 is its BOTTOM edge, 0.1 above the name
    // label's top (label centre 1.75 + 0.2 half-height); any number of
    // wrapped lines grows upward, never down into the label or hat.
    sprite.position.set(0, 2.05, 0);
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
    // Keep each playing voice glued to its speaker's avatar as they move.
    for (const v of this.activeVoices) {
      if (v.avatar) Chat.setPannerPosition(v.panner, v.avatar.getWorldPosition(Chat._vp));
    }
  }

  /** Tear down: drop all live bubbles and free their textures/materials,
   *  plus any voice state (in-flight recorder, mic, audio context). */
  public dispose(): void {
    for (const b of this.bubbles) this.disposeBubble(b);
    this.bubbles = [];
    if (this.recStopTimer) {
      clearTimeout(this.recStopTimer);
      this.recStopTimer = 0;
    }
    if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') this.mediaRecorder.stop();
    this.releaseMic();
    void this.audioCtx?.close().catch(() => {});
    this.audioCtx = null;
  }

  /** Word-wrapped speech bubble on a canvas → sprite (mirrors Multiplayer.makeTextSprite). */
  private static makeBubbleSprite(text: string): THREE.Sprite {
    const canvas = document.createElement('canvas');
    const pad = 16,
      lineH = 30,
      maxW = 260,
      font = '600 24px system-ui, sans-serif';
    const ctx = canvas.getContext('2d');
    if (!ctx) return new THREE.Sprite(new THREE.SpriteMaterial());
    ctx.font = font;
    const words = text.split(' ');
    const lines: string[] = [];
    let line = '';
    for (const w of words) {
      const test = line ? `${line} ${w}` : w;
      if (ctx.measureText(test).width > maxW && line) {
        lines.push(line);
        line = w;
      } else line = test;
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
    const scale = 0.01; // canvas px → world units
    sprite.scale.set(canvas.width * scale, canvas.height * scale, 1);
    // Bottom-anchored: bubble height varies with line count, and a centre-
    // anchored multi-line bubble grew DOWN into the name label / head. The
    // position now pins the bubble's bottom edge; extra lines grow upward.
    sprite.center.set(0.5, 0);
    return sprite;
  }
}
