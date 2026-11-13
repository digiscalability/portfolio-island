// @vitest-environment happy-dom
//
// Villagers who gesture while they talk, with bubbles you can read (B8 with
// CO-B4). Behavioural on GameScene's own methods (a real GameScene, its
// world build switched off), plus source locks where the per-frame loop is
// too big to drive here.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as THREE from 'three';
import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest';

import { a11y } from '../Accessibility';
import { GameScene } from '../GameScene';
import { ACTIVITY_DEFS } from '../NpcActivities';

const src = (f: string): string =>
  readFileSync(join(process.cwd(), f), 'utf8').replace(/\r\n/g, '\n');

interface Talk {
  camera: THREE.PerspectiveCamera;
  heldNpcName: string | null;
  talkArm: number[];
  talkPitch: number;
  talkRoll: number;
  talkT0: number;
  talkHopAt: number;
  talkHopFor: string | null;
  talkSpeaking: string | null;
  talkTyping: string | null;
  setNpcDialogueHold(name: string | null): void;
  updateNpcTalk(now: number, dt: number): void;
  spriteWidthClamp(worldW: number, dist: number): number;
  viewDepth(p: THREE.Vector3): number;
  showNpcSpeechBubble(i: number, text: string, time: number): void;
  paintNpcSpeechBubble(i: number, text: string, time: number): void;
  bubbleFont: string;
}

const statics = GameScene as unknown as {
  isCoarsePointer(): boolean;
  talkBeatGap(name: string, k: number): number;
  talkEnvelope(u: number): number;
  measureHeadTop(ref: THREE.Object3D): number | undefined;
  NPC_ROLES: Record<string, { emoji: string; role: string }>;
};

let scene: Talk;
const NAMES = ['Night Watch', 'Village Baker', 'Elder Sage', 'Gardener', 'Courier', 'Artist'];

beforeAll(() => {
  const init = vi
    .spyOn(GameScene.prototype as unknown as { initialize: () => Promise<void> }, 'initialize')
    .mockResolvedValue(undefined);
  scene = new GameScene() as unknown as Talk;
  init.mockRestore();
  scene.camera = new THREE.PerspectiveCamera(50, 1.6, 0.1, 2000);
});

afterEach(() => {
  scene.setNpcDialogueHold(null);
  a11y.reducedMotion = false;
});

/** Hold `name` and run the talk pose for `secs` at 60 fps from t0. */
const run = (name: string, secs: number, onFrame?: (t: number) => void): void => {
  scene.setNpcDialogueHold(name);
  const t0 = scene.talkT0;
  for (let f = 1; f <= Math.round(secs * 60); f++) {
    scene.updateNpcTalk(t0 + f / 60, 1 / 60);
    onFrame?.(f / 60);
  }
};

describe('?touch=1 exactly picks the phone pins (CO-B4)', () => {
  const at = (search: string): boolean => {
    window.history.replaceState(null, '', `/${search}`);
    return statics.isCoarsePointer();
  };
  test('a desktop from ?utm_content=get-in-touch keeps the desktop pin scale', () => {
    const touchCapable = 'ontouchstart' in window || (navigator.maxTouchPoints ?? 0) > 0;
    if (touchCapable) return; // the environment itself is a touch device
    expect(at('?utm_content=get-in-touch')).toBe(false);
    expect(at('?touch=0')).toBe(false);
    expect(at('?touch=1')).toBe(true);
    expect(at('?a=1&touch=1')).toBe(true);
    window.history.replaceState(null, '', '/');
  });
});

