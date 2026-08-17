type ExtendedAudioListener = AudioListener & {
  positionX?: AudioParam;
  positionY?: AudioParam;
  positionZ?: AudioParam;
  forwardX?: AudioParam;
  forwardY?: AudioParam;
  forwardZ?: AudioParam;
  upX?: AudioParam;
  upY?: AudioParam;
  upZ?: AudioParam;
  setPosition?: (x: number, y: number, z: number) => void;
  setOrientation?: (fx: number, fy: number, fz: number, ux: number, uy: number, uz: number) => void;
};

/** Default master volume. v2 of ds_audio_settings — quieter than the old 1.0
 *  ("reduce default sound volume"); stored v1 profiles are migrated down. */
const DEFAULT_VOLUME = 0.7;
/** Music sits clearly under speech/sfx — it's a bed, not the show. */
const MUSIC_LEVEL = 0.6;
/** Spatial ambient loops (unused API today, kept for parity). */
const AMBIENT_LEVEL = 0.7;

export class AudioManager {
  private muted: boolean = false;
  private volume: number = DEFAULT_VOLUME;
  private ctx: AudioContext | null = null;
  /** THE master bus. Every sound in the app (music, sfx, NPC voice, peer voice)
   *  routes through this gain via getDestination() — one mute, one volume. */
  private masterGain: GainNode | null = null;
  private buffers: Map<string, AudioBuffer> = new Map();
  private playing: Map<
    string,
    { source: AudioBufferSourceNode; panner: PannerNode; gain: GainNode }
  > = new Map();
  private fadeDuration: number = 0.8; // seconds

  // allow injecting an AudioContext (useful for tests)
  constructor(ctx?: AudioContext) {
    try {
      const stored = localStorage.getItem('ds_audio_settings');
      if (stored) {
        const parsed = JSON.parse(stored);
        this.muted = !!parsed.muted;
        // v2 migration: v1 profiles carried volume 1.0 (the old default) —
        // pull them down to the new quieter default; explicit v2 values stick.
        if (parsed.v === 2 && typeof parsed.volume === 'number') {
          this.volume = parsed.volume;
        }
      }
    } catch {
      // ignore
    }
    if (ctx) this.ctx = ctx;
  }

  public ensureCtx(): AudioContext {
    if (!this.ctx) {
      const AudioContextConstructor = window.AudioContext ?? window.webkitAudioContext;
      if (!AudioContextConstructor) {
        throw new Error('Web Audio API is not supported in this environment');
      }
      this.ctx = new AudioContextConstructor();
    }
    this.hookLifecycle();
    if (!this.masterGain) {
      this.masterGain = this.ctx.createGain();
      this.masterGain.gain.value = this.muted ? 0 : this.volume;
      this.masterGain.connect(this.ctx.destination);
    }
    return this.ctx;
  }

  /** True while the deliberate mute-suspend should stand — every automatic
   *  resume path below must check this, or resuming would defeat the mute. */
  private wantsRunning(): boolean {
    return !this.muted;
  }

  /** Resume the context if the USER wants sound and the OS took it away. */
  private resumeIfWanted(): void {
    try {
      if (this.ctx && this.ctx.state !== 'running' && this.wantsRunning()) {
        void this.ctx.resume();
      }
    } catch {
      /* ignore */
    }
  }

  private lifecycleHooked = false;
  private onVisible = (): void => {
    if (document.visibilityState === 'visible') this.resumeIfWanted();
  };
  private onPageShow = (): void => {
    this.resumeIfWanted();
  };
  /** Always-on gesture fallback: iOS can refuse a NON-gesture resume after an
   *  'interrupted' state (screen lock, phone call, Siri), so a resume inside
   *  the next tap is the reliable recovery. One state check per pointerdown —
   *  cheap — and unlike the boot unlock in main-simple this never detaches. */
  private onGesture = (): void => {
    this.resumeIfWanted();
  };

  /**
   * The context does not stay running by itself. iOS Safari moves it to
   * 'interrupted'/'suspended' on screen lock, app switch or an incoming call,
   * and desktop browsers can suspend after long background stretches — and
   * NOTHING resumed it before: the boot unlock is one-shot, and the only other
   * resume paths needed a peer voice clip or an NPC cloud line. A phone
   * visitor who locked their screen came back to a silent session with the
   * HUD still showing 🔊. Registered once, on the context's own events plus
   * the page's, all funnelled through resumeIfWanted so mute's deliberate
   * suspend is never overridden.
   */
  private hookLifecycle(): void {
    if (this.lifecycleHooked || !this.ctx) return;
    this.lifecycleHooked = true;
    try {
      document.addEventListener('visibilitychange', this.onVisible);
      window.addEventListener('pageshow', this.onPageShow);
      window.addEventListener('pointerdown', this.onGesture);
      this.ctx.onstatechange = () => {
        // Our own mute-suspend also lands here; wantsRunning stops the loop.
        if (document.visibilityState === 'visible') this.resumeIfWanted();
      };
    } catch {
      /* non-browser environment (tests) — lifecycle stays manual */
    }
  }

