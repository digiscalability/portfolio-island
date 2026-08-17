// @vitest-environment happy-dom
// Locks for the two "silent session" bugs from the 2026-08-17 audio-control
// review (16-agent, adversarially verified).
//
// 1. The boot gesture-unlock used to detach BOTH of its listeners before
//    checking whether the audio system existed — and the AudioManager is
//    created ~5s later (idle + dynamic import). A tap during the load window
//    burned the one-shot on nothing; the context was then created 'suspended'
//    outside any gesture, and Safari/iOS (no sticky activation) stayed silent
//    for the whole session while the HUD showed unmuted.
// 2. Nothing ever resumed the context after an OS interruption: iOS moves it
//    to 'interrupted'/'suspended' on screen lock, app switch or a call, and
//    the only remaining resume paths needed a peer voice clip, an NPC cloud
//    line, or the mute-on-then-off trick.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

import { AudioManager } from '../AudioManager';

const src = (f: string): string => readFileSync(join(process.cwd(), f), 'utf8');

/** Minimal AudioContext double: state machinery + the nodes ensureCtx touches. */
const mockCtx = () => {
  const calls = { resume: 0, suspend: 0 };
  const ctx = {
    state: 'suspended' as AudioContextState,
    currentTime: 0,
    destination: {},
    onstatechange: null as (() => void) | null,
    createGain: () => ({
      gain: {
        value: 0,
        cancelScheduledValues: () => undefined,
        setValueAtTime: () => undefined,
        linearRampToValueAtTime: () => undefined,
      },
      connect: () => undefined,
      disconnect: () => undefined,
    }),
    resume() {
      calls.resume += 1;
      ctx.state = 'running';
      return Promise.resolve();
    },
    suspend() {
      calls.suspend += 1;
      ctx.state = 'suspended';
      return Promise.resolve();
    },
    close: () => Promise.resolve(),
    calls,
  };
  return ctx;
};

const fresh = () => {
  localStorage.removeItem('ds_audio_settings');
  const ctx = mockCtx();
  const am = new AudioManager(ctx as unknown as AudioContext);
  am.ensureCtx(); // hooks the lifecycle
  return { ctx, am };
};

describe('the context resumes after OS interruptions', () => {
  test('pageshow resumes a suspended context when the user wants sound', () => {
    const { ctx } = fresh();
    ctx.state = 'suspended'; // the OS took it (screen lock, app switch)
    window.dispatchEvent(new Event('pageshow'));
    expect(ctx.calls.resume).toBe(1);
    expect(ctx.state).toBe('running');
  });

  test('a tap resumes it too — iOS can refuse a NON-gesture resume after an interruption', () => {
    const { ctx } = fresh();
    ctx.state = 'suspended';
    window.dispatchEvent(new Event('pointerdown'));
    expect(ctx.calls.resume).toBe(1);
  });

  test('a running context is left alone — no per-tap resume spam', () => {
    const { ctx } = fresh();
    ctx.state = 'running';
    window.dispatchEvent(new Event('pointerdown'));
    window.dispatchEvent(new Event('pageshow'));
    expect(ctx.calls.resume).toBe(0);
  });
});

describe("mute's deliberate suspend is never overridden", () => {
  test('no lifecycle event resumes a MUTED context', () => {
    const { ctx, am } = fresh();
    am.toggleMute(); // -> muted; suspends the ctx on purpose
    const resumesAfterMute = ctx.calls.resume;
    window.dispatchEvent(new Event('pageshow'));
    window.dispatchEvent(new Event('pointerdown'));
    document.dispatchEvent(new Event('visibilitychange'));
    ctx.onstatechange?.(); // the suspend's own statechange must not loop
    expect(ctx.calls.resume).toBe(resumesAfterMute);
    expect(ctx.state).toBe('suspended');
  });

  test('unmute still resumes (the one path that always worked)', () => {
    const { ctx, am } = fresh();
    am.toggleMute();
    am.toggleMute();
    expect(ctx.state).toBe('running');
  });
});

describe('dispose unhooks the lifecycle', () => {
  test('a disposed manager cannot resurrect its closed context', () => {
    const { ctx, am } = fresh();
    am.dispose();
    ctx.state = 'suspended';
    window.dispatchEvent(new Event('pageshow'));
    window.dispatchEvent(new Event('pointerdown'));
    expect(ctx.calls.resume).toBe(0);
  });
});

