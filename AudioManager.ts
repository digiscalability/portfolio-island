export class AudioManager {
  private muted: boolean = false;
  private volume: number = 1.0;
  private ctx: AudioContext | null = null;
  private buffers: Map<string, AudioBuffer> = new Map();
  private playing: Map<string, { source: AudioBufferSourceNode; panner: PannerNode; gain: GainNode }> = new Map();
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
    } catch (e) {
      // ignore
    }
    if (ctx) this.ctx = ctx;
  }

  private ensureCtx(): AudioContext {
    if (!this.ctx) this.ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
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
    try { this.applyVolumeToPlaying(); } catch (e) { }
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
      } catch (e) { /* ignore */ }
    });
  }

  public toggleMute(): boolean {
    this.muted = !this.muted;
    try {
      if (this.muted) this.ctx && this.ctx.suspend && this.ctx.suspend();
      else this.ctx && this.ctx.resume && this.ctx.resume();
    } catch (e) {
      // ignore
    }
    this.save();
    return this.muted;
  }

  private save(): void {
    try {
      localStorage.setItem('ds_audio_settings', JSON.stringify({ muted: this.muted, volume: this.volume }));
    } catch (e) {
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
      } catch (e) {
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
    try { panner.setPosition(position.x, position.y, position.z); } catch (e) { /* ignore */ }

  const gain = ctx.createGain();
  gain.gain.value = 0; // start silent for fade-in

    src.connect(panner);
    panner.connect(gain);
    gain.connect(ctx.destination);

    const now = ctx.currentTime;
    try { gain.gain.cancelScheduledValues(now); } catch (e) {}
    try { gain.gain.setValueAtTime(0, now); } catch (e) {}
    try { gain.gain.linearRampToValueAtTime(this.volume, now + this.fadeDuration); } catch (e) {}
    src.start(0);

    this.playing.set(key, { source: src, panner, gain });

    // emit event for UI
    try {
      window.dispatchEvent(new CustomEvent('ds:ambient-start', { detail: { key } }));
    } catch (e) { }
  }

  // Update position of a currently playing spatial source
  public updateSpatialPosition(key: string, position: { x: number; y: number; z: number }) {
    const item = this.playing.get(key);
    if (!item) return;
    try {
      item.panner.setPosition(position.x, position.y, position.z);
    } catch (e) { /* ignore */ }
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
      setTimeout(() => {
        try { item.source.stop(0); } catch (e) {}
        try { item.source.disconnect(); } catch (e) {}
        try { item.panner.disconnect(); } catch (e) {}
        try { item.gain.disconnect(); } catch (e) {}
      }, Math.ceil(this.fadeDuration * 1000) + 40);
    } catch (e) {
      try { item.source.stop(0); } catch (e) { /* ignore */ }
    }
    try {
      window.dispatchEvent(new CustomEvent('ds:ambient-stop', { detail: { key } }));
    } catch (e) { }
    this.playing.delete(key);
  }

  // helper for tests and introspection
  public isPlaying(key: string): boolean {
    return this.playing.has(key);
  }

  public updateListener(position: { x: number; y: number; z: number }, forward?: { x: number; y: number; z: number }, up?: { x: number; y: number; z: number }) {
    const ctx = this.ensureCtx();
    try {
      const listener = ctx.listener;
      if (listener.positionX) {
        // modern API
        (listener.positionX as any).value = position.x;
        (listener.positionY as any).value = position.y;
        (listener.positionZ as any).value = position.z;
      } else if ((listener as any).setPosition) {
        (listener as any).setPosition(position.x, position.y, position.z);
      }

      if (forward && up) {
        if ((listener as any).forwardX) {
          (listener as any).forwardX.value = forward.x;
          (listener as any).forwardY.value = forward.y;
          (listener as any).forwardZ.value = forward.z;
          (listener as any).upX.value = up.x;
          (listener as any).upY.value = up.y;
          (listener as any).upZ.value = up.z;
        } else if ((listener as any).setOrientation) {
          (listener as any).setOrientation(forward.x, forward.y, forward.z, up.x, up.y, up.z);
        }
      }
    } catch (e) {
      // ignore
    }
  }

  /**
   * Cleanup method to stop all audio sources, disconnect nodes, and close the audio context.
   * Call this when tearing down the application or on hot reload to prevent memory leaks.
   */
  public dispose(): void {
    // Stop all currently playing sources and disconnect nodes
    this.playing.forEach((item, key) => {
      try {
        item.source.stop(0);
        item.source.disconnect();
        item.panner.disconnect();
        item.gain.disconnect();
      } catch (e) {
        // ignore errors during cleanup
      }
    });
    this.playing.clear();

    // Close the audio context to release resources
    if (this.ctx) {
      try {
        this.ctx.close();
      } catch (e) {
        // ignore errors during cleanup
      }
      this.ctx = null;
    }

    // Clear all loaded buffers
    this.buffers.clear();
  }
}

