// @vitest-environment happy-dom
//
// App Check signal (the 2026-11-02 pass, step i2b): when the npcChat call falls
// back, the villager answers in written lines. That used to happen silently,
// so an App Check failure on the live site looked like a quiet AI. Every
// fallback is now counted as npc_fallback {reason, stage}, with the callable's
// error code when the call itself failed.
import { beforeEach, describe, expect, test, vi } from 'vitest';

const { call, callable, app } = vi.hoisted(() => {
  const call = vi.fn();
  return { call, callable: vi.fn(() => call), app: vi.fn(async () => ({})) };
});

vi.mock('../firebaseClient', () => ({ getFirebaseApp: app }));
vi.mock('firebase/functions', () => ({
  getFunctions: () => ({}),
  httpsCallable: callable,
}));

import { askNpc, askNpcOpening, NPC_TIMEOUT_MS } from '../NpcChat';

const fallbacks = () => (window.__analyticsLog ?? []).filter((e) => e.name === 'npc_fallback');

beforeEach(() => {
  call.mockReset();
  callable.mockClear();
  app.mockReset();
  app.mockResolvedValue({});
  localStorage.clear();
  sessionStorage.clear();
  window.__analyticsLog = [];
});

describe('npc_fallback', () => {
  test('a server-side fallback is counted with its reason', async () => {
    call.mockResolvedValue({ data: { reply: null, fallback: true, reason: 'rate' } });
    const res = await askNpc('Gardener', 'Hello there');
    expect(res).toEqual({ reply: null, fallback: true, reason: 'rate' });
    expect(fallbacks()).toEqual([
      { name: 'npc_fallback', props: { reason: 'rate', stage: 'reply' } },
    ]);
  });

  test('a rejected call is counted with its error code (App Check: unauthenticated)', async () => {
    call.mockRejectedValue(
      Object.assign(new Error('unauthenticated'), { code: 'functions/unauthenticated' }),
    );
    const res = await askNpcOpening('Gardener', 'Good morning — tending the beds.');
    expect(res.fallback).toBe(true);
    expect(res.reason).toBe('client:functions/unauthenticated');
    expect(fallbacks()).toEqual([
      {
        name: 'npc_fallback',
        props: { reason: 'client:functions/unauthenticated', stage: 'opening' },
      },
    ]);
  });

  test('an error without a code still counts', async () => {
    call.mockRejectedValue(new Error('offline'));
    expect((await askNpc('Gardener', 'hi')).reason).toBe('client-error');
    expect(fallbacks()).toHaveLength(1);
  });

  test('an empty "success" is a written line on screen, so it counts', async () => {
    call.mockResolvedValue({ data: { reply: '', fallback: false } });
    const res = await askNpc('Gardener', 'hi');
    expect(res.fallback).toBe(true);
    expect(fallbacks()[0].props).toEqual({ reason: 'empty-reply', stage: 'reply' });
  });

  test('a real reply is not a fallback and counts nothing', async () => {
    call.mockResolvedValue({ data: { reply: 'The roses are thirsty today.', fallback: false } });
    const res = await askNpc('Gardener', 'How are the flowers?');
    expect(res).toEqual({ reply: 'The roses are thirsty today.', fallback: false });
    expect(fallbacks()).toEqual([]);
  });

  // D10: a stalled call left the bare '…' up with no end.
  test('the callable carries a 12 s timeout', async () => {
    call.mockResolvedValue({ data: { reply: 'Hello.', fallback: false } });
    await askNpc('Gardener', 'hi');
    expect(NPC_TIMEOUT_MS).toBe(12000);
    expect(callable).toHaveBeenCalledWith(expect.anything(), 'npcChat', { timeout: 12000 });
  });

  test('a call that never answers falls back at 12 s, counted once as client:timeout', async () => {
    vi.useFakeTimers();
    try {
      let late!: (v: unknown) => void;
      call.mockReturnValue(new Promise((r) => (late = r)));
      let res: Awaited<ReturnType<typeof askNpc>> | null = null;
      void askNpc('Gardener', 'Are you there?').then((r) => (res = r));
      await vi.advanceTimersByTimeAsync(11900);
      expect(res).toBeNull();
      await vi.advanceTimersByTimeAsync(200);
      expect(res).toEqual({ reply: null, fallback: true, reason: 'client:timeout' });
      // The model answers after all: the visitor already has a written line,
      // so the late reply is dropped and nothing is counted twice.
      late({ data: { reply: 'Sorry, I was miles away.', fallback: false } });
      await vi.advanceTimersByTimeAsync(50);
      expect(fallbacks()).toEqual([
        { name: 'npc_fallback', props: { reason: 'client:timeout', stage: 'reply' } },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  test('a sign-in that stalls before the call is made falls back at 12 s too', async () => {
    vi.useFakeTimers();
    try {
      app.mockReturnValue(new Promise(() => {})); // App Check or auth never settles
      let res: Awaited<ReturnType<typeof askNpc>> | null = null;
      void askNpc('Gardener', 'hi').then((r) => (res = r));
      await vi.advanceTimersByTimeAsync(12000);
      expect(res).toEqual({ reply: null, fallback: true, reason: 'client:timeout' });
      expect(call).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  test('no call made (not an AI villager, empty text): nothing to count', async () => {
    expect((await askNpc('Market Vendor', 'hi')).reason).toBe('not-ai');
    expect((await askNpc('Gardener', '   ')).reason).toBe('empty');
    expect(call).not.toHaveBeenCalled();
    expect(fallbacks()).toEqual([]);
  });
});