  /** The node every sound source must connect to (never ctx.destination). */
  public getDestination(): AudioNode {
    this.ensureCtx();
    return this.masterGain!;
  }

  /** Master volume with mute folded in — for non-WebAudio paths
   *  (HTMLAudioElement fallback, speechSynthesis) that can't route
   *  through the master bus and must mirror it numerically. */
  public getEffectiveVolume(): number {
    return this.muted ? 0 : this.volume;
  }

  public isMuted(): boolean {
    return this.muted;
  }

  public getVolume(): number {
    return this.volume;
  }

  public setVolume(v: number): void {
    this.volume = Math.max(0, Math.min(1, v));
    this.save();
    try {
      if (this.masterGain && this.ctx && !this.muted) {
        const now = this.ctx.currentTime;
        this.masterGain.gain.cancelScheduledValues(now);
        this.masterGain.gain.setValueAtTime(this.masterGain.gain.value, now);
        this.masterGain.gain.linearRampToValueAtTime(this.volume, now + 0.2);
      }
    } catch {
      /* ignore */
    }
  }

  private muteCbs: Array<(muted: boolean) => void> = [];
  /**
   * Subscribe to mute changes. For the sound paths that CANNOT be routed
   * through the master bus and so can't be silenced by zeroing it — an
   * HTMLAudioElement already playing, speechSynthesis, a private
   * AudioContext. Zeroing the bus is instant for everything on it; these
   * have to be told.
   */
  public onMuteChange(cb: (muted: boolean) => void): void {
    this.muteCbs.push(cb);
  }

  public toggleMute(): boolean {
    this.muted = !this.muted;
    try {
      // The master gain is the authority (covers sources that might resume the
      // ctx behind our back); suspend/resume stays as a CPU saver on top.
      if (this.masterGain) this.masterGain.gain.value = this.muted ? 0 : this.volume;
      if (this.muted) {
        void this.ctx?.suspend?.();
      } else {
        void this.ctx?.resume?.();
      }
    } catch {
      // ignore
    }
    this.save();
    for (const cb of this.muteCbs) {
      try {
        cb(this.muted);
      } catch {
        /* one bad listener must not strand the mute */
      }
    }
    return this.muted;
  }

  private save(): void {
    try {
      localStorage.setItem(
        'ds_audio_settings',
        JSON.stringify({ v: 2, muted: this.muted, volume: this.volume }),
      );
    } catch {
      // ignore
    }
  }

  public async loadAudio(url: string, key?: string): Promise<void> {
    const ctx = this.ensureCtx();
    const res = await fetch(url);
    const arr = await res.arrayBuffer();
    const buf = await ctx.decodeAudioData(arr.slice(0));
    this.buffers.set(key || url, buf);
  }

  // Store a pre-decoded AudioBuffer or decode a raw ArrayBuffer
  public async loadAudioBuffer(arr: ArrayBuffer | AudioBuffer, key?: string): Promise<void> {
    if (arr instanceof AudioBuffer) {
      this.buffers.set(key || String(Math.random()), arr);
      return;
    }
    const ctx = this.ensureCtx();
    const buf = await ctx.decodeAudioData(arr.slice(0));
    this.buffers.set(key || String(Math.random()), buf);
  }

  // Play a looping spatial source for ambient audio. If already playing, update its position instead of restarting.
  // NOTE no muted early-return: sources always schedule; the master bus at 0
  // keeps them silent. (The old early-return meant a muted-at-load page never
  // scheduled anything and unmuting later restored only silence.)
  public playSpatial(key: string, position: { x: number; y: number; z: number }, maxDistance = 10) {
    const buf = this.buffers.get(key);
    if (!buf) return;
    const ctx = this.ensureCtx();

    // If already playing, update position and return
    const existing = this.playing.get(key);
    if (existing) {
      try {
        existing.panner.setPosition(position.x, position.y, position.z);
        existing.panner.maxDistance = maxDistance;
      } catch {
        // ignore
      }
      return;
    }

    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;

    const panner = ctx.createPanner();
    panner.panningModel = 'HRTF';
    panner.distanceModel = 'inverse';
    panner.maxDistance = maxDistance;
    try {
      panner.setPosition(position.x, position.y, position.z);
    } catch {
      /* ignore */
    }

    const gain = ctx.createGain();
    gain.gain.value = 0; // start silent for fade-in

    src.connect(panner);
    panner.connect(gain);
    gain.connect(this.getDestination());

    const now = ctx.currentTime;
    try {
      gain.gain.cancelScheduledValues(now);
    } catch {
      /* ignore */
    }
    try {
      gain.gain.setValueAtTime(0, now);
    } catch {
      /* ignore */
    }
    try {
      gain.gain.linearRampToValueAtTime(AMBIENT_LEVEL, now + this.fadeDuration);
    } catch {
      /* ignore */
    }
    src.start(0);

    this.playing.set(key, { source: src, panner, gain });

    // emit event for UI
    try {
      window.dispatchEvent(new CustomEvent('ds:ambient-start', { detail: { key } }));
    } catch {
      /* ignore */
    }
  }

