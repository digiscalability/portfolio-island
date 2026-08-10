/**
 * HudLabels — hybrid DOM twins for sentence-bearing speech bubbles
 * (mobile-HUD Round 3, Phase 5).
 *
 * WHY: on a DPR-3 phone the renderer outputs ~0.75-1.25 device px per CSS px
 * (DPR cap 1.25 × adaptive renderScale), then CSS upscales 2.4-4× — sprite
 * TEXT can never be sharp, and raising the canvas supersample only worsens
 * LinearFilter/no-mipmap shimmer (the framebuffer is the bottleneck, not the
 * texture). But the text people actually READ is ≤4 near bubbles. So: the
 * nearest ≤4 sentence bubbles inside 14u swap to crisp DOM twins; everything
 * else stays a sprite. Name pins stay sprites forever.
 *
 * Budget: ≤4 × (one vec3 project + maybe one transform write) per frame,
 * zero DOM churn on non-promoted frames (0.5px delta skip), transform-only
 * writes (compositor path). Kill switch: ?domlabels=0.
 */
import * as THREE from 'three';

/** Promote under 14u, demote over 16u — 2u hysteresis so a bobbing camera
 *  never flickers the representation at the boundary. */
const PROMOTE_DIST = 14;
const DEMOTE_DIST = 16;
const MAX_TWINS = 4;
const FADE_MS = 150;

export interface BubbleCandidate {
  /** Stable identity across frames (peer id, 'self', 'npc'). */
  key: string;
  text: string;
  /** The sprite being twinned — hidden while the DOM twin is live. */
  sprite: THREE.Sprite;
  /** World position of the bubble (the sprite's world position). */
  worldPos: THREE.Vector3;
  /** Visual family: player/peer chat (dark pill) vs NPC (paper note). */
  theme: 'chat' | 'npc';
}

interface Twin {
  div: HTMLDivElement;
  sprite: THREE.Sprite;
  text: string;
  lastX: number;
  lastY: number;
  dying: number | null; // timeout id while fading out
}

export class HudLabels {
  private readonly twins = new Map<string, Twin>();
  private readonly enabled: boolean;
  private readonly _proj = new THREE.Vector3();

  constructor(private readonly host: HTMLElement) {
    // ?domlabels=0 reverts to sprites everywhere (the escape hatch).
    let on = true;
    try {
      on = new URLSearchParams(window.location.search).get('domlabels') !== '0';
    } catch {
      /* keep on */
    }
    this.enabled = on;
  }

  /** Per-frame. Candidates are the LIVE sentence bubbles; order free. */
  update(camera: THREE.Camera, candidates: BubbleCandidate[]): void {
    if (!this.enabled) return;
    const camPos = camera.position;
    // Rank by distance; keep only those inside their applicable threshold.
    const ranked = candidates
      .map((c) => ({ c, d: c.worldPos.distanceTo(camPos) }))
      .filter(({ c, d }) => (this.twins.has(c.key) ? d < DEMOTE_DIST : d < PROMOTE_DIST))
      .sort((a, b) => a.d - b.d)
      .slice(0, MAX_TWINS);
    const keep = new Set(ranked.map(({ c }) => c.key));

    // Demote twins whose bubble left range, expired, or fell past the cap.
    for (const [key, twin] of this.twins) {
      if (keep.has(key)) continue;
      this.demote(key, twin);
    }

    const w = window.innerWidth;
    const h = window.innerHeight;
    for (const { c } of ranked) {
      let twin = this.twins.get(c.key);
      if (twin && (twin.text !== c.text || twin.sprite !== c.sprite)) {
        // Same speaker, new message (or a rebuilt sprite): rebuild the twin.
        this.demote(c.key, twin, true);
        twin = undefined;
      }
      if (!twin) {
        twin = this.promote(c);
        this.twins.set(c.key, twin);
      }
      // Project → CSS px. translate(-50%,-100%) bottom-anchors like the
      // sprite (center 0.5,0), so growth only ever goes upward.
      this._proj.copy(c.worldPos).project(camera);
      const behindClip = this._proj.z > 1 || this._proj.z < -1;
      // Analytic horizon occlusion — no raycast: a point around the planet's
      // curve from the camera has a low radial-alignment dot. At <14u this
      // almost never fires, which is exactly why it's sufficient.
      const overHorizon = c.worldPos.dot(camPos) / (c.worldPos.length() * camPos.length()) < 0.15;
      if (behindClip || overHorizon) {
        twin.div.style.visibility = 'hidden';
        continue;
      }
      twin.div.style.visibility = '';
      const x = (this._proj.x * 0.5 + 0.5) * w;
      const y = (-this._proj.y * 0.5 + 0.5) * h;
      // Transform-only writes, skipped under half a pixel of movement.
      if (Math.abs(x - twin.lastX) > 0.5 || Math.abs(y - twin.lastY) > 0.5) {
        twin.lastX = x;
        twin.lastY = y;
        twin.div.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0) translate(-50%, -100%)`;
      }
    }
  }

  private promote(c: BubbleCandidate): Twin {
    const div = document.createElement('div');
    div.textContent = c.text; // textContent: chat text never becomes markup
    const themed =
      c.theme === 'npc'
        ? {
            background: 'rgba(250,248,242,0.93)',
            color: '#2c2620',
            border: '1px solid rgba(60,50,40,0.3)',
            fontFamily: '"Patrick Hand", system-ui, sans-serif',
            fontSize: '15px',
          }
        : {
            background: 'rgba(20,20,28,0.82)',
            color: '#ffffff',
            fontFamily: 'system-ui, sans-serif',
            fontSize: '13.5px',
            fontWeight: '600',
          };
    Object.assign(div.style, {
      position: 'absolute',
      left: '0',
      top: '0',
      maxWidth: 'min(280px, 72vw)',
      padding: '7px 11px',
      borderRadius: '12px',
      textAlign: 'center',
      lineHeight: '1.3',
      pointerEvents: 'none',
      willChange: 'transform',
      zIndex: '1300', // over the world, under every panel band
      opacity: '0',
      transition: `opacity ${FADE_MS}ms ease`,
      ...themed,
    });
    this.host.appendChild(div);
    // Forced reflow commits the opacity:0 start state, so the transition
    // fires synchronously — no rAF dependency (dead in backgrounded tabs).
    void div.offsetWidth;
    div.style.opacity = '1';
    c.sprite.visible = false;
    return { div, sprite: c.sprite, text: c.text, lastX: -1e9, lastY: -1e9, dying: null };
  }

  /** Fade the twin out and give the sprite back. `instant` skips the fade
   *  (same-speaker rebuild — two crossfading twins would double-print). */
  private demote(key: string, twin: Twin, instant = false): void {
    this.twins.delete(key);
    twin.sprite.visible = true;
    if (instant) {
      twin.div.remove();
      return;
    }
    twin.div.style.opacity = '0';
    window.setTimeout(() => twin.div.remove(), FADE_MS + 30);
  }

  dispose(): void {
    for (const [key, twin] of this.twins) this.demote(key, twin, true);
  }
}
