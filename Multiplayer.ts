import * as THREE from 'three';

import { Materials } from './Materials';
import { SimplePlayer, type HatId, type RemoteAvatar } from './SimplePlayer';

type VehicleKind = 'boat' | 'jetski' | 'car';

/**
 * Multiplayer — presence, position sync, and waves between players.
 *
 * Transport is pluggable:
 *  - WebSocket to ws(s)://<host>/mp — the Vite dev plugin relays messages
 *    to every other client (works on localhost and across the LAN).
 *  - BroadcastChannel fallback — same-device tabs — when the socket
 *    can't connect (e.g. static production hosting without a relay).
 *  - A Firebase RTDB transport can implement the same seam later.
 *
 * Protocol (JSON): { kind: 'state'|'wave'|'leave', id, name, hat,
 *   p: [x,y,z], q: [x,y,z,w], t }
 * State goes out at 10Hz; peers expire after 3.5s of silence.
 */

interface WireMessage {
  kind: 'state' | 'wave' | 'leave';
  id: string;
  name?: string;
  hat?: HatId | null;
  p?: [number, number, number];
  q?: [number, number, number, number];
  veh?: VehicleKind | null; // vehicle the sender is riding (null = on foot)
}

interface Peer {
  id: string;
  name: string;
  hat: HatId | null;
  avatar: THREE.Group;
  label: THREE.Sprite;
  hatMesh: THREE.Group | null;
  targetPos: THREE.Vector3;
  targetQuat: THREE.Quaternion;
  lastSeen: number;
  waveSprite: THREE.Sprite | null;
  waveUntil: number;
  // Procedural body shown instantly; swapped for the shared GLTF model when
  // it loads so peers match the local player exactly.
  fallbackParts: THREE.Object3D[];
  remote: RemoteAvatar | null;
  // Vehicle the peer is riding + its rendered mesh under the avatar.
  veh: VehicleKind | null;
  vehMesh: THREE.Object3D | null;
  prevPos: THREE.Vector3; // for movement-speed → walk-blend
  speed: number;
}

type SendFn = (msg: WireMessage) => void;

export class Multiplayer {
  private scene: THREE.Scene;
  private player: SimplePlayer;
  public readonly selfId: string;
  public selfName: string;
  private selfHat: HatId | null = null;
  private selfVehicle: VehicleKind | null = null;
  private selfLabel: THREE.Sprite | null = null;

  private peers: Map<string, Peer> = new Map();
  private send: SendFn = () => {};
  private transportName = 'none';
  private sendAccum = 0;
  private onCountChange?: (count: number) => void;
  private selfWaveSprite: THREE.Sprite | null = null;
  private selfWaveUntil = 0;
  // Firebase RTDB transport state
  private selfWaveMs = 0; // last time WE waved (ms); rides along in state writes
  private peerWave = new Map<string, number>(); // last wave value seen per peer

  constructor(scene: THREE.Scene, player: SimplePlayer) {
    this.scene = scene;
    this.player = player;
    this.selfId = Math.random().toString(36).slice(2, 10);
    this.selfName = Multiplayer.loadOrMintName();
    // Defer transport connect (dynamic Firebase import + anonymous auth) out
    // of the boot frame so it never competes with scene setup / the fly-in.
    // send() is a safe no-op until connect() wires the real transport.
    const connect = () => void this.connect();
    if (typeof requestIdleCallback === 'function') {
      requestIdleCallback(connect, { timeout: 3000 });
    } else {
      setTimeout(connect, 800);
    }
    window.addEventListener('beforeunload', () => {
      this.send({ kind: 'leave', id: this.selfId });
    });
    // Heartbeat via setInterval: rAF suspends in hidden tabs, which would
    // silence the 10Hz state loop and get us pruned by peers within 3.5s.
    // Background timers are throttled but still fire (~1s), keeping presence
    // alive while a player is briefly alt-tabbed.
    window.setInterval(() => {
      if (document.visibilityState === 'hidden') this.sendState();
    }, 1000);
  }

