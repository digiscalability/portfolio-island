/**
 * Sfx — tiny procedural one-shot synthesizer for interaction feedback.
 *
 * Every effect is an oscillator or filtered-noise burst with an envelope —
 * zero audio assets. Uses the shared AudioContext from window.audioManager
 * (created on the first user gesture by startBackgroundMusic) so the global
 * mute/suspend state silences SFX too. All nodes disconnect on end.
 */

type AudioManagerLike = {
  ensureCtx(): AudioContext;
  isMuted(): boolean;
  getDestination?(): AudioNode;
};

export class Sfx {
  private noiseBuf: AudioBuffer | null = null;
  private master: GainNode | null = null;
  private masterCtx: AudioContext | null = null;

  private get ctxOrNull(): AudioContext | null {
    const am = (window as unknown as { audioManager?: AudioManagerLike }).audioManager;
    if (!am || am.isMuted()) return null;
    try {
      const ctx = am.ensureCtx();
      return ctx.state === 'running' ? ctx : null;
    } catch {
      return null;
    }
  }

  private ensureMaster(ctx: AudioContext): GainNode {
    if (this.master && this.masterCtx === ctx) return this.master;
    this.master = ctx.createGain();
    this.master.gain.value = 0.5;
    // Route through the AudioManager master bus so the ONE mute/volume knob
    // covers sfx too; fall back to the raw destination pre-audio-boot.
    const am = (window as unknown as { audioManager?: AudioManagerLike }).audioManager;
    this.master.connect(am?.getDestination?.() ?? ctx.destination);
    this.masterCtx = ctx;
    return this.master;
  }

  private ensureNoise(ctx: AudioContext): AudioBuffer {
    if (this.noiseBuf && this.noiseBuf.sampleRate === ctx.sampleRate) return this.noiseBuf;
    const len = Math.floor(ctx.sampleRate * 0.5);
    this.noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = this.noiseBuf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    return this.noiseBuf;
  }

  /** Pitched blip: frequency glides f0 → f1 over dur seconds. */
  private tone(f0: number, f1: number, dur: number, type: OscillatorType, peak: number): void {
    const ctx = this.ctxOrNull;
    if (!ctx) return;
    const t0 = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(Math.max(1, f0), t0);
    if (f1 !== f0) osc.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t0 + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(peak, t0 + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g);
    g.connect(this.ensureMaster(ctx));
    osc.start(t0);
    osc.stop(t0 + dur + 0.05);
    osc.onended = () => {
      osc.disconnect();
      g.disconnect();
    };
  }

