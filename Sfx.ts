/**
 * Sfx — tiny procedural one-shot synthesizer for interaction feedback.
 *
 * Every effect is an oscillator or filtered-noise burst with an envelope —
 * zero audio assets. Uses the shared AudioContext from window.audioManager
 * (created on the first user gesture by startBackgroundMusic) so the global
 * mute/suspend state silences SFX too. All nodes disconnect on end.
 */

type AudioManagerLike = { ensureCtx(): AudioContext; isMuted(): boolean };

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
    this.master.connect(ctx.destination);
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

  /** Soft grass scuff, alternating left/right foot timbre. */
  public footstep(altFoot: boolean): void {
    this.hiss(0.055, 0.09, altFoot ? 680 : 520);
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
}

export const sfx = new Sfx();