describe('the sfx duck survives a mute during a voice line', () => {
  // The wedge: voice ducks the bus to 0.18 -> user mutes -> toggleMute flips
  // muted FIRST, then fires callbacks -> Speech's unduck runs duckForVoice(false)
  // with ctxOrNull already null. The old code committed the flag and skipped
  // the gain write, and its idempotence guard made every later unduck a no-op:
  // every sound for the rest of the session played at 18%.
  const sfxRig = async () => {
    const { Sfx } = await import('../Sfx');
    let muted = false;
    const gainWrites: number[] = [];
    const ctx = {
      state: 'running' as AudioContextState,
      currentTime: 0,
      destination: {},
      createGain: () => ({
        gain: {
          value: 0.5,
          setTargetAtTime: (v: number) => gainWrites.push(v),
        },
        connect: () => undefined,
      }),
    };
    (window as unknown as { audioManager: unknown }).audioManager = {
      isMuted: () => muted,
      ensureCtx: () => ctx,
      getDestination: () => ({}),
    };
    const s = new Sfx() as unknown as {
      duckForVoice(on: boolean): void;
      ensureMaster(c: unknown): { gain: { value: number } };
      ctxOrNull: unknown;
      ducked: boolean;
      duckApplied: boolean;
    };
    const master = s.ensureMaster(ctx); // bus exists, as it would mid-session
    return { s, master, gainWrites, setMuted: (m: boolean) => (muted = m) };
  };

  test('THE REGRESSION: unduck while muted heals on the next reachable frame', async () => {
    const { s, gainWrites, setMuted } = await sfxRig();
    s.duckForVoice(true); // voice line starts
    expect(gainWrites.at(-1)).toBe(0.18);
    setMuted(true); // user hits mute; Speech's cleanup unducks while muted
    s.duckForVoice(false);
    expect(gainWrites.at(-1)).toBe(0.18); // write skipped — bus unreachable
    setMuted(false); // user unmutes later
    void s.ctxOrNull; // any bed tick / one-shot observes a usable ctx...
    expect(gainWrites.at(-1)).toBe(0.5); // ...and the bus heals to full
  });

  test('a bus (re)built mid-voice is born ducked', async () => {
    const { s } = await sfxRig();
    s.duckForVoice(true);
    const ctx2 = {
      state: 'running',
      currentTime: 0,
      destination: {},
      createGain: () => ({
        gain: { value: -1, setTargetAtTime: () => undefined },
        connect: () => undefined,
      }),
    };
    const rebuilt = s.ensureMaster(ctx2); // ctx swap during the line
    expect(rebuilt.gain.value).toBe(0.18); // derived, not the 0.5 constant
  });

  test('repeat duck calls do not spam gain writes', async () => {
    const { s, gainWrites } = await sfxRig();
    s.duckForVoice(true);
    const n = gainWrites.length;
    s.duckForVoice(true);
    void s.ctxOrNull;
    expect(gainWrites.length).toBe(n); // applied state matches intent — no-op
  });
});

describe('the boot unlock stays armed until there is something to unlock', () => {
  test('resumeAudio checks for the manager BEFORE detaching its listeners', () => {
    // The old order — removeEventListener first, look for window.audioManager
    // second — is the whole bug: the manager arrives ~5s after first paint.
    const m = src('main-simple.ts');
    const i = m.indexOf('const resumeAudio = ()');
    expect(i, 'resumeAudio not found').toBeGreaterThan(-1);
    const body = m.slice(i, i + 1800);
    const guard = body.indexOf('if (!am) return;');
    const detach = body.indexOf("window.removeEventListener('keydown', resumeAudio)");
    expect(guard, 'the not-booted guard must exist').toBeGreaterThan(-1);
    expect(detach).toBeGreaterThan(-1);
    expect(guard, 'the guard must come BEFORE the detach').toBeLessThan(detach);
  });

  test('creating the manager attempts one sticky-activation resume', () => {
    // Chrome grants sticky activation after any prior gesture, so a resume
    // right after the late boot recovers those sessions without waiting for
    // another tap; WebKit no-ops it and the still-armed listener covers it.
    const m = src('main-simple.ts')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    const i = m.indexOf("new (await import('./AudioManager')).AudioManager()");
    expect(i).toBeGreaterThan(-1);
    expect(m.slice(i, i + 400)).toContain('.ensureCtx().resume()');
  });
});