  private static loadOrMintName(): string {
    try {
      const saved = localStorage.getItem('ds_player_name');
      if (saved) return saved;
    } catch {
      /* mint fresh */
    }
    // Placeholder only — NOT persisted, so the on-visit name prompt still
    // fires. Once the visitor types their name, setName() saves it.
    const ADJ = ['Swift', 'Sunny', 'Brave', 'Merry', 'Quiet', 'Lucky', 'Cosmic', 'Amber'];
    const NOUN = ['Courier', 'Wanderer', 'Runner', 'Scout', 'Postie', 'Rover'];
    return `${ADJ[Math.floor(Math.random() * ADJ.length)]} ${
      NOUN[Math.floor(Math.random() * NOUN.length)]
    }`;
  }

  /** Set the visitor's chosen display name: persists it, shows it above the
   * local player, and it rides out in the next state broadcast to peers. */
  public setName(name: string): void {
    const clean = name.trim().slice(0, 20);
    if (!clean) return;
    this.selfName = clean;
    try {
      localStorage.setItem('ds_player_name', clean);
    } catch {
      /* session-only */
    }
    // Own name tag so the visitor sees their name applied
    if (this.selfLabel) {
      this.player.remove(this.selfLabel);
      (this.selfLabel.material as THREE.SpriteMaterial).map?.dispose();
    }
    this.selfLabel = Multiplayer.makeTextSprite(clean);
    this.selfLabel.position.set(0, 1.35, 0);
    this.player.add(this.selfLabel);
    this.sendState();
  }

  /** Called each frame by the app: which vehicle (if any) the local player
   * is riding, so it can be broadcast for peers to render. */
  public setVehicle(kind: VehicleKind | null): void {
    this.selfVehicle = kind;
  }

  /**
   * Firebase Realtime Database first (real cross-device presence, works on
   * the deployed site AND localhost). If it can't init (offline / blocked),
   * fall back to the dev WebSocket relay, then same-device BroadcastChannel.
   */
  private connect(): void {
    this.connectFirebase().catch((err) => {
      console.warn('🌐 Firebase multiplayer unavailable, falling back:', err);
      this.connectRelay();
    });
  }

  /**
   * Firebase RTDB transport. Each player owns /presence/island/{uid} and can
   * only write their own node (security rules); onDisconnect auto-removes it.
   * Peers' nodes are streamed in and translated into the same wire protocol
   * handleMessage already understands.
   */
  private async connectFirebase(): Promise<void> {
    const [{ getFirebaseRealtime }, rtdb] = await Promise.all([
      import('./firebaseClient'),
      import('firebase/database'),
    ]);
    const { db, uid } = await getFirebaseRealtime();
    const { ref, set, remove, onChildAdded, onChildChanged, onChildRemoved, onDisconnect } = rtdb;
    const roomPath = 'presence/island';
    const myNode = ref(db, `${roomPath}/${uid}`);
    const room = ref(db, roomPath);
    onDisconnect(myNode).remove();

    this.transportName = 'firebase';
    this.send = (msg) => {
      if (msg.kind === 'leave') {
        remove(myNode).catch(() => {});
        return;
      }
      if (msg.kind === 'wave') {
        this.selfWaveMs = Date.now(); // carried in the next state write
        return;
      }
      // state
      set(myNode, {
        name: msg.name ?? this.selfName,
        hat: msg.hat ?? null,
        p: msg.p,
        q: msg.q,
        veh: msg.veh ?? null,
        t: Date.now(),
        wave: this.selfWaveMs,
      }).catch(() => {});
    };

    onChildAdded(room, (snap) => {
      const key = snap.key;
      if (!key || key === uid) return;
      const v = snap.val();
      if (!v) return;
      this.peerWave.set(key, v.wave || 0); // baseline: don't wave on first sight
      this.routeRtdbState(key, v);
    });
    onChildChanged(room, (snap) => {
      const key = snap.key;
      if (!key || key === uid) return;
      const v = snap.val();
      if (!v) return;
      this.routeRtdbState(key, v);
      const w = v.wave || 0;
      if (w > (this.peerWave.get(key) || 0)) {
        this.peerWave.set(key, w);
        this.handleMessage(JSON.stringify({ kind: 'wave', id: key, name: v.name, hat: v.hat }));
      }
    });
    onChildRemoved(room, (snap) => {
      const key = snap.key;
      if (!key || key === uid) return;
      this.peerWave.delete(key);
      this.handleMessage(JSON.stringify({ kind: 'leave', id: key }));
    });
    console.log('🌐 Multiplayer connected via Firebase RTDB');
  }