  /** Filtered-noise burst centered on centerHz. */
  private hiss(dur: number, peak: number, centerHz: number): void {
    const ctx = this.ctxOrNull;
    if (!ctx) return;
    const t0 = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.ensureNoise(ctx);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = centerHz;
    bp.Q.value = 1.1;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(peak, t0 + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(bp);
    bp.connect(g);
    g.connect(this.ensureMaster(ctx));
    src.start(t0);
    src.stop(t0 + dur + 0.05);
    src.onended = () => {
      src.disconnect();
      bp.disconnect();
      g.disconnect();
    };
  }

  /** Soft grass scuff, alternating left/right foot timbre. ±8% frequency
   *  jitter — identical repeated samples read as a machine, not feet. */
  public footstep(altFoot: boolean): void {
    const jitter = 0.92 + Math.random() * 0.16;
    this.hiss(0.055, 0.09, (altFoot ? 680 : 520) * jitter);
  }

  /**
   * Indoor footfall. Brighter and shorter than the grass scuff — boards have
   * a click to them — and noticeably softer and duller on a rug, which is the
   * whole point of having two: you can HEAR yourself step off the boards.
   */
  public footstepWood(altFoot: boolean, onRug: boolean): void {
    if (onRug) this.hiss(0.045, 0.02, altFoot ? 520 : 420);
    else this.hiss(0.045, 0.055, altFoot ? 900 : 720);
  }

  /** Rising blip on takeoff. */
  public jump(): void {
    this.tone(280, 560, 0.14, 'sine', 0.11);
  }

  /** Low thud + dust scuff on touchdown. */
  public land(): void {
    this.tone(130, 70, 0.12, 'sine', 0.16);
    this.hiss(0.06, 0.07, 380);
  }

  /** Two-note pickup ding for a completed delivery. */
  public collect(): void {
    this.tone(659, 659, 0.09, 'sine', 0.12);
    setTimeout(() => this.tone(880, 880, 0.14, 'sine', 0.12), 80);
  }

  /** Little rising jingle when a whole quest chain completes. */
  public questComplete(): void {
    const notes = [523, 659, 784, 1047];
    notes.forEach((f, i) => {
      setTimeout(() => this.tone(f, f, 0.18, 'sine', 0.12), i * 110);
    });
  }

  /** Short talk blip for dialogue advance (Animal Crossing-style). */
  public blip(): void {
    this.tone(440, 480, 0.045, 'square', 0.04);
  }

  /** Bright little ping for grabbing a meadow coin. `step` climbs a
   *  pentatonic ladder on pickup streaks (the classic collect-a-thon
   *  ascending chime); flat callers (shop dings) pass nothing. */
  private static readonly COIN_LADDER = [784, 880, 988, 1175, 1319, 1568, 1760, 1976];
  public coin(step = 0): void {
    const f = Sfx.COIN_LADDER[Math.min(step, Sfx.COIN_LADDER.length - 1)];
    this.tone(f, f * 1.33, 0.09, 'sine', 0.1);
  }

  /** Water entry: a downward plip + a short foam hiss. */
  public splash(): void {
    this.tone(520, 180, 0.16, 'sine', 0.13);
    this.hiss(0.14, 0.08, 900);
  }

  /** Race checkpoint: a crisp rising two-note tick (distinct from a coin). */
  public checkpoint(): void {
    this.tone(784, 784, 0.06, 'triangle', 0.1);
    setTimeout(() => this.tone(1175, 1175, 0.08, 'triangle', 0.1), 60);
  }

  /** Race start: an energetic up-chirp. */
  public raceGo(): void {
    this.tone(440, 880, 0.22, 'sawtooth', 0.09);
  }

  private rainGain: GainNode | null = null;
  private rainLevel = -1;

  /**
   * Looping rain bed (band-passed noise). Level 0..1; ramps over 1.5s.
   * Safe to call every frame — no-ops until the level changes.
   */
  public setRainLevel(level: number): void {
    if (level === this.rainLevel) return;
    const ctx = this.ctxOrNull;
    if (!ctx) return; // muted or not unlocked yet — retried on next change
    if (!this.rainGain) {
      const src = ctx.createBufferSource();
      src.buffer = this.ensureNoise(ctx);
      src.loop = true;
      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 400;
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 2600;
      this.rainGain = ctx.createGain();
      this.rainGain.gain.value = 0;
      src.connect(hp);
      hp.connect(lp);
      lp.connect(this.rainGain);
      this.rainGain.connect(this.ensureMaster(ctx));
      src.start();
    }
    this.rainLevel = level;
    const t = ctx.currentTime;
    this.rainGain.gain.cancelScheduledValues(t);
    this.rainGain.gain.setValueAtTime(this.rainGain.gain.value, t);
    this.rainGain.gain.linearRampToValueAtTime(0.09 * level, t + 1.5);
  }

  private windGain: GainNode | null = null;
  private windLevel = -1;

  /**
   * Looping wind bed: low band-passed noise with a slow gust LFO — the
   * missing ambience layer every polished game in the class ships. Level
   * 0..1; ramps over 1.5s. Safe to call every frame.
   */
  public setWindLevel(level: number): void {
    if (level === this.windLevel) return;
    const ctx = this.ctxOrNull;
    if (!ctx) return;
    if (!this.windGain) {
      const src = ctx.createBufferSource();
      src.buffer = this.ensureNoise(ctx);
      src.loop = true;
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 420;
      bp.Q.value = 0.55;
      this.windGain = ctx.createGain();
      this.windGain.gain.value = 0;
      // Gust LFO: slow sine wobbles the bed gain so the wind breathes
      const lfo = ctx.createOscillator();
      lfo.frequency.value = 0.07;
      const lfoDepth = ctx.createGain();
      lfoDepth.gain.value = 0.016;
      lfo.connect(lfoDepth);
      lfoDepth.connect(this.windGain.gain);
      lfo.start();
      src.connect(bp);
      bp.connect(this.windGain);
      this.windGain.connect(this.ensureMaster(ctx));
      src.start();
    }
    this.windLevel = level;
    const t = ctx.currentTime;
    this.windGain.gain.cancelScheduledValues(t);
    this.windGain.gain.setValueAtTime(this.windGain.gain.value, t);
    this.windGain.gain.linearRampToValueAtTime(0.05 * level, t + 1.5);
  }

  private birdsongOn = false;
  private birdsongTimer: number | undefined;

  /**
   * Sparse synthesized birdsong: random 2-4 note descending chirps every
   * 3-10s while enabled (daytime, fair weather — the driver decides). The
   * chirps are one-shot tones through the master bus, so mute/volume apply.
   */
  public setBirdsong(on: boolean): void {
    if (on === this.birdsongOn) return;
    this.birdsongOn = on;
    if (!on) {
      if (this.birdsongTimer) clearTimeout(this.birdsongTimer);
      this.birdsongTimer = undefined;
      return;
    }
    const schedule = () => {
      this.birdsongTimer = window.setTimeout(
        () => {
          if (!this.birdsongOn) return;
          const notes = 2 + Math.floor(Math.random() * 3);
          const base = 2300 + Math.random() * 1100;
          for (let i = 0; i < notes; i++) {
            window.setTimeout(
              () => {
                if (this.birdsongOn) {
                  const f = base * (1 - i * 0.12) * (0.96 + Math.random() * 0.08);
                  this.tone(f, f * 0.82, 0.09, 'sine', 0.018);
                }
              },
              i * (90 + Math.random() * 50),
            );
          }
          schedule();
        },
        3000 + Math.random() * 7000,
      );
    };
    schedule();
  }

  private bandLevel = 0;
  private bandTimer: number | undefined;
  // C-major pentatonic, one octave above the ambient bed's melody register —
  // the theme HARMONIZES with the global loop instead of fighting it.
  private static readonly BAND_NOTES = [523.25, 587.33, 659.25, 783.99, 880.0, 1046.5];

  /**
   * Diegetic bandstand theme: a gentle music-box phrase every few seconds
   * while the Musician is actually playing, faded by the caller with distance
   * (level 0..1 scales note velocity; 0 stops the scheduler). Routed through
   * the master sfx bus, so it ducks under NPC voice and obeys the mute/volume
   * controls for free.
   */
  public setBandstandLevel(level: number): void {
    const q = Math.round(Math.max(0, Math.min(1, level)) * 10) / 10; // dequantise churn
    if (q === this.bandLevel) return;
    this.bandLevel = q;
    if (q <= 0) {
      if (this.bandTimer) clearTimeout(this.bandTimer);
      this.bandTimer = undefined;
      return;
    }
    if (this.bandTimer) return; // scheduler already running; new level applies per note
    const phrase = () => {
      this.bandTimer = window.setTimeout(
        () => {
          if (this.bandLevel <= 0) {
            this.bandTimer = undefined;
            return;
          }
          // A short rising-falling music-box phrase: walk the pentatonic with
          // small steps, occasional rests, soft triangle voice.
          const N = Sfx.BAND_NOTES;
          let idx = Math.floor(Math.random() * 3);
          const steps = 5 + Math.floor(Math.random() * 4);
          for (let i = 0; i < steps; i++) {
            const restRoll = Math.random();
            idx = Math.max(0, Math.min(N.length - 1, idx + (Math.random() < 0.6 ? 1 : -1)));
            const f = N[idx];
            window.setTimeout(
              () => {
                if (this.bandLevel > 0 && restRoll > 0.15) {
                  this.tone(f, f, 0.42, 'triangle', 0.035 * this.bandLevel);
                }
              },
              i * (250 + Math.random() * 60),
            );
          }
          phrase();
        },
        3500 + Math.random() * 4000,
      );
    };
    phrase();
  }

  private ducked = false;

  /** Duck the whole sfx bus (beds + one-shots) under NPC voice so speech
   *  owns the foreground; restore when the line ends. Idempotent. */
  public duckForVoice(on: boolean): void {
    if (on === this.ducked) return;
    this.ducked = on;
    const ctx = this.ctxOrNull;
    if (!ctx || !this.master) return; // nothing audible to duck yet
    this.master.gain.setTargetAtTime(on ? 0.18 : 0.5, ctx.currentTime, on ? 0.1 : 0.35);
  }

  private seaGain: GainNode | null = null;
  private seaLevel = -1;

  /**
   * Looping ocean bed: low-passed noise with a slow swell LFO so the shore
   * breathes. Level 0..1 (louder in/near water); ramps over 1.2s. Safe to call
   * every frame — no-ops until the level changes.
   */
  public setSeaLevel(level: number): void {
    if (level === this.seaLevel) return;
    const ctx = this.ctxOrNull;
    if (!ctx) return;
    if (!this.seaGain) {
      const src = ctx.createBufferSource();
      src.buffer = this.ensureNoise(ctx);
      src.loop = true;
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 650;
      this.seaGain = ctx.createGain();
      this.seaGain.gain.value = 0;
      src.connect(lp);
      lp.connect(this.seaGain);
      this.seaGain.connect(this.ensureMaster(ctx));
      src.start();
      // Slow swell — an LFO nudging the bed gain up and down like waves
      const lfo = ctx.createOscillator();
      lfo.frequency.value = 0.12;
      const lfoGain = ctx.createGain();
      lfoGain.gain.value = 0.02;
      lfo.connect(lfoGain);
      lfoGain.connect(this.seaGain.gain);
      lfo.start();
    }
    this.seaLevel = level;
    const t = ctx.currentTime;
    this.seaGain.gain.cancelScheduledValues(t);
    this.seaGain.gain.setValueAtTime(this.seaGain.gain.value, t);
    this.seaGain.gain.linearRampToValueAtTime(0.075 * level, t + 1.2);
  }

  private engineOsc: OscillatorNode | null = null;
  private engineSub: OscillatorNode | null = null;
  private engineGain: GainNode | null = null;

  /**
   * Vehicle engine loop. `kind` null fades it out; otherwise a rumble whose
   * pitch + volume rise with `throttle` (0..1), tuned per craft. Call every
   * frame while riding.
   */
  public setEngine(kind: 'car' | 'boat' | 'jetski' | null, throttle: number): void {
    const ctx = this.ctxOrNull;
    if (!ctx) return;
    if (!kind) {
      if (this.engineGain) {
        const t = ctx.currentTime;
        this.engineGain.gain.cancelScheduledValues(t);
        this.engineGain.gain.setTargetAtTime(0, t, 0.08);
      }
      return;
    }
    if (!this.engineOsc) {
      this.engineOsc = ctx.createOscillator();
      this.engineOsc.type = 'sawtooth';
      this.engineSub = ctx.createOscillator();
      this.engineSub.type = 'sine'; // a sub-octave for body
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 900;
      this.engineGain = ctx.createGain();
      this.engineGain.gain.value = 0;
      this.engineOsc.connect(lp);
      this.engineSub.connect(lp);
      lp.connect(this.engineGain);
      this.engineGain.connect(this.ensureMaster(ctx));
      this.engineOsc.start();
      this.engineSub.start();
    }
    const base = kind === 'jetski' ? 150 : kind === 'boat' ? 95 : 72;
    const f = base * (1 + Math.min(1, Math.abs(throttle)) * 0.85);
    const t = ctx.currentTime;
    this.engineOsc!.frequency.setTargetAtTime(f, t, 0.06);
    this.engineSub!.frequency.setTargetAtTime(f * 0.5, t, 0.06);
    const g = 0.028 + Math.min(1, Math.abs(throttle)) * 0.045; // idle + throttle
    this.engineGain!.gain.setTargetAtTime(g, t, 0.06);
  }
}

export const sfx = new Sfx();
