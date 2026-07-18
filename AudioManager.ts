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

export class AudioManager {
  private muted: boolean = false;
  private volume: number = 1.0;
  private ctx: AudioContext | null = null;
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
        this.volume = typeof parsed.volume === 'number' ? parsed.volume : 1.0;
      }
    } catch {
      // ignore
    }
    if (ctx) this.ctx = ctx;
  }

  private ensureCtx(): AudioContext {
    if (!this.ctx) {
      const AudioContextConstructor = window.AudioContext ?? window.webkitAudioContext;
      if (!AudioContextConstructor) {
        throw new Error('Web Audio API is not supported in this environment');
      }
      this.ctx = new AudioContextConstructor();
    }
    return this.ctx;
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
    // animate current playing sources to new volume
    try {
      this.applyVolumeToPlaying();
    } catch {
      /* ignore */
    }
  }

  // animate current playing sources' gains to the new volume
  private applyVolumeToPlaying() {
    const ctx = this.ensureCtx();
    const now = ctx.currentTime;
    this.playing.forEach((item) => {
      try {
        item.gain.gain.cancelScheduledValues(now);
        item.gain.gain.setValueAtTime(item.gain.gain.value, now);
        item.gain.gain.linearRampToValueAtTime(this.volume, now + 0.2);
      } catch {
        /* ignore */
      }
    });
  }

  public toggleMute(): boolean {
    this.muted = !this.muted;
    try {
      if (this.muted) {
        void this.ctx?.suspend?.();
      } else {
        void this.ctx?.resume?.();
      }
    } catch {
      // ignore
    }
    this.save();
    return this.muted;
  }

  private save(): void {
    try {
      localStorage.setItem(
        'ds_audio_settings',
        JSON.stringify({ muted: this.muted, volume: this.volume }),
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

  // Decode and store an ArrayBuffer directly (avoid double-fetch)
  public async loadAudioBuffer(arr: ArrayBuffer, key?: string): Promise<void> {
    const ctx = this.ensureCtx();
    const buf = await ctx.decodeAudioData(arr.slice(0));
    this.buffers.set(key || String(Math.random()), buf);
  }

  // Play a looping spatial source for ambient audio. If already playing, update its position instead of restarting.
  public playSpatial(key: string, position: { x: number; y: number; z: number }, maxDistance = 10) {
    if (this.muted) return;
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
    gain.connect(ctx.destination);

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
      gain.gain.linearRampToValueAtTime(this.volume, now + this.fadeDuration);
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

  // Play background music (non-spatial, looping)
  public playBackground(key: string): void {
    if (this.muted) return;
    const buf = this.buffers.get(key);
    if (!buf) return;
    const ctx = this.ensureCtx();

    // If already playing, do nothing
    if (this.playing.has(key)) return;

    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;

    const gain = ctx.createGain();
    gain.gain.value = this.volume;

    src.connect(gain);
    gain.connect(ctx.destination);

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

    // Close the audio context to release resources
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