  /** Translate an RTDB presence node into a wire 'state' message. */
  private routeRtdbState(key: string, v: Record<string, unknown>): void {
    this.handleMessage(
      JSON.stringify({
        kind: 'state',
        id: key,
        name: v.name,
        hat: v.hat,
        p: v.p,
        q: v.q,
        veh: v.veh ?? null,
      }),
    );
  }

  /** WebSocket first (LAN-capable), BroadcastChannel as fallback. */
  private connectRelay(): void {
    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
    let settled = false;
    try {
      const ws = new WebSocket(`${proto}://${window.location.host}/mp`);
      ws.addEventListener('open', () => {
        settled = true;
        this.transportName = 'websocket';
        this.send = (msg) => {
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
        };
        console.log('🌐 Multiplayer connected via WebSocket relay');
      });
      ws.addEventListener('message', (ev) => {
        this.handleMessage(String(ev.data));
      });
      const fallback = () => {
        if (!settled) this.connectBroadcast();
        else if (this.transportName === 'websocket') this.connectBroadcast();
      };
      ws.addEventListener('error', fallback);
      ws.addEventListener('close', fallback);
    } catch {
      this.connectBroadcast();
    }
  }

  private connectBroadcast(): void {
    if (this.transportName === 'broadcast') return;
    try {
      const bc = new BroadcastChannel('ds-life-island-mp');
      this.transportName = 'broadcast';
      this.send = (msg) => bc.postMessage(JSON.stringify(msg));
      bc.addEventListener('message', (ev) => this.handleMessage(String(ev.data)));
      console.log('🌐 Multiplayer using BroadcastChannel (same-device tabs)');
    } catch {
      this.transportName = 'none';
      console.log('🌐 Multiplayer unavailable (no transport)');
    }
  }

  public onCount(cb: (count: number) => void): void {
    this.onCountChange = cb;
    cb(1 + this.peers.size);
  }

  /** Keep outgoing hat state in sync with the shop. */
  public setHat(hat: HatId | null): void {
    this.selfHat = hat;
  }

  /** Distance to the nearest remote player (Infinity when alone). */
  public nearestPeerDistance(): number {
    const p = this.player.getWorldPosition();
    let best = Infinity;
    for (const peer of this.peers.values()) {
      best = Math.min(best, peer.avatar.position.distanceTo(p));
    }
    return best;
  }

  /** Broadcast a wave; also show it locally above our own head. */
  public wave(): void {
    this.send({ kind: 'wave', id: this.selfId });
    this.selfWaveUntil = performance.now() / 1000 + 1.6;
    if (!this.selfWaveSprite) {
      this.selfWaveSprite = Multiplayer.makeEmojiSprite('👋');
      this.player.add(this.selfWaveSprite);
      this.selfWaveSprite.position.set(0, 1.55, 0);
    }
    this.selfWaveSprite.visible = true;
  }

  private handleMessage(raw: string): void {
    let msg: WireMessage;
    try {
      msg = JSON.parse(raw) as WireMessage;
    } catch {
      return;
    }
    if (!msg || msg.id === this.selfId) return;
    if (msg.kind === 'leave') {
      this.removePeer(msg.id);
      return;
    }
    let peer = this.peers.get(msg.id);
    if (!peer) {
      peer = this.createPeer(msg.id, msg.name ?? 'Visitor', msg.hat ?? null);
      this.peers.set(msg.id, peer);
      this.onCountChange?.(1 + this.peers.size);
    }
    peer.lastSeen = performance.now() / 1000;
    if (msg.kind === 'wave') {
      peer.waveUntil = peer.lastSeen + 1.6;
      if (peer.waveSprite) peer.waveSprite.visible = true;
      return;
    }
    // state
    if (msg.p) peer.targetPos.set(msg.p[0], msg.p[1], msg.p[2]);
    if (msg.q) peer.targetQuat.set(msg.q[0], msg.q[1], msg.q[2], msg.q[3]);
    if (msg.name && msg.name !== peer.name) {
      peer.name = msg.name;
      this.refreshPeerLabel(peer);
    }
    const hat = msg.hat ?? null;
    if (hat !== peer.hat) {
      peer.hat = hat;
      this.applyPeerHat(peer);
    }
    const veh = msg.veh ?? null;
    if (veh !== peer.veh) {
      peer.veh = veh;
      this.setPeerVehicle(peer, veh);
    }
  }