describe('villagers gesture as they talk (B8)', () => {
  test('a beat every 0.9-1.6 s, seeded per name', () => {
    for (const n of NAMES) {
      for (let k = 0; k < 20; k++) {
        const g = statics.talkBeatGap(n, k);
        expect(g).toBeGreaterThanOrEqual(0.9);
        expect(g).toBeLessThanOrEqual(1.6);
        expect(statics.talkBeatGap(n, k)).toBe(g); // the same on every visit
      }
    }
  });

  test('180 ms in, 250 ms held, 300 ms out', () => {
    const e = statics.talkEnvelope;
    expect(e(-0.01)).toBe(0);
    expect(e(0.09)).toBeCloseTo(0.5, 6);
    expect(e(0.18)).toBe(1);
    expect(e(0.43)).toBe(1);
    expect(e(0.58)).toBeCloseTo(0.5, 6);
    expect(e(0.73)).toBe(0);
  });

  test.each(NAMES)(
    '%s: the first gesture inside 1.6 s, an arm range of 40 degrees over 4 s',
    (n) => {
      let first = -1;
      const lo = [Infinity, Infinity];
      const hi = [-Infinity, -Infinity];
      run(n, 4, (t) => {
        scene.talkArm.forEach((a, i) => {
          lo[i] = Math.min(lo[i], a);
          hi[i] = Math.max(hi[i], a);
          if (first < 0 && a < -0.05) first = t;
        });
      });
      expect(first).toBeGreaterThan(0);
      expect(first).toBeLessThanOrEqual(1.6);
      const range = Math.max(hi[0] - lo[0], hi[1] - lo[1]);
      expect(THREE.MathUtils.radToDeg(range)).toBeGreaterThanOrEqual(40);
    },
  );

  test('reduced motion: half-amplitude beats, no nod or sway', () => {
    a11y.reducedMotion = true;
    scene.talkSpeaking = 'Elder Sage';
    let range = 0;
    let pitch = 0;
    run('Elder Sage', 4, () => {
      range = Math.max(range, -Math.min(...scene.talkArm));
      pitch = Math.max(pitch, Math.abs(scene.talkPitch), Math.abs(scene.talkRoll));
    });
    expect(range).toBeLessThanOrEqual(0.4 + 1e-9);
    expect(range).toBeGreaterThanOrEqual(0.35 - 1e-9);
    expect(pitch).toBeLessThan(1e-6);
    scene.talkSpeaking = null;
  });

  test('speaking: a nod of 0.05 rad at 2.2 Hz and a sway of 0.035 at 0.35 Hz', () => {
    scene.talkSpeaking = 'Gardener';
    let pitch = 0;
    let roll = 0;
    run('Gardener', 3, () => {
      pitch = Math.max(pitch, Math.abs(scene.talkPitch));
      roll = Math.max(roll, Math.abs(scene.talkRoll));
    });
    expect(pitch).toBeGreaterThan(0.03);
    expect(pitch).toBeLessThanOrEqual(0.05);
    expect(roll).toBeGreaterThan(0.02);
    expect(roll).toBeLessThanOrEqual(0.035);
    scene.talkSpeaking = null;
  });

  test('the lean shows within 200 ms of a typing event', () => {
    scene.setNpcDialogueHold('Courier');
    window.dispatchEvent(
      new CustomEvent('ds:npc-typing', { detail: { name: 'Courier', typing: true } }),
    );
    expect(scene.talkTyping).toBe('Courier');
    let at = -1;
    run('Courier', 0.5, (t) => {
      if (at < 0 && scene.talkPitch > 0.07 * 0.9) at = t;
    });
    expect(at).toBeGreaterThan(0);
    expect(at).toBeLessThanOrEqual(0.2);
    window.dispatchEvent(
      new CustomEvent('ds:npc-typing', { detail: { name: 'Courier', typing: false } }),
    );
    expect(scene.talkTyping).toBeNull();
  });

  test('a reply that ends schedules one hop; the random hop is gone', () => {
    scene.setNpcDialogueHold('Artist');
    const speak = (speaking: boolean): void => {
      window.dispatchEvent(
        new CustomEvent('ds:npc-speaking', { detail: { name: 'Artist', speaking } }),
      );
    };
    speak(true);
    expect(scene.talkHopAt).toBe(-1);
    const now = performance.now() / 1000;
    speak(false);
    expect(scene.talkHopFor).toBe('Artist');
    expect(scene.talkHopAt).toBeGreaterThanOrEqual(now + 0.14);
    expect(scene.talkHopAt).toBeLessThan(now + 0.3);
    // The wander loop hops only while the chat is still held with them: a
    // panel close sends speaking:false and releases the hold in one task.
    const g = src('GameScene.ts');
    expect(g).toContain(
      'if (this.talkHopFor === npc.name && !a11y.reducedMotion) data.greetT0 = time;',
    );
    const held = g.indexOf('const held = this.heldNpcName === npc.name;');
    const hop = g.indexOf('if (this.talkHopAt >= 0 && time >= this.talkHopAt)');
    expect(held).toBeGreaterThan(-1);
    expect(hop).toBeGreaterThan(held);
    expect(g).not.toContain('nextTalkHopAt');
  });

  test('gestures compose onto the rest quaternions and the root multiply', () => {
    const g = src('GameScene.ts');
    expect(g).toContain('l.ang = this.talkArm[n - 2];');
    expect(g).toContain(
      'l.b.quaternion.copy(l.rest).multiply(this._npcLimbQ.setFromAxisAngle(l.axis, l.ang));',
    );
    expect(g).toMatch(
      /npc\.meshRef\.quaternion\.multiply\(\s*this\._npcTalkQ\.setFromEuler\(this\._npcTalkE\.set\(this\.talkPitch, 0, this\.talkRoll\)\),?\s*\);/,
    );
    expect(g).toContain("fx.register('npcTalk', { desktop: true, low: true });");
  });
});

