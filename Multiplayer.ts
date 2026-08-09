import * as THREE from 'three';

import { Materials } from './Materials';
import { safePeerName } from './Moderation';
import { SimplePlayer, type BodyPart, type HatId, type RemoteAvatar } from './SimplePlayer';

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

export interface WireMessage {
  kind: 'state' | 'wave' | 'leave' | 'chat' | 'voice';
  id: string;
  name?: string;
  hat?: HatId | null;
  p?: [number, number, number];
  q?: [number, number, number, number];
  veh?: VehicleKind | null; // vehicle the sender is riding (null = on foot)
  vehIdx?: number; // shared index of that vehicle (same on every client)
  vp?: [number, number, number]; // vehicle world position
  vq?: [number, number, number, number]; // vehicle world quaternion
  text?: string; // chat: message body
  audio?: string; // voice: base64 Opus
  dur?: number; // voice: clip length (ms)
  t?: number; // chat/voice: sender timestamp (ms) for replay filtering
  founder?: boolean; // state: sender is the site founder (renders a 👑 badge)
  pose?: number; // state: 0 on-foot, 1 swimming, 2 riding, 3 airborne
  cols?: Partial<Record<BodyPart, number>>; // state: owner's body-customisation colours
}

interface VehicleState {
  idx: number;
  kind: VehicleKind;
  pos: [number, number, number];
  quat: [number, number, number, number];
}

interface Peer {
  id: string;
  name: string;
  hat: HatId | null;
  avatar: THREE.Group;
  label: THREE.Sprite;
  muted: boolean;
  founder: boolean;
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
  // Vehicle the peer is riding: kind (freezes the walk anim) + shared index and
  // its transform, which GameScene applies to the REAL world vehicle so the
  // craft has the right colour and persists where it's parked.
  veh: VehicleKind | null;
  vehIdx: number;
  vp: THREE.Vector3;
  vq: THREE.Quaternion;
  prevPos: THREE.Vector3; // for movement-speed → walk-blend
  speed: number;
  pose: number; // broadcast pose byte applied to the remote avatar
  cols: Partial<Record<BodyPart, number>> | null; // owner's colours (re-applied post-GLTF-swap)
  colsSig: string; // change-detect key so we only recolour when colours change
}

type SendFn = (msg: WireMessage) => void;