  /** Attach the peer's hat to the GLTF head bone (once loaded) or the avatar
   * group as a fallback. Removes any previous hat first. */
  private applyPeerHat(peer: Peer): void {
    if (peer.hatMesh) {
      peer.hatMesh.parent?.remove(peer.hatMesh);
      peer.hatMesh = null;
    }
    if (!peer.hat) return;
    const hatMesh = SimplePlayer.buildHat(peer.hat);
    if (peer.remote?.headBone) {
      hatMesh.position.set(0, 0.36, 0);
      peer.remote.headBone.add(hatMesh);
    } else {
      hatMesh.position.set(0, 0.98, 0);
      peer.avatar.add(hatMesh);
    }
    peer.hatMesh = hatMesh;
  }

  /** Rebuild the floating name label after a rename. */
  private refreshPeerLabel(peer: Peer): void {
    const y = peer.label.position.y;
    peer.avatar.remove(peer.label);
    (peer.label.material as THREE.SpriteMaterial).map?.dispose();
    peer.label = Multiplayer.makeTextSprite(peer.name);
    peer.label.position.set(0, y, 0);
    peer.avatar.add(peer.label);
  }

  /** Show/hide the craft a peer is riding, parented under their avatar so it
   * inherits the broadcast position + heading. This is the fix for peers
   * "floating" while driving — vehicle state was never networked before. */
  private setPeerVehicle(peer: Peer, kind: VehicleKind | null): void {
    if (peer.vehMesh) {
      peer.avatar.remove(peer.vehMesh);
      peer.vehMesh = null;
    }
    if (!kind) return;
    const mesh = Multiplayer.buildPeerVehicle(kind);
    peer.avatar.add(mesh);
    peer.vehMesh = mesh;
  }