  // Update position of a currently playing spatial source
  public updateSpatialPosition(key: string, position: { x: number; y: number; z: number }) {
    const item = this.playing.get(key);
    if (!item) return;
    try {
      item.panner.setPosition(position.x, position.y, position.z);
    } catch {
      /* ignore */
    }
  }

  // Stop a playing spatial source
  public stop(key: string) {
    const item = this.playing.get(key);
    if (!item) return;
    const ctx = this.ensureCtx();
    const now = ctx.currentTime;
    try {
      item.gain.gain.cancelScheduledValues(now);
      item.gain.gain.setValueAtTime(item.gain.gain.value, now);
      item.gain.gain.linearRampToValueAtTime(0.0, now + this.fadeDuration);
      // stop after fade completes
      setTimeout(
        () => {
          try {
            item.source.stop(0);
          } catch {
            /* ignore */
          }
          try {
            item.source.disconnect();
          } catch {
            /* ignore */
          }
          try {
            item.panner.disconnect();
          } catch {
            /* ignore */
          }
          try {
            item.gain.disconnect();
          } catch {
            /* ignore */
          }
        },
        Math.ceil(this.fadeDuration * 1000) + 40,
      );
    } catch {
      try {
        item.source.stop(0);
      } catch {
        /* ignore */
      }
    }
    try {
      window.dispatchEvent(new CustomEvent('ds:ambient-stop', { detail: { key } }));
    } catch {
      /* ignore */
    }
    this.playing.delete(key);
  }

  // Play background music (non-spatial, looping). Always schedules — the
  // master bus carries mute/volume, so unmuting later actually has music.
  public playBackground(key: string): void {
    const buf = this.buffers.get(key);
    if (!buf) return;
    const ctx = this.ensureCtx();

    // If already playing, do nothing
    if (this.playing.has(key)) return;

    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;

    const gain = ctx.createGain();
    gain.gain.value = MUSIC_LEVEL;

    src.connect(gain);
    gain.connect(this.getDestination());

    src.start(0);
    this.playing.set(key, { source: src, panner: null as any, gain });
  }

  // helper for tests and introspection
  public isPlaying(key: string): boolean {
    return this.playing.has(key);
  }

  public updateListener(
    position: { x: number; y: number; z: number },
    forward?: { x: number; y: number; z: number },
    up?: { x: number; y: number; z: number },
  ) {
    const ctx = this.ensureCtx();
    const listener = ctx.listener as ExtendedAudioListener;

    if (listener.positionX && listener.positionY && listener.positionZ) {
      listener.positionX.value = position.x;
      listener.positionY.value = position.y;
      listener.positionZ.value = position.z;
    } else {
      listener.setPosition?.(position.x, position.y, position.z);
    }

    if (forward && up) {
      if (
        listener.forwardX &&
        listener.forwardY &&
        listener.forwardZ &&
        listener.upX &&
        listener.upY &&
        listener.upZ
      ) {
        listener.forwardX.value = forward.x;
        listener.forwardY.value = forward.y;
        listener.forwardZ.value = forward.z;
        listener.upX.value = up.x;
        listener.upY.value = up.y;
        listener.upZ.value = up.z;
      } else {
        listener.setOrientation?.(forward.x, forward.y, forward.z, up.x, up.y, up.z);
      }
    }
  }

  /**
   * Cleanup method to stop all audio sources, disconnect nodes, and close the audio context.
   * Call this when tearing down the application or on hot reload to prevent memory leaks.
   */
  public dispose(): void {
    // Stop all currently playing sources and disconnect nodes
    this.playing.forEach((item, _key) => {
      try {
        item.source.stop(0);
        item.source.disconnect();
        item.panner.disconnect();
        item.gain.disconnect();
      } catch {
        // ignore errors during cleanup
      }
    });
    this.playing.clear();

    // Unhook the lifecycle listeners so a disposed manager can't resurrect
    // its own (closed) context from a stray tab-show or tap.
    if (this.lifecycleHooked) {
      try {
        document.removeEventListener('visibilitychange', this.onVisible);
        window.removeEventListener('pageshow', this.onPageShow);
        window.removeEventListener('pointerdown', this.onGesture);
        if (this.ctx) this.ctx.onstatechange = null;
      } catch {
        /* ignore */
      }
      this.lifecycleHooked = false;
    }

    // Close the audio context to release resources
    if (this.masterGain) {
      try {
        this.masterGain.disconnect();
      } catch {
        // ignore errors during cleanup
      }
      this.masterGain = null;
    }
    if (this.ctx) {
      try {
        this.ctx.close();
      } catch {
        // ignore errors during cleanup
      }
      this.ctx = null;
    }

    // Clear all loaded buffers
    this.buffers.clear();
  }
}
