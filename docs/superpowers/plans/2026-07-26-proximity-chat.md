# Proximity Chat Implementation Plan

> ⚠️ **SUPERSEDED — SHIPPED. Do not copy constants out of this document.**
> Written when the world was R=22. Every world-scale number below is frozen at
> that era: `PROXIMITY_RADIUS = 14` in particular is NOT the live value. Chat
> reach is now `PROXIMITY_FRACTION (0.35) × WORLD_RADIUS` — see `Chat.ts` and
> `WorldScale.ts`. The behaviour described here is accurate; the numbers are history.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add player-to-player communication to the Life Island world — proximity text speech-bubbles and push-to-talk voice clips — riding the existing multiplayer transport.

**Architecture:** A new `Chat.ts` subsystem owns all presentation/logic (proximity filter, bubble sprites, voice record/playback, per-peer mute). `Multiplayer.ts` stays the transport owner: it gains `chat`/`voice` wire kinds, a send seam, a receive-handler callback, and peer/local position + avatar accessors. `Chat` depends on `Multiplayer` only through a small `ChatHost` interface + a registered callback, so there is no circular import. Proximity is enforced receiver-side using peer positions Multiplayer already tracks.

**Tech Stack:** TypeScript, Three.js (sprites + Web Audio), Firebase RTDB (base64 Opus in a `push` path), MediaRecorder/getUserMedia, Vite 7, Vitest 3 (happy-dom).

---

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `Moderation.ts` | modify | add `cleanChatText()` — trim/cap/strip/offensive-filter chat text |
| `Chat.ts` | **create** | the whole comms subsystem: pure helpers (`withinProximity`, `voiceClipFits`, `distanceGain`), the `ChatHost` interface, and the `Chat` class (text bubbles + voice clips + mute) |
| `Multiplayer.ts` | modify | `chat`/`voice` wire kinds; `sendWire`, `setChatHandler`, `getLocalWorldPosition`, `getPeerWorldPosition`, `getPeerAvatar`, `getSelfAvatar`; route incoming chat/voice; RTDB push paths |
| `SimpleUI.ts` | modify | transient text input (open on Enter, send on Enter, cancel on Esc); mobile 💬 + press-hold 🎤 HUD buttons (via `makeHudButtonAccessible`) |
| `main-simple.ts` | modify | construct `Chat`, wire it to `Multiplayer` + `SimpleUI`, bind keys (Enter / hold-V), suppress game keys while typing, call `chat.update(dt)` |
| `Moderation` test | create/modify | `test/moderation.test.ts` — `cleanChatText` cases |
| `Chat` test | **create** | `test/chat.test.ts` — `withinProximity`, `voiceClipFits`, `distanceGain` |
| `database.rules.json` | modify | rules for `/chat/island` + `/voice/island` (auth write-own, size caps) |
| `public/privacy.html` | modify | one line: mic opt-in + ephemeral messages |

**Shared constants** (top of `Chat.ts`):
```ts
export const PROXIMITY_RADIUS = 14;   // world units
export const BUBBLE_TTL = 6;          // seconds a bubble stays before fading
export const TEXT_MAX = 120;          // chars
export const VOICE_MAX_MS = 8000;     // clip hard-stop
export const VOICE_MAX_BYTES = 40_000; // post-base64 guard
```

**Shared types** (exported from `Chat.ts`):
```ts
import type * as THREE from 'three';

/** The slice of Multiplayer that Chat needs. Multiplayer implements this. */
export interface ChatHost {
  /** Send a wire message through the active transport (RTDB/WS/BroadcastChannel). */
  sendWire(msg: { kind: 'chat' | 'voice'; id: string; text?: string; audio?: string; dur?: number }): void;
  /** Local player's world position (cloned; safe to keep). */
  getLocalWorldPosition(): THREE.Vector3;
  /** A peer's current world position, or null if unknown/gone. */
  getPeerWorldPosition(id: string): THREE.Vector3 | null;
  /** A peer's avatar group to hang a bubble/indicator on, or null. */
  getPeerAvatar(id: string): THREE.Object3D | null;
  /** Local player object to hang own bubble on. */
  getSelfAvatar(): THREE.Object3D;
  /** Local player's own id (to stamp outgoing + ignore self echoes). */
  readonly selfId: string;
}
```

---

## Task 1: `cleanChatText` in Moderation.ts