describe('bubbles and pins you can read (B8)', () => {
  test('no sprite wider than 60% of the viewport', () => {
    // A 390x844 phone at fov 68: the 3.4 u bubble at 3 u.
    scene.camera.fov = 68;
    scene.camera.aspect = 390 / 844;
    const k = scene.spriteWidthClamp(3.4, 3);
    const viewW = 2 * 3 * Math.tan(THREE.MathUtils.degToRad(68) / 2) * (390 / 844);
    expect((3.4 * k) / viewW).toBeCloseTo(0.6, 6);
    // Far away it fits: no change.
    expect(scene.spriteWidthClamp(3.4, 40)).toBe(1);
    scene.camera.fov = 50;
    scene.camera.aspect = 1.6;
  });

  test('the clamp reads view depth, so an off-centre sprite holds 60% too', () => {
    // E's npc.cjs measured the conversing villager's bubble at 917 of 1440 px
    // (64%): the clamp took the straight-line distance, which overstates the
    // depth a camera-facing sprite's width divides by.
    const cam = scene.camera;
    cam.position.set(0, 0, 0);
    cam.lookAt(0, 0, -1);
    cam.updateMatrixWorld(true);
    const p = new THREE.Vector3(2, 1.5, -3);
    expect(scene.viewDepth(p)).toBeCloseTo(3, 6);
    expect(p.length()).toBeGreaterThan(3.5);
    // Projected width at that depth is exactly 60% of the view.
    const k = scene.spriteWidthClamp(3.4, scene.viewDepth(p));
    const viewW = 2 * 3 * Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2) * cam.aspect;
    expect((3.4 * k) / viewW).toBeCloseTo(0.6, 6);
    // Behind the camera it falls back to the straight line.
    expect(scene.viewDepth(new THREE.Vector3(0, 0, 2))).toBeCloseTo(2, 6);
  });

  test('a bubble faded for a chat is not drawn, and comes back after', () => {
    const g = src('GameScene.ts');
    const at = g.indexOf('if (this.npcBubble && this.npcBubbleLive) {');
    expect(at).toBeGreaterThan(-1);
    const block = g.slice(at, g.indexOf('// Drain colliders', at));
    expect(block).toContain('this.viewDepth(this.npcBubble.sprite.position)');
    expect(block).toContain('this.npcBubble.sprite.visible = bo > 0.02;');
    expect(block).toContain('this.npcBubbleLive = false;');
    expect(g).toContain('this.spriteWidthClamp(1.7, this.viewDepth(tag.sprite.position))');
  });

  test("a quest giver's bubble sits above its '!' (bubble.cjs: the mark cut the text)", () => {
    const g = src('GameScene.ts');
    // The mark: 2.7 u up, its bar reaching +0.30 and bobbing 0.12.
    expect(g).toContain('marker.position.copy(base).addScaledVector(normal, 2.7);');
    expect(g).toContain('bar.position.y = 0.14;');
    expect(g).toContain('new THREE.BoxGeometry(0.09, 0.32, 0.09)');
    expect((GameScene as unknown as { QUEST_MARK_TOP: number }).QUEST_MARK_TOP).toBeCloseTo(
      2.7 + 0.14 + 0.16 + 0.12,
      6,
    );
    expect(g).toContain('lift = Math.max(lift, GameScene.QUEST_MARK_TOP + 0.06 - pinUp);');
  });

  test('the pin sits above the measured head top', () => {
    const ref = new THREE.Group();
    ref.scale.setScalar(0.64);
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.5, 2.6, 0.5));
    body.position.y = 1.3; // a model 2.6 tall, feet at 0
    ref.add(body);
    expect(statics.measureHeadTop(ref)).toBeCloseTo(2.6 * 0.64, 6);
    expect(statics.measureHeadTop(new THREE.Group())).toBeUndefined();
    const g = src('GameScene.ts');
    expect(g).toContain('const anchor = Math.max(1.55, (tag.headTop ?? 0) + 0.15);');
  });

  test('the bubble paints once the font loads, or after 3 s, and again when it lands', async () => {
    vi.useFakeTimers();
    let resolve: () => void = () => {};
    const load = vi.fn(() => new Promise<void>((r) => (resolve = r)));
    const had = (document as { fonts?: unknown }).fonts;
    Object.defineProperty(document, 'fonts', { value: { load }, configurable: true });
    const paint = vi.spyOn(scene, 'paintNpcSpeechBubble').mockImplementation(() => {});
    try {
      scene.bubbleFont = 'idle';
      scene.showNpcSpeechBubble(0, 'Hello there', performance.now() / 1000);
      expect(load).toHaveBeenCalledWith(`26px 'Patrick Hand'`);
      expect(paint).not.toHaveBeenCalled();
      vi.advanceTimersByTime(3000);
      expect(paint).toHaveBeenCalledTimes(1); // the fallback face, at 3 s
      resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(paint).toHaveBeenCalledTimes(2); // and the real one when it lands
      expect(scene.bubbleFont).toBe('ready');
      scene.showNpcSpeechBubble(0, 'Again', performance.now() / 1000);
      expect(paint).toHaveBeenCalledTimes(3); // no wait once loaded
    } finally {
      paint.mockRestore();
      vi.useRealTimers();
      Object.defineProperty(document, 'fonts', { value: had, configurable: true });
    }
  });

  test('bubble paper #e8e2d4, a 2 px #3a3128 rim, #1f1a14 ink at 600, in the twin too', () => {
    const g = src('GameScene.ts');
    expect(g).toContain("ctx.fillStyle = '#e8e2d4';");
    expect(g).toContain("ctx.strokeStyle = '#3a3128';");
    expect(g).toContain("ctx.fillStyle = '#1f1a14';");
    expect(g).toContain(`ctx.font = '600 26px "Patrick Hand", system-ui, sans-serif';`);
    const h = src('HudLabels.ts');
    expect(h).toContain("background: '#e8e2d4',");
    expect(h).toContain("color: '#1f1a14',");
    expect(h).toContain("border: '2px solid #3a3128',");
    expect(h).toContain("fontWeight: '600',");
    expect(h).toContain('const PROMOTE_DIST = 20;');
    expect(h).toContain('const DEMOTE_DIST = 22;');
  });

  test("the Night Watch's pin reads 'Night Watch' over 'on his round'", () => {
    expect(statics.NPC_ROLES['Night Watch'].role).toBe('Night Watch');
    expect(ACTIVITY_DEFS.lamp_round.short).toBe('on his round');
    expect(ACTIVITY_DEFS.keep_light.short).not.toBe('on watch');
  });
});