export class Multiplayer {
  private scene: THREE.Scene;
  private player: SimplePlayer;
  public readonly selfId: string;
  public selfName: string;
  private selfHat: HatId | null = null;
  // Founder flag: broadcast so peers render a 👑 badge on this session's label.
  // Set once via ?founder=1 (persisted) or a pre-set localStorage flag. Only a
  // cosmetic marker, so being spoofable is acceptable.
  private selfFounder = ((): boolean => {
    try {
      if (new URLSearchParams(location.search).get('founder') === '1') {
        localStorage.setItem('ds_founder', '1');
      }
      return localStorage.getItem('ds_founder') === '1';
    } catch {
      return false;
    }
  })();
  private selfVehicle: VehicleState | null = null;
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
  private chatHandler?: (msg: WireMessage) => void;
  private _selfPos = new THREE.Vector3(); // scratch for the 10Hz state write

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
    // 1.75: label bottom (−0.2 half-height) sits at 1.55, clearing the
    // tallest cosmetic hat (wizard top ≈1.41 above the avatar origin) —
    // at 1.35 the label bottom (1.15) cut through every tall hat.
    this.selfLabel.position.set(0, 1.75, 0);
    this.player.add(this.selfLabel);
    this.sendState();
  }

  /** Called each frame by the app: the vehicle (index + transform) the local
   * player is riding, so peers can move their copy of the same craft. */
  public setVehicle(state: VehicleState | null): void {
    this.selfVehicle = state;
  }

  /** Peer-driven vehicles for GameScene to apply to the shared world vehicles. */
  public getRemoteVehicleStates(): Array<{
    idx: number;
    pos: THREE.Vector3;
    quat: THREE.Quaternion;
  }> {
    const out: Array<{ idx: number; pos: THREE.Vector3; quat: THREE.Quaternion }> = [];
    for (const peer of this.peers.values()) {
      if (peer.veh && peer.vehIdx >= 0) {
        out.push({ idx: peer.vehIdx, pos: peer.vp, quat: peer.vq });
      }
    }
    return out;
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
    const {
      ref,
      set,
      remove,
      push,
      query,
      limitToLast,
      onValue,
      onChildAdded,
      onChildChanged,
      onChildRemoved,
      onDisconnect,
    } = rtdb;
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
      if (msg.kind === 'chat' || msg.kind === 'voice') {
        const path = msg.kind === 'chat' ? 'chat/island' : 'voice/island';
        const entryRef = push(ref(db, path));
        // Auto-remove on disconnect (covers tab close/crash before the timer).
        onDisconnect(entryRef)
          .remove()
          .catch(() => {});
        void set(entryRef, {
          id: uid,
          text: msg.text ?? null,
          audio: msg.audio ?? null,
          dur: msg.dur ?? null,
          t: Date.now(),
        }).catch(() => {});
        // Normal-case cleanup so the path never accumulates blobs.
        window.setTimeout(() => {
          void remove(entryRef).catch(() => {});
        }, 12000);
        return;
      }
      // state
      set(myNode, {
        name: msg.name ?? this.selfName,
        hat: msg.hat ?? null,
        p: msg.p,
        q: msg.q,
        veh: msg.veh ?? null,
        vehIdx: msg.vehIdx ?? -1,
        vp: msg.vp ?? null,
        vq: msg.vq ?? null,
        t: Date.now(),
        wave: this.selfWaveMs,
        founder: this.selfFounder,
        pose: msg.pose ?? 0,
        cols: msg.cols ?? null,
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

    for (const kind of ['chat', 'voice'] as const) {
      const path = kind === 'chat' ? 'chat/island' : 'voice/island';
      // Cap the initial replay: RTDB downloads every child on attach (billed),
      // and a joiner would otherwise pull the ENTIRE backlog. Voice entries are
      // ~24-53KB of base64 each, so cap voice far tighter than text. The replay
      // is discarded anyway (the `ready` gate below), so this is pure bandwidth
      // savings — live messages still arrive as new child_added events.
      const listRef = query(ref(db, path), limitToLast(kind === 'voice' ? 8 : 30));
      // Ignore the initial burst of existing children (RTDB replays them on
      // attach); only act on entries that arrive AFTER the current list has
      // loaded. onValue(onlyOnce) fires right after that initial replay, so
      // `ready` is false during it and true for genuinely new messages. This
      // replaces a broken timestamp filter that compared the sender's clock to
      // THIS device's clock — any cross-device skew silently dropped live chat.
      let ready = false;
      onValue(
        listRef,
        () => {
          ready = true;
        },
        { onlyOnce: true },
      );
      onChildAdded(listRef, (snap) => {
        if (!ready) return;
        const val = snap.val();
        if (!val || val.id === uid) return;
        this.handleMessage(
          JSON.stringify({
            kind,
            id: val.id,
            text: val.text ?? undefined,
            audio: val.audio ?? undefined,
            dur: val.dur ?? undefined,
          }),
        );
      });
    }
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
        vehIdx: v.vehIdx ?? -1,
        vp: v.vp ?? undefined,
        vq: v.vq ?? undefined,
        founder: !!v.founder,
        pose: v.pose ?? 0,
        cols: v.cols ?? undefined,
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

  /** Register a callback for incoming chat/voice wire messages (Chat.onWire). */
  public setChatHandler(cb: (msg: WireMessage) => void): void {
    this.chatHandler = cb;
  }

  /** Send an arbitrary wire message through the active transport. */
  public sendWire(msg: WireMessage): void {
    this.send(msg);
  }

  /** Local player's current world position. */
  public getSelfWorldPosition(): THREE.Vector3 {
    return this.player.getWorldPosition();
  }

  /** A peer's current world position, or null if they're not connected. */
  public getPeerWorldPosition(id: string): THREE.Vector3 | null {
    const peer = this.peers.get(id);
    return peer ? peer.avatar.position.clone() : null;
  }

  /** A peer's avatar object (for attaching chat bubbles etc.), or null. */
  public getPeerAvatar(id: string): THREE.Object3D | null {
    return this.peers.get(id)?.avatar ?? null;
  }

  /** The local player's avatar object (for attaching chat bubbles etc.). */
  public getSelfAvatar(): THREE.Object3D {
    return this.player;
  }

  /** Walk up from a raycast-hit object to the peer id it belongs to (or null).
   *  Peer avatars are named `remote_player_<id>`. */
  public peerIdForObject(obj: THREE.Object3D | null): string | null {
    let o: THREE.Object3D | null = obj;
    while (o) {
      if (o.name.startsWith('remote_player_')) return o.name.slice('remote_player_'.length);
      o = o.parent;
    }
    return null;
  }

  /** A peer's display name (for mute feedback), or null. */
  public getPeerName(id: string): string | null {
    return this.peers.get(id)?.name ?? null;
  }

  /** Snapshot of connected peers (id, name, muted) for the roster panel. */
  public getPeerList(): Array<{ id: string; name: string; muted: boolean }> {
    const out: Array<{ id: string; name: string; muted: boolean }> = [];
    for (const [id, peer] of this.peers) {
      out.push({ id, name: peer.name || 'Guest', muted: !!peer.muted });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Reflect a peer's muted state on their floating name label (🔇 prefix). */
  public setPeerMuted(id: string, muted: boolean): void {
    const peer = this.peers.get(id);
    if (!peer || peer.muted === muted) return;
    peer.muted = muted;
    this.refreshPeerLabel(peer);
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
    this.player.triggerWave(); // animate the local avatar's arm, not just the emoji
    this.selfWaveUntil = performance.now() / 1000 + 1.6;
    if (!this.selfWaveSprite) {
      this.selfWaveSprite = Multiplayer.makeEmojiSprite('👋');
      this.player.add(this.selfWaveSprite);
      // 2.35: above the raised name label (top 1.95) — at 1.55 the emoji
      // sat straight through the label band.
      this.selfWaveSprite.position.set(0, 2.35, 0);
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
    if (msg.kind === 'chat' || msg.kind === 'voice') {
      this.chatHandler?.(msg);
      return;
    }
    if (msg.kind === 'leave') {
      this.removePeer(msg.id);
      return;
    }
    let peer = this.peers.get(msg.id);
    if (!peer) {
      // Never trust a name off the wire — a modified client can send anything,
      // and it renders above the avatar for every visitor.
      peer = this.createPeer(msg.id, safePeerName(msg.name), msg.hat ?? null);
      this.peers.set(msg.id, peer);
      this.onCountChange?.(1 + this.peers.size);
    }
    peer.lastSeen = performance.now() / 1000;
    if (msg.kind === 'wave') {
      peer.waveUntil = peer.lastSeen + 1.6;
      if (peer.waveSprite) peer.waveSprite.visible = true;
      peer.remote?.wave(); // animate the peer's arm, not just the emoji
      return;
    }
    // state
    if (msg.p) peer.targetPos.set(msg.p[0], msg.p[1], msg.p[2]);
    if (msg.q) peer.targetQuat.set(msg.q[0], msg.q[1], msg.q[2], msg.q[3]);
    if (msg.name) {
      const clean = safePeerName(msg.name);
      if (clean !== peer.name) {
        peer.name = clean;
        this.refreshPeerLabel(peer);
      }
    }
    const founder = !!msg.founder;
    if (founder !== peer.founder) {
      peer.founder = founder;
      this.refreshPeerLabel(peer);
    }
    const hat = msg.hat ?? null;
    if (hat !== peer.hat) {
      peer.hat = hat;
      this.applyPeerHat(peer);
    }
    // Vehicle: kind freezes the walk anim; idx+transform are applied to the
    // shared world vehicle by GameScene (see getRemoteVehicleStates).
    peer.veh = msg.veh ?? null;
    peer.vehIdx = msg.vehIdx ?? -1;
    if (msg.vp) peer.vp.set(msg.vp[0], msg.vp[1], msg.vp[2]);
    if (msg.vq) peer.vq.set(msg.vq[0], msg.vq[1], msg.vq[2], msg.vq[3]);
    // Broadcast pose byte → the remote avatar strikes swim/ride/air poses
    // instead of always walk-cycling upright (applied each frame in update()).
    peer.pose = typeof msg.pose === 'number' ? msg.pose : 0;
    // Body-customisation colours: recolour only when they change (traversal),
    // and remember them so they can be re-applied after the GLTF model swaps in.
    if (msg.cols) {
      const sig = JSON.stringify(msg.cols);
      if (sig !== peer.colsSig) {
        peer.colsSig = sig;
        peer.cols = msg.cols;
        SimplePlayer.applyBodyColors(peer.avatar, msg.cols);
      }
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
    peer.label = Multiplayer.makeTextSprite(
      (peer.muted ? '🔇 ' : '') + (peer.founder ? '👑 ' : '') + peer.name,
    );
    peer.label.position.set(0, y, 0);
    peer.avatar.add(peer.label);
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
    // 1.75 clears the tallest peer hat (wizard ≈1.41) — see setName.
    label.position.set(0, 1.75, 0);
    avatar.add(label);

    // Wave emoji (hidden until they wave)
    const waveSprite = Multiplayer.makeEmojiSprite('👋');
    // 2.35: bottom (2.075) clears the raised label top (1.95) by 0.125.
    waveSprite.position.set(0, 2.35, 0);
    waveSprite.visible = false;
    avatar.add(waveSprite);

    this.scene.add(avatar);
    const peer: Peer = {
      id,
      name,
      hat,
      avatar,
      label,
      muted: false,
      founder: false,
      hatMesh: null,
      targetPos: new THREE.Vector3(),
      targetQuat: new THREE.Quaternion(),
      lastSeen: performance.now() / 1000,
      waveSprite,
      waveUntil: 0,
      fallbackParts,
      remote: null,
      veh: null,
      vehIdx: -1,
      vp: new THREE.Vector3(),
      vq: new THREE.Quaternion(),
      prevPos: new THREE.Vector3(),
      speed: 0,
      pose: 0,
      cols: null,
      colsSig: '',
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
      // The fallback body's materials were unnamed; recolour the real GLB body.
      if (peer.cols) SimplePlayer.applyBodyColors(remote.body, peer.cols);
    });

    return peer;
  }

  private static makeTextSprite(text: string): THREE.Sprite {
    const canvas = document.createElement('canvas');
    // 2× render (logical 256×64 via the scaled transform) — the old canvas
    // read soft on retina at conversation range.
    canvas.width = 512;
    canvas.height = 128;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.setTransform(2, 0, 0, 2, 0, 0);
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
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.generateMipmaps = false;
    tex.minFilter = THREE.LinearFilter;
    const sprite = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }),
    );
    sprite.scale.set(1.6, 0.4, 1);
    return sprite;
  }

  private static makeEmojiSprite(emoji: string): THREE.Sprite {
    const canvas = document.createElement('canvas');
    canvas.width = 192; // 2× (logical 96 via scaled transform)
    canvas.height = 192;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.setTransform(2, 0, 0, 2, 0, 0);
      ctx.font = '72px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(emoji, 48, 54);
    }
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.generateMipmaps = false;
    tex.minFilter = THREE.LinearFilter;
    const sprite = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }),
    );
    sprite.scale.set(0.55, 0.55, 1);
    return sprite;
  }

  /** One outgoing state packet (10Hz loop + background heartbeat). */
  private sendState(): void {
    const p = this.player.getWorldPositionInto(this._selfPos);
    const q = this.player.quaternion;
    // Pose byte peers replay on the remote avatar. Ride wins (the player leaves
    // the water for the deck); else swim while over water; else airborne.
    let pose = 0;
    if (this.selfVehicle) pose = 2;
    else if (this.player.isInWater()) pose = 1;
    else if (!this.player.isOnGround()) pose = 3;
    const msg: WireMessage = {
      kind: 'state',
      id: this.selfId,
      name: this.selfName,
      hat: this.selfHat,
      p: [+p.x.toFixed(2), +p.y.toFixed(2), +p.z.toFixed(2)],
      q: [+q.x.toFixed(3), +q.y.toFixed(3), +q.z.toFixed(3), +q.w.toFixed(3)],
      veh: this.selfVehicle?.kind ?? null,
      vehIdx: this.selfVehicle?.idx ?? -1,
      vp: this.selfVehicle?.pos,
      vq: this.selfVehicle?.quat,
      founder: this.selfFounder,
      pose,
    };
    // Body colours ride along only when the visitor has customised (small).
    const cols = this.player.getAppearance();
    if (Object.keys(cols).length) msg.cols = cols;
    this.send(msg);
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
      peer.remote?.setPose(peer.pose);
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