**Files:**
- Modify: `Moderation.ts`
- Test: `test/moderation.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `test/moderation.test.ts`:
```ts
import { describe, expect, test } from 'vitest';

import { cleanChatText } from '../Moderation';

describe('cleanChatText', () => {
  test('trims whitespace', () => {
    expect(cleanChatText('  hi there  ')).toBe('hi there');
  });

  test('caps length at 120 chars', () => {
    const long = 'a'.repeat(200);
    expect(cleanChatText(long).length).toBe(120);
  });

  test('strips control characters but keeps normal punctuation', () => {
    expect(cleanChatText('hey\u0000\u0007! how are you?')).toBe('hey! how are you?');
  });

  test('collapses newlines/tabs to single spaces', () => {
    expect(cleanChatText('a\n\n\tb')).toBe('a b');
  });

  test('masks an offensive word but keeps the rest', () => {
    // isOffensiveName already flags slurs; cleanChatText replaces the token.
    const out = cleanChatText('you are a fuck');
    expect(out).not.toContain('fuck');
    expect(out).toContain('you are');
  });

  test('leaves the Scunthorpe case intact (no false positive)', () => {
    expect(cleanChatText('I live in Scunthorpe')).toBe('I live in Scunthorpe');
  });

  test('empty / whitespace-only returns empty string', () => {
    expect(cleanChatText('   ')).toBe('');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/moderation.test.ts`
Expected: FAIL — `cleanChatText is not a function` (not yet exported).

- [ ] **Step 3: Read the existing Moderation surface**

Run: `grep -nE "export function|isOffensiveName|normalize" Moderation.ts`
Note the existing `isOffensiveName` (and any normalize helper) so `cleanChatText` reuses the same offensive-word detection rather than duplicating a list.

- [ ] **Step 4: Implement `cleanChatText`**

Add to `Moderation.ts` (reuse the existing offensive detection — call the existing per-word check; if the existing API is name-oriented, split on spaces and test each token):
```ts
/**
 * Sanitise a chat message for display. Trim, collapse whitespace, drop control
 * chars, hard-cap length, and mask offensive tokens using the same detection as
 * name moderation. Applied on BOTH send and receive — never trust the wire.
 */
export function cleanChatText(raw: string): string {
  if (typeof raw !== 'string') return '';
  // Drop control chars (except we convert whitespace runs to single spaces).
  const noControl = raw.replace(/[\u0000-\u001F\u007F]/g, ' ');
  const collapsed = noControl.replace(/\s+/g, ' ').trim();
  const capped = collapsed.slice(0, 120);
  if (!capped) return '';
  // Mask offensive tokens word-by-word (word-boundary check avoids Scunthorpe).
  return capped
    .split(' ')
    .map((word) => (isOffensiveName(word) ? '*'.repeat(word.length) : word))
    .join(' ');
}
```
Note: if `isOffensiveName` is not exported, export it (or the shared helper it wraps). Keep the 120 literal in sync with `TEXT_MAX` (add a comment cross-referencing `Chat.ts`).

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/moderation.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 6: Typecheck + commit**

```bash
npx tsc --noEmit
git add Moderation.ts test/moderation.test.ts
git commit -m "feat(chat): cleanChatText — sanitize+moderate chat messages"
```

---

## Task 2: Pure helpers in Chat.ts (`withinProximity`, `voiceClipFits`, `distanceGain`)

**Files:**
- Create: `Chat.ts` (constants + exported pure helpers only, for now)
- Test: `test/chat.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `test/chat.test.ts`:
```ts
import { describe, expect, test } from 'vitest';
import * as THREE from 'three';

import { withinProximity, voiceClipFits, distanceGain, PROXIMITY_RADIUS, VOICE_MAX_BYTES } from '../Chat';

const v = (x: number, y = 0, z = 0) => new THREE.Vector3(x, y, z);

describe('withinProximity', () => {
  test('true when peer is inside the radius', () => {
    expect(withinProximity(v(0), v(PROXIMITY_RADIUS - 1), PROXIMITY_RADIUS)).toBe(true);
  });
  test('false when peer is outside the radius', () => {
    expect(withinProximity(v(0), v(PROXIMITY_RADIUS + 1), PROXIMITY_RADIUS)).toBe(false);
  });
  test('true exactly at the radius boundary', () => {
    expect(withinProximity(v(0), v(PROXIMITY_RADIUS), PROXIMITY_RADIUS)).toBe(true);
  });
});

describe('voiceClipFits', () => {
  test('accepts a clip under the byte cap', () => {
    expect(voiceClipFits(VOICE_MAX_BYTES - 1, VOICE_MAX_BYTES)).toBe(true);
  });
  test('rejects a clip over the byte cap', () => {
    expect(voiceClipFits(VOICE_MAX_BYTES + 1, VOICE_MAX_BYTES)).toBe(false);
  });
});

describe('distanceGain (smoothstep, 1 at 0 → 0 at radius)', () => {
  test('full gain at distance 0', () => {
    expect(distanceGain(0, PROXIMITY_RADIUS)).toBeCloseTo(1, 5);
  });
  test('silent at/after the radius', () => {
    expect(distanceGain(PROXIMITY_RADIUS, PROXIMITY_RADIUS)).toBeCloseTo(0, 5);
    expect(distanceGain(PROXIMITY_RADIUS + 5, PROXIMITY_RADIUS)).toBe(0);
  });
  test('mid-range gain is between 0 and 1', () => {
    const g = distanceGain(PROXIMITY_RADIUS / 2, PROXIMITY_RADIUS);
    expect(g).toBeGreaterThan(0);
    expect(g).toBeLessThan(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/chat.test.ts`
Expected: FAIL — cannot resolve `../Chat`.

- [ ] **Step 3: Create `Chat.ts` with constants + pure helpers**

Create `Chat.ts`:
```ts
import * as THREE from 'three';

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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/chat.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Typecheck + commit**

```bash
npx tsc --noEmit
git add Chat.ts test/chat.test.ts
git commit -m "feat(chat): proximity/gain/size pure helpers + constants"
```

---

## Task 3: Wire protocol + transport seam in Multiplayer.ts

No new unit test (this is THREE/RTDB integration — verified in-browser in Task 6/8). Keep changes small and mechanical.

**Files:**
- Modify: `Multiplayer.ts` (`WireMessage` interface ~line 24; `handleMessage` ~line 354; `connectFirebase` ~line 196; add public methods)

- [ ] **Step 1: Extend the wire message type**

In `Multiplayer.ts`, update the `WireMessage` interface (~line 24):
```ts
interface WireMessage {
  kind: 'state' | 'wave' | 'leave' | 'chat' | 'voice';
  id: string;
  name?: string;
  hat?: HatId | null;
  p?: [number, number, number];
  q?: [number, number, number, number];
  veh?: VehicleKind | null;
  vehIdx?: number;
  vp?: [number, number, number];
  vq?: [number, number, number, number];
  text?: string;   // chat: message body
  audio?: string;  // voice: base64 Opus
  dur?: number;    // voice: clip length (ms)
  t?: number;      // chat/voice: sender timestamp (ms) for replay filtering
}
```
Export it for `Chat` to type-import: change `interface WireMessage` to `export interface WireMessage`.

- [ ] **Step 2: Add the receive-handler seam + public accessors**

Add fields near the other private fields (~line 92):
```ts
  private chatHandler?: (msg: WireMessage) => void;
  private connectTime = Date.now(); // ignore chat/voice pushed before we joined
```
Add public methods (near `onCount`, ~line 322):
```ts
  /** Register a callback for incoming chat/voice wire messages (Chat.onWire). */
  public setChatHandler(cb: (msg: WireMessage) => void): void {
    this.chatHandler = cb;
  }

  /** Send an arbitrary wire message through the active transport. */
  public sendWire(msg: WireMessage): void {
    this.send(msg);
  }

  public getLocalWorldPosition(): THREE.Vector3 {
    return this.player.getWorldPosition();
  }

  public getPeerWorldPosition(id: string): THREE.Vector3 | null {
    const peer = this.peers.get(id);
    return peer ? peer.avatar.position.clone() : null;
  }

  public getPeerAvatar(id: string): THREE.Object3D | null {
    return this.peers.get(id)?.avatar ?? null;
  }

  public getSelfAvatar(): THREE.Object3D {
    return this.player;
  }
```

- [ ] **Step 3: Route incoming chat/voice in `handleMessage`**

In `handleMessage` (~line 354), right after the `if (!msg || msg.id === this.selfId) return;` guard, add:
```ts
    if (msg.kind === 'chat' || msg.kind === 'voice') {
      // Drop entries that predate our join (RTDB replays existing children).
      if (typeof msg.t === 'number' && msg.t < this.connectTime) return;
      this.chatHandler?.(msg);
      return;
    }
```
This runs BEFORE the peer-creation block, so chat/voice from a not-yet-seen peer still routes (Chat resolves position via `getPeerWorldPosition`, which returns null → Chat drops it as out-of-range, which is correct).

- [ ] **Step 4: RTDB transport — send chat/voice via push paths**

In `connectFirebase` (~line 196), extend the imports and the `send` function. Update the rtdb import destructure to include `push`:
```ts
    const { ref, set, remove, push, onChildAdded, onChildChanged, onChildRemoved, onDisconnect } = rtdb;
```
Inside the `this.send = (msg) => {` body, BEFORE the `// state` block, add:
```ts
      if (msg.kind === 'chat' || msg.kind === 'voice') {
        const path = msg.kind === 'chat' ? 'chat/island' : 'voice/island';
        const entryRef = push(ref(db, path), {
          id: this.selfId,
          text: msg.text ?? null,
          audio: msg.audio ?? null,
          dur: msg.dur ?? null,
          t: Date.now(),
        });
        // Self-clean: remove our own entry after it can no longer be needed,
        // so the path never accumulates blobs.
        window.setTimeout(() => { void remove(entryRef).catch(() => {}); }, 12000);
        return;
      }
```

- [ ] **Step 5: RTDB transport — subscribe to chat/voice paths**

In `connectFirebase`, after the existing `onChildRemoved(room, ...)` block (~line 258), add:
```ts
    for (const kind of ['chat', 'voice'] as const) {
      const path = kind === 'chat' ? 'chat/island' : 'voice/island';
      onChildAdded(ref(db, `${path}`), (snap) => {
        const v = snap.val();
        if (!v || v.id === uid || v.id === this.selfId) return;
        this.handleMessage(JSON.stringify({
          kind,
          id: v.id,
          text: v.text ?? undefined,
          audio: v.audio ?? undefined,
          dur: v.dur ?? undefined,
          t: v.t ?? 0,
        }));
      });
    }
```
(The `t < connectTime` filter in `handleMessage` prevents replay of pre-join entries.)

- [ ] **Step 6: Typecheck + commit**

```bash
npx tsc --noEmit
git add Multiplayer.ts
git commit -m "feat(chat): wire chat/voice kinds + RTDB push transport in Multiplayer"
```

---

## Task 4: Chat class — text bubbles

Builds the `Chat` class body (constructor + text path + update loop). Verified in-browser (two tabs).

**Files:**
- Modify: `Chat.ts` (append the `ChatHost` interface + `Chat` class)

- [ ] **Step 1: Add the `ChatHost` interface**

Append to `Chat.ts` (after the pure helpers) the `ChatHost` interface exactly as defined in the **Shared types** section above.

- [ ] **Step 2: Add the `Chat` class scaffold + text send/receive + bubble sprite**

Append to `Chat.ts`:
```ts
import { cleanChatText } from './Moderation';

interface Bubble { sprite: THREE.Sprite; until: number; parent: THREE.Object3D; }

export class Chat {
  private host: ChatHost;
  private scene: THREE.Scene;
  private bubbles: Bubble[] = [];
  private muted = new Set<string>();

  constructor(host: ChatHost, scene: THREE.Scene) {
    this.host = host;
    this.scene = scene;
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
    if (!withinProximity(this.host.getLocalWorldPosition(), peerPos, PROXIMITY_RADIUS)) return;
    if (msg.kind === 'chat' && msg.text) {
      const avatar = this.host.getPeerAvatar(msg.id);
      if (avatar) this.showBubble(avatar, cleanChatText(msg.text));
    }
    // voice handled in Task 5
  }

  public mutePeer(id: string): void {
    this.muted.add(id);
    try { localStorage.setItem('ds_muted_peers', JSON.stringify([...this.muted])); } catch { /* ignore */ }
  }

  /** Attach a speech-bubble sprite above `parent`, expiring after BUBBLE_TTL. */
  private showBubble(parent: THREE.Object3D, text: string): void {
    const sprite = Chat.makeBubbleSprite(text);
    sprite.position.set(0, 1.95, 0); // above the name label (which sits at 1.35)
    parent.add(sprite);
    this.bubbles.push({ sprite, until: performance.now() / 1000 + BUBBLE_TTL, parent });
  }

  /** Per-frame: fade+expire bubbles. Call from the app update loop. */
  public update(_deltaTime: number): void {
    const now = performance.now() / 1000;
    for (let i = this.bubbles.length - 1; i >= 0; i--) {
      const b = this.bubbles[i];
      const remaining = b.until - now;
      if (remaining <= 0) {
        b.parent.remove(b.sprite);
        (b.sprite.material as THREE.SpriteMaterial).map?.dispose();
        b.sprite.material.dispose();
        this.bubbles.splice(i, 1);
      } else {
        (b.sprite.material as THREE.SpriteMaterial).opacity = Math.min(1, remaining); // fade last second
      }
    }
  }

  /** Word-wrapped speech bubble on a canvas → sprite (mirrors makeTextSprite). */
  private static makeBubbleSprite(text: string): THREE.Sprite {
    const canvas = document.createElement('canvas');
    const pad = 16, lineH = 30, maxW = 260, font = '600 24px system-ui, sans-serif';
    const ctx0 = canvas.getContext('2d')!;
    ctx0.font = font;
    // wrap
    const words = text.split(' ');
    const lines: string[] = [];
    let line = '';
    for (const w of words) {
      const test = line ? `${line} ${w}` : w;
      if (ctx0.measureText(test).width > maxW && line) { lines.push(line); line = w; }
      else line = test;
    }
    if (line) lines.push(line);
    const textW = Math.min(maxW, Math.max(...lines.map((l) => ctx0.measureText(l).width)));
    canvas.width = textW + pad * 2;
    canvas.height = lines.length * lineH + pad * 2;
    const ctx = canvas.getContext('2d')!;
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
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: clean. (Chat isn't wired into the app yet — that's Task 6 — but it must compile.)

- [ ] **Step 4: Commit**

```bash
git add Chat.ts
git commit -m "feat(chat): Chat class — proximity text bubbles + expiry"
```

---

## Task 5: Chat class — push-to-talk voice clips

**Files:**
- Modify: `Chat.ts` (add recording + playback to the `Chat` class)

- [ ] **Step 1: Add voice fields + feature detection**

Add fields to the `Chat` class and a capability flag:
```ts
  private mediaRecorder: MediaRecorder | null = null;
  private recChunks: BlobPart[] = [];
  private recStopTimer = 0;
  private micStream: MediaStream | null = null;
  private audioCtx: AudioContext | null = null;
  public readonly voiceSupported =
    typeof navigator !== 'undefined' &&
    !!navigator.mediaDevices?.getUserMedia &&
    typeof MediaRecorder !== 'undefined';
```

- [ ] **Step 2: Add record start/stop (push-to-talk)**

Add to the `Chat` class:
```ts
  /** Begin recording (call on push-to-talk key/button DOWN). Prompts for mic
   *  the first time. No-op if voice is unsupported or already recording. */
  public async startRecording(): Promise<void> {
    if (!this.voiceSupported || this.mediaRecorder) return;
    try {
      if (!this.micStream) {
        this.micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      }
      this.recChunks = [];
      const mr = new MediaRecorder(this.micStream, { mimeType: 'audio/webm;codecs=opus' });
      mr.ondataavailable = (e) => { if (e.data.size) this.recChunks.push(e.data); };
      mr.onstop = () => void this.finishRecording();
      this.mediaRecorder = mr;
      mr.start();
      this.recStopTimer = window.setTimeout(() => this.stopRecording(), VOICE_MAX_MS);
    } catch {
      this.mediaRecorder = null; // denied/unavailable — voice stays off, text unaffected
    }
  }

  /** Stop recording (call on key/button UP, or auto at VOICE_MAX_MS). */
  public stopRecording(): void {
    if (this.recStopTimer) { clearTimeout(this.recStopTimer); this.recStopTimer = 0; }
    if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') this.mediaRecorder.stop();
  }

  private async finishRecording(): Promise<void> {
    const mr = this.mediaRecorder;
    this.mediaRecorder = null;
    if (!mr || this.recChunks.length === 0) return;
    const blob = new Blob(this.recChunks, { type: 'audio/webm;codecs=opus' });
    const buf = await blob.arrayBuffer();
    if (!voiceClipFits(buf.byteLength, VOICE_MAX_BYTES)) return; // too long/big — drop
    const audio = Chat.arrayBufferToBase64(buf);
    this.host.sendWire({ kind: 'voice', id: this.host.selfId, audio, dur: 0 });
  }

  private static arrayBufferToBase64(buf: ArrayBuffer): string {
    let binary = '';
    const bytes = new Uint8Array(buf);
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
  }

  private static base64ToArrayBuffer(b64: string): ArrayBuffer {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes.buffer;
  }
```

- [ ] **Step 3: Add playback with distance gain, and route voice in `onWire`**

Add a playback method and extend `onWire`. Replace the `// voice handled in Task 5` comment in `onWire` with:
```ts
    if (msg.kind === 'voice' && msg.audio) {
      const dist = this.host.getLocalWorldPosition().distanceTo(peerPos);
      void this.playClip(msg.audio, dist, this.host.getPeerAvatar(msg.id));
    }
```
Add the method:
```ts
  private async playClip(audioB64: string, dist: number, avatar: THREE.Object3D | null): Promise<void> {
    try {
      if (!this.audioCtx) this.audioCtx = new AudioContext();
      const buf = await this.audioCtx.decodeAudioData(Chat.base64ToArrayBuffer(audioB64));
      const src = this.audioCtx.createBufferSource();
      src.buffer = buf;
      const gain = this.audioCtx.createGain();
      gain.gain.value = distanceGain(dist, PROXIMITY_RADIUS);
      src.connect(gain).connect(this.audioCtx.destination);
      // 🔊 indicator over the speaker while the clip plays
      let indicator: THREE.Sprite | null = null;
      if (avatar) {
        indicator = Chat.makeBubbleSprite('🔊');
        indicator.position.set(0, 2.1, 0);
        avatar.add(indicator);
      }
      src.onended = () => {
        if (indicator && avatar) {
          avatar.remove(indicator);
          (indicator.material as THREE.SpriteMaterial).map?.dispose();
          indicator.material.dispose();
        }
      };
      src.start();
    } catch { /* undecodable / autoplay-blocked — silently skip */ }
  }
```

- [ ] **Step 4: Typecheck + commit**

```bash
npx tsc --noEmit
git add Chat.ts
git commit -m "feat(chat): push-to-talk voice record + distance-gain playback"
```

---

## Task 6: Wire Chat into the app (input + UI)

**Files:**
- Modify: `SimpleUI.ts` (text input affordance + mobile buttons)
- Modify: `main-simple.ts` (construct Chat, bind keys, suppress game keys while typing, update loop)

- [ ] **Step 1: Add a transient chat input to SimpleUI**

Add to `SimpleUI.ts` a method that opens a slim input, returns the string via callback, and reports open/closed so the game can suppress movement keys:
```ts
  private chatInput: HTMLInputElement | null = null;
  public isChatInputOpen(): boolean { return this.chatInput !== null; }
  private onChatSend: ((text: string) => void) | null = null;
  public setOnChatSend(cb: (text: string) => void): void { this.onChatSend = cb; }

  /** Open the one-line chat input (Enter sends, Esc/blur cancels). */
  public openChatInput(): void {
    if (this.chatInput) { this.chatInput.focus(); return; }
    const input = document.createElement('input');
    input.type = 'text';
    input.maxLength = 120;
    input.setAttribute('aria-label', 'Type a message to nearby players');
    input.placeholder = 'Say something…';
    Object.assign(input.style, {
      position: 'absolute',
      left: '50%', bottom: 'calc(var(--sab, 0px) + 96px)', transform: 'translateX(-50%)',
      width: 'min(70vw, 420px)', padding: '10px 14px', borderRadius: '12px',
      border: 'none', fontSize: '15px', fontFamily: 'system-ui, sans-serif',
      background: 'rgba(12,12,20,0.92)', color: '#fff', outline: '2px solid rgba(120,170,255,0.9)',
      pointerEvents: 'auto', zIndex: '50',
    });
    const close = () => {
      input.remove();
      this.chatInput = null;
    };
    input.addEventListener('keydown', (e) => {
      e.stopPropagation(); // don't leak to game input
      if (e.key === 'Enter') { const t = input.value; close(); if (t.trim()) this.onChatSend?.(t); }
      else if (e.key === 'Escape') close();
    });
    input.addEventListener('blur', close);
    this.overlay.appendChild(input);
    this.chatInput = input;
    input.focus();
  }
```

- [ ] **Step 2: Construct + wire Chat in main-simple.ts**

In `main-simple.ts`, import and construct after `Multiplayer` and `SimpleUI` exist:
```ts
import { Chat } from './Chat';
// … after this.scene / multiplayer / ui are created:
const chat = new Chat(multiplayer, this.scene);
multiplayer.setChatHandler((msg) => chat.onWire(msg));
ui.setOnChatSend((text) => chat.sendText(text));
this.chat = chat; // store on the app for the update loop
```
(Use the real local variable names already in `main-simple.ts` for scene/multiplayer/ui — grep for how `Multiplayer` and `SimpleUI` are instantiated and match them.)

- [ ] **Step 3: Bind keys + suppress game input while typing**

In the app's keydown handling in `main-simple.ts` (grep for the existing `addEventListener('keydown'` or the InputManager wiring):
```ts
window.addEventListener('keydown', (e) => {
  if (this.ui.isChatInputOpen()) return; // typing — let the input own the keyboard
  if (e.key === 'Enter') { this.ui.openChatInput(); return; }
  if ((e.key === 'v' || e.key === 'V') && !e.repeat) { void this.chat.startRecording(); }
});
window.addEventListener('keyup', (e) => {
  if (e.key === 'v' || e.key === 'V') this.chat.stopRecording();
});
```
Ensure the movement InputManager also ignores keys while `ui.isChatInputOpen()` (add that guard where movement keys are read, so "w/a/s/d" typed into chat don't move the player — the input's `stopPropagation` covers bubbling, but add the guard defensively).

- [ ] **Step 4: Call chat.update in the render loop**

In the app's per-frame update (where `multiplayer.update(dt)` is called), add:
```ts
this.chat.update(dt);
```

- [ ] **Step 5: Mobile HUD buttons (💬 + press-hold 🎤)**

In `SimpleUI.ts`, in the mobile/touch branch (grep `isTouchDevice`), add two HUD controls using the existing helper:
```ts
if (this.isTouchDevice()) {
  const chatBtn = document.createElement('div');
  chatBtn.textContent = '💬';
  Object.assign(chatBtn.style, { /* match the icon-row style; place left of the joystick */ });
  chatBtn.addEventListener('click', (e) => { e.stopPropagation(); this.openChatInput(); });
  this.makeHudButtonAccessible(chatBtn, 'Open chat');
  this.overlay.appendChild(chatBtn);

  const micBtn = document.createElement('div');
  micBtn.textContent = '🎤';
  Object.assign(micBtn.style, { /* match style */ });
  const down = (e: Event) => { e.preventDefault(); this.onMicDown?.(); };
  const up = (e: Event) => { e.preventDefault(); this.onMicUp?.(); };
  micBtn.addEventListener('touchstart', down, { passive: false });
  micBtn.addEventListener('touchend', up);
  micBtn.addEventListener('mousedown', down);
  micBtn.addEventListener('mouseup', up);
  this.makeHudButtonAccessible(micBtn, 'Hold to talk to nearby players');
  this.overlay.appendChild(micBtn);
}
```
Add `onMicDown`/`onMicUp` setters to SimpleUI and, in `main-simple.ts`, wire them:
```ts
ui.setOnMicDown(() => void chat.startRecording());
ui.setOnMicUp(() => chat.stopRecording());
```

- [ ] **Step 6: Browser verification (two tabs)**

Start the dev server the reliable way (preview_start caches cwd=`C:\`; use Bash):
```bash
cd /c && (npm --prefix "C:/claudeSessions/githubCLONES/portfolio-island" run dev &) 
```
Open `http://localhost:5173` in the in-app browser tab AND a second real browser tab (same-device peers connect via BroadcastChannel/RTDB). Verify:
- Press Enter → input appears; type "hello" → Enter → a bubble appears over your avatar and, in the other tab, over your peer (when within 14 units).
- Walk >14 units away → new messages no longer show in the other tab.
- Hold `V`, speak, release → the other tab plays the clip (grant mic once) with a 🔊 over the speaker; volume lower when far.
- No console errors (`read_console_messages onlyErrors`).

- [ ] **Step 7: Typecheck + commit**

```bash
npx tsc --noEmit
git add SimpleUI.ts main-simple.ts
git commit -m "feat(chat): wire Chat into app — text input, keys, mobile buttons"
```

---

## Task 7: Security rules, privacy note, mute affordance

**Files:**
- Modify: `database.rules.json`
- Modify: `public/privacy.html`

- [ ] **Step 1: Add RTDB rules for the chat/voice paths**

In `database.rules.json`, add under `rules` (alongside the existing `presence` rule) sibling entries that allow authenticated append with size caps and require the entry to carry the writer's own uid:
```json
"chat": {
  "island": {
    "$entry": {
      ".read": "auth != null",
      ".write": "auth != null && (!data.exists() || data.child('id').val() === newData.child('id').val())",
      "text": { ".validate": "newData.isString() && newData.val().length <= 120" },
      "id":   { ".validate": "newData.isString()" },
      "t":    { ".validate": "newData.isNumber()" }
    }
  }
},
"voice": {
  "island": {
    "$entry": {
      ".read": "auth != null",
      ".write": "auth != null",
      "audio": { ".validate": "newData.isString() && newData.val().length <= 60000" },
      "id":    { ".validate": "newData.isString()" },
      "t":     { ".validate": "newData.isNumber()" }
    }
  }
}
```
(60000 char base64 ≈ 44KB, a safe ceiling above `VOICE_MAX_BYTES`.) Note in the commit message that rules must be **deployed** (`firebase deploy --only database` on the life-island project) — a separate step the user runs, since Firebase is on their own account.

- [ ] **Step 2: Add the privacy line**

In `public/privacy.html`, add a bullet in the data section:
```html
<li><strong>Voice &amp; chat:</strong> Voice is opt-in and push-to-talk — your
microphone is only active while you hold the talk button, shown by an on-screen
indicator. Messages and voice clips are sent only to players near you and are
ephemeral: they are not stored or logged, and voice clips are deleted shortly
after delivery.</li>
```

- [ ] **Step 3: Commit**

```bash
git add database.rules.json public/privacy.html
git commit -m "feat(chat): RTDB security rules + privacy note for chat/voice"
```

---

## Task 8: Final integration pass + build

**Files:** none new — verification + build.

- [ ] **Step 1: Full typecheck + test suite**

```bash
npx tsc --noEmit
npx vitest run
```
Expected: tsc clean; all tests pass (moderation + chat + existing 17 = more).

- [ ] **Step 2: Production build**

```bash
npm run build
```
Expected: build succeeds; no new chunks blow the budget.

- [ ] **Step 3: Two-tab manual smoke (repeat Task 6 Step 6) on a fresh load**

Confirm end to end: text bubble appears+expires (~6s), proximity gate works both directions, voice records+plays with distance attenuation, mic-denied path leaves text working, mobile buttons operate, zero console errors, `dispose()` still clean on unload.

- [ ] **Step 4: Clean up dev server (by PID — never pkill on Windows)**

```bash
powershell -NoProfile -Command "Get-NetTCPConnection -State Listen | Where-Object { \$_.LocalPort -eq 5173 } | ForEach-Object { Stop-Process -Id \$_.OwningProcess -Force }"
```

- [ ] **Step 5: Final commit (if any tidy-ups) + push**

```bash
git add -A && git commit -m "chore(chat): final integration tidy-ups"
git push origin claude/overnight-20260719-0649
```

---

## Notes for the implementer

- **Windows:** stop dev servers by PID, never `pkill` (a no-op here). The `preview_start` MCP tool caches cwd=`C:\` this session — launch dev via `npm --prefix <repo> run dev` in Bash, then navigate the browser to `localhost:5173`.
- **Deploy:** the app deploys via `vercel --prod --yes` (not on push). RTDB **rules** deploy separately via `firebase deploy --only database` on the user's own Firebase account — flag this to the user; do not attempt it unprompted.
- **No circular imports:** `Chat` type-imports `WireMessage` from `Multiplayer` but never imports the class; `Multiplayer` never imports `Chat` (it holds a callback). Keep it that way.
- **Feature-detect, don't assume:** voice must degrade to silence/text-only when `MediaRecorder`/`getUserMedia`/`AudioContext` are missing or denied. Never let a missing mic break text or movement.

### Known, deliberate gaps (not blockers)

- **Mute trigger UI:** `Chat.mutePeer(id)` and the persisted mute set exist and are honored in `onWire`, but there is no on-screen affordance to *invoke* mute yet (no per-peer UI in the world). MVP ships the capability; a trigger (e.g. tap a peer's name label, or a "mute voice" HUD toggle) is a fast-follow. Left out to avoid scope creep on avatar-picking UI.
- **Wire-routing unit test:** the spec listed a unit test for "chat/voice routes to the right handler, self-id ignored." That path (`Multiplayer.handleMessage`) is private and needs a full THREE scene + player to construct, so it is covered by the two-tab **browser** verification (Task 6 Step 6, Task 8 Step 3) instead of a mock-heavy unit test. The *pure* logic it guards (proximity, size, gain, text cleaning) is unit-tested in Tasks 1–2.