  /** Compact toon craft rendered under a riding peer. Built facing −Z (the
   * player model's forward) and sunk so the rider sits on it. */
  private static buildPeerVehicle(kind: VehicleKind): THREE.Group {
    const g = new THREE.Group();
    const add = (w: number, h: number, d: number, c: number, y: number, z = 0): void => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), Materials.createToonMaterial(c));
      m.position.set(0, y, z);
      m.castShadow = true;
      g.add(m);
    };
    const cone = (r: number, len: number, c: number, y: number, z: number): void => {
      const m = new THREE.Mesh(new THREE.ConeGeometry(r, len, 4), Materials.createToonMaterial(c));
      m.rotation.x = Math.PI / 2; // point the nose toward −Z (avatar forward)
      m.rotation.z = Math.PI / 4;
      m.scale.set(1, 0.7, 1);
      m.position.set(0, y, z);
      m.castShadow = true;
      g.add(m);
    };
    if (kind === 'boat') {
      add(1.3, 0.45, 3.0, 0xb5532f, 0.0); // hull
      add(1.2, 0.08, 2.4, 0xe0c08a, 0.26); // deck
      add(0.85, 0.55, 0.85, 0xe0c08a, 0.55, 0.85); // cabin (behind rider)
      cone(0.62, 0.9, 0xb5532f, 0.2, -1.85); // bow
      g.position.set(0, -0.95, 0.2);
    } else if (kind === 'jetski') {
      add(0.62, 0.32, 1.9, 0x27c2d6, 0.0); // hull
      add(0.46, 0.16, 0.8, 0x223344, 0.22, -0.1); // seat
      cone(0.32, 0.7, 0x27c2d6, 0.06, -1.15); // nose
      g.position.set(0, -0.82, 0.05);
    } else {
      add(1.15, 0.4, 2.1, 0x3f6fb0, 0.12); // body
      add(0.92, 0.42, 1.05, 0x2a4f80, 0.52, -0.05); // cabin
      for (const sx of [-0.58, 0.58]) {
        for (const sz of [-0.72, 0.72]) {
          const wheel = new THREE.Mesh(
            new THREE.CylinderGeometry(0.24, 0.24, 0.16, 12),
            Materials.createToonMaterial(0x1a1a1a),
          );
          wheel.rotation.z = Math.PI / 2;
          wheel.position.set(sx, -0.05, sz);
          wheel.castShadow = true;
          g.add(wheel);
        }
      }
      g.position.set(0, -0.62, 0);
    }
    return g;
  }

  /**
   * Create a remote player. A crude procedural body shows instantly, then the
   * shared GLTF hero model is skeleton-cloned in asynchronously and swapped
   * over it — so peers end up identical to the local player (issue: peers
   * used to look different to you than to themselves).
   */
  private createPeer(id: string, name: string, hat: HatId | null): Peer {
    const avatar = new THREE.Group();
    avatar.name = `remote_player_${id}`;

    // Instant procedural fallback (tracked so it can be removed on GLTF swap)
    const fallbackParts: THREE.Object3D[] = [];
    const shirt = Materials.createToonMaterial(0x7a5fd0);
    const skin = Materials.createToonMaterial(0xffddaa);
    const pants = Materials.createToonMaterial(0x2a3a5a);
    const torso = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.18, 0.6, 8), shirt);
    torso.position.y = 0.22;
    torso.castShadow = true;
    fallbackParts.push(torso);
    for (const lx of [-0.12, 0.12]) {
      const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.09, 0.55, 8), pants);
      leg.position.set(lx, -0.35, 0);
      leg.castShadow = true;
      fallbackParts.push(leg);
    }
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.22, 12, 12), skin);
    head.position.y = 0.72;
    head.castShadow = true;
    fallbackParts.push(head);
    const hair = new THREE.Mesh(
      new THREE.SphereGeometry(0.21, 10, 8, 0, Math.PI * 2, 0, Math.PI * 0.55),
      Materials.createToonMaterial(0x53402e),
    );
    hair.position.y = 0.76;
    fallbackParts.push(hair);
    for (const part of fallbackParts) avatar.add(part);

    // Name label
    const label = Multiplayer.makeTextSprite(name);
    label.position.set(0, 1.35, 0);
    avatar.add(label);

    // Wave emoji (hidden until they wave)
    const waveSprite = Multiplayer.makeEmojiSprite('👋');
    waveSprite.position.set(0, 1.75, 0);
    waveSprite.visible = false;
    avatar.add(waveSprite);

    this.scene.add(avatar);
    const peer: Peer = {
      id,
      name,
      hat,
      avatar,
      label,
      hatMesh: null,
      targetPos: new THREE.Vector3(),
      targetQuat: new THREE.Quaternion(),
      lastSeen: performance.now() / 1000,
      waveSprite,
      waveUntil: 0,
      fallbackParts,
      remote: null,
      veh: null,
      vehMesh: null,
      prevPos: new THREE.Vector3(),
      speed: 0,
    };
    this.applyPeerHat(peer);

    // Swap in the shared GLTF avatar when it loads
    void SimplePlayer.createRemoteAvatar().then((remote) => {
      // Peer may have left while the model loaded
      if (!remote || this.peers.get(id) !== peer) {
        remote?.dispose();
        return;
      }
      for (const part of peer.fallbackParts) {
        avatar.remove(part);
        (part as THREE.Mesh).geometry?.dispose();
      }
      peer.fallbackParts = [];
      avatar.add(remote.body);
      peer.remote = remote;
      // Re-seat the hat on the real head bone now that it exists
      if (peer.hat) this.applyPeerHat(peer);
    });

    return peer;
  }

  private static makeTextSprite(text: string): THREE.Sprite {
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 64;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.font = '600 30px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillStyle = 'rgba(0,0,0,0.45)';
      const w = Math.min(240, ctx.measureText(text).width + 24);
      ctx.beginPath();
      ctx.roundRect(128 - w / 2, 8, w, 46, 12);
      ctx.fill();
      ctx.fillStyle = '#ffffff';
      ctx.fillText(text, 128, 41);
    }
    const tex = new THREE.CanvasTexture(canvas);
    const sprite = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }),
    );
    sprite.scale.set(1.6, 0.4, 1);
    return sprite;
  }

  private static makeEmojiSprite(emoji: string): THREE.Sprite {
    const canvas = document.createElement('canvas');
    canvas.width = 96;
    canvas.height = 96;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.font = '72px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(emoji, 48, 54);
    }
    const tex = new THREE.CanvasTexture(canvas);
    const sprite = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }),
    );
    sprite.scale.set(0.55, 0.55, 1);
    return sprite;
  }

  /** One outgoing state packet (10Hz loop + background heartbeat). */
  private sendState(): void {
    const p = this.player.getWorldPosition();
    const q = this.player.quaternion;
    this.send({
      kind: 'state',
      id: this.selfId,
      name: this.selfName,
      hat: this.selfHat,
      p: [+p.x.toFixed(2), +p.y.toFixed(2), +p.z.toFixed(2)],
      q: [+q.x.toFixed(3), +q.y.toFixed(3), +q.z.toFixed(3), +q.w.toFixed(3)],
      veh: this.selfVehicle,
    });
  }

  /** Call every frame: sends state at 10Hz, interpolates and prunes peers. */
  public update(deltaTime: number): void {
    const now = performance.now() / 1000;

    // Outgoing state @10Hz
    this.sendAccum += deltaTime;
    if (this.sendAccum > 0.1) {
      this.sendAccum = 0;
      this.sendState();
    }

    // Self wave expiry
    if (this.selfWaveSprite && now > this.selfWaveUntil) this.selfWaveSprite.visible = false;

    // Peers: interpolate toward target, bob wave emoji, prune the silent
    const k = Math.min(1, 12 * deltaTime);
    for (const [id, peer] of this.peers) {
      if (now - peer.lastSeen > 3.5) {
        this.removePeer(id);
        continue;
      }
      if (peer.targetPos.lengthSq() > 1) {
        peer.avatar.position.lerp(peer.targetPos, k);
        peer.avatar.quaternion.slerp(peer.targetQuat, k);
      }
      // Walk/idle blend driven by real movement; frozen while riding so the
      // legs don't pump when they're sitting in a vehicle.
      if (peer.prevPos.lengthSq() < 1) {
        peer.prevPos.copy(peer.avatar.position);
      } else {
        peer.speed = peer.avatar.position.distanceTo(peer.prevPos) / Math.max(deltaTime, 1e-3);
        peer.prevPos.copy(peer.avatar.position);
      }
      peer.remote?.update(deltaTime, peer.veh ? 0 : peer.speed);
      if (peer.waveSprite) {
        if (now > peer.waveUntil) peer.waveSprite.visible = false;
        else peer.waveSprite.position.y = 1.75 + Math.sin(now * 10) * 0.06;
      }
    }
  }

  private removePeer(id: string): void {
    const peer = this.peers.get(id);
    if (!peer) return;
    peer.remote?.dispose();
    this.scene.remove(peer.avatar);
    this.peers.delete(id);
    this.onCountChange?.(1 + this.peers.size);
  }

  public getPeerCount(): number {
    return this.peers.size;
  }

  /**
   * Peer world positions for the minimap (GameScene projects them onto the
   * player-centred radar). Avatars live at the scene root, so avatar.position
   * is already a world position; `waving` flags a peer mid-greeting.
   */
  public getPeerWorlds(): Array<{ pos: THREE.Vector3; name: string; waving: boolean }> {
    const now = performance.now() / 1000;
    const out: Array<{ pos: THREE.Vector3; name: string; waving: boolean }> = [];
    for (const p of this.peers.values()) {
      out.push({ pos: p.avatar.position.clone(), name: p.name, waving: p.waveUntil > now });
    }
    return out;
  }
}
