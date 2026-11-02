// @vitest-environment happy-dom
//
// The 2026-11-02 pass, step i2b: the front door's runtime polish.
// DOM tests on a REAL SimpleUI where behaviour can run (loader exit, toast
// hints, compass hint, Day badge, offline replies tag, form labels), unit
// tests for analytics attribution and the owner opt-out, and source locks
// where the code only runs inside the WebGL boot (fly-in ink, canvas label,
// Firebase Auth, tour framing).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as THREE from 'three';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { entryAttribution, isOwnerVisit, track, trackOnce } from '../Analytics';
import { addGroupHulls, setInkVisible } from '../CelLook';
import { AI_NPCS } from '../NpcChat';
import { appendReceptionDesk } from '../ReceptionDesk';
import { SimpleUI } from '../SimpleUI';

const src = (f: string): string =>
  readFileSync(join(process.cwd(), f), 'utf8').replace(/\r\n/g, '\n');
const stripped = (f: string): string =>
  src(f)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
const text = (el: Element | null | undefined): string =>
  (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
/** Slice one method body: from its declaration to the next `\n  }\n`. */
const method = (file: string, marker: string): string => {
  const s = stripped(file);
  const i = s.indexOf(marker);
  expect(i, `${marker} not found in ${file}`).toBeGreaterThan(-1);
  return s.slice(i, s.indexOf('\n  }\n', i));
};

const FALLBACK = `
  <div id="boot-fallback" hidden>
    <div class="bf-card">
      <p class="bf-lead">This portfolio is normally an explorable 3D island —
        <span id="bf-reason">but it can't run in this browser.</span></p>
      <button id="bf-retry" type="button">Try again</button>
    </div>
  </div>`;

let ui: SimpleUI;

beforeEach(() => {
  document.body.innerHTML = '<div id="ui-overlay"></div>';
  localStorage.clear();
  sessionStorage.clear();
  window.__analyticsLog = [];
  ui = new SimpleUI('ui-overlay');
});

afterEach(() => {
  ui.hideLoading();
  ui.hideZonePanel();
  ui.hideWelcome(false);
  ui.closeNpcChat();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const events = (): string[] => (window.__analyticsLog ?? []).map((e) => e.name);
const toastEl = (): HTMLElement | undefined =>
  [...document.querySelectorAll<HTMLElement>('#ui-overlay > div')].find(
    (d) => d.style.zIndex === '1750',
  );

describe('the loader has a way out', () => {
  test('Quick version opens #boot-fallback with Back; Back restores the card', () => {
    document.body.innerHTML = `<div id="ui-overlay"></div>${FALLBACK}`;
    ui = new SimpleUI('ui-overlay');
    ui.showLoading(10);
    const skip = document.querySelector<HTMLButtonElement>('#ld-skip');
    expect(text(skip)).toContain('Quick version');
    skip!.click();

    const card = document.getElementById('boot-fallback')!;
    expect(card.hidden).toBe(false);
    expect(text(document.getElementById('bf-reason'))).toBe('and it is waiting behind this card.');
    expect(document.getElementById('bf-retry')!.hidden).toBe(true); // a reload is wrong here
    expect(events()).toContain('loader_skip');
    const back = document.getElementById('bf-back') as HTMLButtonElement;
    expect(text(back)).toBe('← Back to the island');
    expect(document.activeElement).toBe(back);

    back.click();
    expect(card.hidden).toBe(true);
    expect(document.getElementById('bf-back')).toBeNull();
    expect(text(document.getElementById('bf-reason'))).toBe("but it can't run in this browser.");
    expect(document.getElementById('bf-retry')!.hidden).toBe(false);
  });

  test('init failure while the quick version is open leaves no dead Back button', () => {
    document.body.innerHTML = `<div id="ui-overlay"></div>${FALLBACK}`;
    ui = new SimpleUI('ui-overlay');
    ui.showLoading(10);
    document.querySelector<HTMLButtonElement>('#ld-skip')!.click();
    ui.closeQuickVersion(); // main-simple showErrorScreen calls this first
    expect(document.getElementById('bf-back')).toBeNull();
    expect(document.getElementById('bf-retry')!.hidden).toBe(false);
    // ...and showErrorScreen does call it before it rewrites the card
    const err = method('main-simple.ts', 'private showErrorScreen');
    expect(err.indexOf('this.ui?.closeQuickVersion()')).toBeGreaterThan(-1);
    expect(err.indexOf('this.ui?.closeQuickVersion()')).toBeLessThan(
      err.indexOf('fallback.hidden'),
    );
  });

  test('init failure flags itself for the boot guard before it shows the card', () => {
    // index.html's guard stands down on this flag, so its 60 s watchdog can't
    // rewrite the reason later or send a second boot_fallback.
    const err = method('main-simple.ts', 'private showErrorScreen');
    const flag = err.indexOf('.__lifeIslandBootFailed = true;');
    expect(flag).toBeGreaterThan(-1);
    expect(flag).toBeLessThan(err.indexOf('fallback.hidden = false'));
  });

  test('the loader and quick-version buttons use the page font, not the UA button font', () => {
    document.body.innerHTML = `<div id="ui-overlay"></div>${FALLBACK}`;
    ui = new SimpleUI('ui-overlay');
    ui.showLoading(10);
    const skip = document.querySelector<HTMLButtonElement>('#ld-skip')!;
    expect(skip.style.fontFamily).toBe('inherit');
    skip.click();
    expect(document.getElementById('bf-back')!.style.fontFamily).toBe('inherit');
  });

  test('no fallback card on the page, no dead button', () => {
    ui.showLoading(10);
    expect(document.querySelector('#ld-skip')).toBeNull();
  });

  test('the loader title is 48px (desktop LCP), capped at 12vw on narrow phones', () => {
    ui.showLoading(10);
    const title = [...document.querySelectorAll<HTMLElement>('#ui-overlay div')].find(
      (d) => text(d) === 'DIGISCALABILITY LIFE ISLAND',
    );
    expect(title?.getAttribute('style')).toContain('font-size:min(48px,12vw)');
  });

  test('the pitch line reads like index.html’s static loader, count from the roster', () => {
    // index.html shows the same line before the bundle runs; keep the two in step.
    ui.showLoading(10);
    const pitch = [...document.querySelectorAll<HTMLElement>('#ui-overlay div')].find((d) =>
      text(d).startsWith("Abbas Ali's hand-built 3D portfolio"),
    );
    expect(text(pitch)).toBe(
      `Abbas Ali's hand-built 3D portfolio — a living 3D world where ${Object.keys(AI_NPCS).length} villagers talk through Claude Haiku 4.5.`,
    );
  });
});

describe('toasts never sit over a panel unasked', () => {
  test('a hint waits out an open panel; feedback inside the panel does not', () => {
    vi.useFakeTimers();
    ui.showZonePanel({ id: 'contact', name: 'contact' }, { source: 'menu' });
    ui.toast('🧭 hint line', { hint: true });
    ui.toast('Please add your email.');
    expect(text(toastEl())).toBe('Please add your email.'); // jumped the queue
    vi.advanceTimersByTime(2300 + 2100); // dwell + gap + a few polls
    expect(toastEl()!.style.opacity).toBe('0');
    expect(text(toastEl())).toBe('Please add your email.'); // the hint never showed
    ui.hideZonePanel();
    vi.advanceTimersByTime(800);
    expect(text(toastEl())).toBe('🧭 hint line');
    expect(toastEl()!.style.opacity).toBe('1');
  });

  test('a hint already showing bows out when a panel opens, and comes back after', () => {
    vi.useFakeTimers();
    ui.toast('💬 talk hint', { hint: true });
    expect(text(toastEl())).toBe('💬 talk hint');
    expect(toastEl()!.style.opacity).toBe('1');
    ui.showHireCard('menu'); // e.g. the Portfolio menu's Hiring row
    vi.advanceTimersByTime(150);
    expect(toastEl()!.style.opacity).toBe('0');
    vi.advanceTimersByTime(3000);
    expect(toastEl()!.style.opacity).toBe('0'); // still waiting behind the card
    ui.hideZonePanel();
    vi.advanceTimersByTime(800);
    expect(text(toastEl())).toBe('💬 talk hint');
    expect(toastEl()!.style.opacity).toBe('1');
  });

  test('it steps aside in the same frame the hire card opens: no poll tick, no fade', () => {
    // Measured at 390x844 before this: the compass hint stayed painted over a
    // just-opened hire card until the 120 ms poll, then faded for 200 ms.
    vi.useFakeTimers();
    ui.toast('🧭 compass hint', { hint: true });
    expect(toastEl()!.style.opacity).toBe('1');
    ui.showHireCard('cta');
    expect(toastEl()!.style.opacity).toBe('0'); // synchronously, before any timer
    expect(toastEl()!.style.transition).toBe('opacity 0.2s ease'); // the fade is back for next time
    ui.hideZonePanel();
    vi.advanceTimersByTime(800);
    expect(text(toastEl())).toBe('🧭 compass hint');
    expect(toastEl()!.style.opacity).toBe('1');
  });

  test('the Portfolio menu and the centred modals take it down at once too', () => {
    vi.useFakeTimers();
    const menuChip = [...document.querySelectorAll<HTMLElement>('.hud-btn')].find(
      (el) => el.getAttribute('aria-label') === 'Open portfolio menu',
    )!;
    ui.toast('🪙 coin hint', { hint: true });
    menuChip.click(); // opens the menu
    expect(toastEl()!.style.opacity).toBe('0');
    menuChip.click(); // closes it
    vi.advanceTimersByTime(800);
    expect(text(toastEl())).toBe('🪙 coin hint');
    expect(toastEl()!.style.opacity).toBe('1');
    ui.showReceipt([]); // a centred modal (buildCenteredModal)
    expect(toastEl()!.style.opacity).toBe('0');
  });

  test('a feedback toast is not a hint: opening a panel leaves it be', () => {
    vi.useFakeTimers();
    ui.toast('Link copied');
    ui.showHireCard('cta');
    expect(text(toastEl())).toBe('Link copied');
    expect(toastEl()!.style.opacity).toBe('1');
  });

  test('with nothing open, hints and feedback keep their order', () => {
    vi.useFakeTimers();
    ui.toast('first', { hint: true });
    ui.toast('second');
    expect(text(toastEl())).toBe('first');
  });

  test('a welcome CTA that opens a panel skips the compass hint; Explore keeps it', () => {
    vi.useFakeTimers();
    ui.showWelcome(null);
    document.querySelector<HTMLButtonElement>('button[data-cta="contact"]')!.click();
    ui.hideZonePanel();
    vi.advanceTimersByTime(4000);
    expect(text(toastEl())).not.toContain('gold ➤');
    expect(localStorage.getItem('ds_hint_compass')).toBeNull();

    localStorage.clear(); // a fresh first visit
    ui.showWelcome(null);
    document.querySelector<HTMLButtonElement>('button[data-dismiss]')!.click();
    vi.advanceTimersByTime(800);
    expect(text(toastEl())).toContain('The gold ➤ up top points to your next stop');
  });

  test('the Hiring pill also skips it (the hire card is a panel)', () => {
    vi.useFakeTimers();
    ui.showWelcome(null);
    document.querySelector<HTMLButtonElement>('button[data-recruit]')!.click();
    ui.hideZonePanel();
    vi.advanceTimersByTime(4000);
    expect(text(toastEl())).not.toContain('gold ➤');
  });

  test('the coin tip waits for a coin collected after the welcome card', () => {
    const coin = method('main-simple.ts', 'this.scene.setOnCoinCollected(');
    expect(coin).toContain(
      'const welcomePending = !this.introSettled || this.ui.isWelcomeVisible();',
    );
    expect(coin).toMatch(/if \(!welcomePending && !localStorage\.getItem\('ds_hint_earn'\)\)/);
    expect(stripped('main-simple.ts')).toContain('this.introSettled = true;');
  });
});

describe('the tour frames what its captions say', () => {
  test('the Day badge is ambient HUD, so the tour (Skip sits there) clears it', () => {
    ui.setEnvironmentBadge('☀️ Day');
    const badge = [...document.querySelectorAll<HTMLElement>('#ui-overlay > div')].find(
      (d) => d.title === 'Live weather settings',
    )!;
    ui.showTourOverlay(() => {});
    // desktop policy dims a cleared layer, touch hides it...
    expect(badge.style.opacity === '0.35' || badge.style.display === 'none').toBe(true);
    // ...and a dimmed badge still showed through under Skip, so the tour
    // hides it outright
    expect(badge.style.visibility).toBe('hidden');
    ui.hideTourOverlay();
    expect(badge.style.opacity).toBe('');
    expect(badge.style.display).toBe('');
    expect(badge.style.visibility).toBe('');
  });

  test('a badge created mid-tour is born hidden', () => {
    ui.showTourOverlay(() => {});
    ui.setEnvironmentBadge('☀️ Day');
    const badge = [...document.querySelectorAll<HTMLElement>('#ui-overlay > div')].find(
      (d) => d.title === 'Live weather settings',
    )!;
    expect(badge.style.visibility).toBe('hidden');
    ui.hideTourOverlay();
    expect(badge.style.visibility).toBe('');
  });

  test('captions swap on landing, not at take-off', () => {
    expect(method('main-simple.ts', 'private advanceTourStop')).not.toContain('setTourCaption');
    const land = method('main-simple.ts', 'private landTourStop');
    expect(land).toContain("tour.phase = 'dwell'");
    expect(land).toContain('this.ui.setTourCaption(tour.stops[tour.idx].caption)');
    // both fly branches (reduced motion and the flight) land through it
    const upd = method('main-simple.ts', 'private updateTour');
    expect(upd.split('this.landTourStop()').length - 1).toBe(2);
  });

  test('a villager stop is re-read and held when its leg starts, released after', () => {
    const hold = method('main-simple.ts', 'private holdTourVillager');
    expect(hold).toContain('this.tourVillager(stop.villagers)');
    expect(hold).toContain('this.scene.getNpcPosition(who)');
    expect(hold).toContain('this.frameTourStop(stop, p, this.clearTourBearing(stop, p))');
    expect(hold).toContain('this.scene.setNpcDialogueHold(who)');
    // the camera bearing is chosen for a clear line of sight to the villager
    const bearing = method('main-simple.ts', 'private clearTourBearing');
    expect(bearing).toContain('collisionMeshes');
    expect(bearing).toContain('intersectObjects(blockers, false)');
    const adv = method('main-simple.ts', 'private advanceTourStop');
    expect(adv.indexOf('this.releaseTourVillager()')).toBeGreaterThan(-1);
    expect(adv.indexOf('this.releaseTourVillager()')).toBeLessThan(adv.indexOf('tour.idx += 1'));
    expect(adv).toContain('this.holdTourVillager(tour.stops[tour.idx])');
    expect(method('main-simple.ts', 'private endTour')).toContain('this.releaseTourVillager()');
    // asleep villagers are hidden indoors: only frame one who is up
    expect(method('main-simple.ts', 'private tourVillager')).toContain(
      "this.scene.getNpcActivity(n) !== 'sleep'",
    );
  });
});

describe('the fly-in hides the ink through the material', () => {
  const boxGroup = (n: number): THREE.Group => {
    const g = new THREE.Group();
    for (let i = 0; i < n; i++) {
      const m = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial());
      m.position.set(i * 2, 0, 0);
      g.add(m);
    }
    return g;
  };
  const hullsOf = (root: THREE.Object3D): THREE.Mesh[] => {
    const out: THREE.Mesh[] = [];
    root.traverse((o) => {
      if (o.userData.isCelHull) out.push(o as THREE.Mesh);
    });
    return out;
  };

  test('setInkVisible flips the shared material and never Object3D.visible', () => {
    const g = boxGroup(3);
    addGroupHulls(g);
    const hulls = hullsOf(g);
    expect(hulls.length).toBe(3);
    try {
      setInkVisible(false);
      for (const h of hulls) {
        expect((h.material as THREE.Material).visible).toBe(false);
        expect(h.visible).toBe(true); // game state is untouched
      }
      const late = boxGroup(1); // a hull baked mid-intro joins the hidden state
      addGroupHulls(late);
      expect((hullsOf(late)[0].material as THREE.Material).visible).toBe(false);
    } finally {
      setInkVisible(true);
    }
    for (const h of hulls) expect((h.material as THREE.Material).visible).toBe(true);
  });

  test('main-simple hides it in the intro-lite block and restores it mid-swoop', () => {
    const m = stripped('main-simple.ts');
    const hide = m.indexOf('setInkVisible(false)');
    const restore = m.indexOf('const restoreIntroQuality');
    expect(hide).toBeGreaterThan(m.indexOf('this.renderer.setShadowFreeze(true)'));
    expect(hide).toBeLessThan(restore);
    expect(m.slice(restore, restore + 300)).toContain('setInkVisible(true)');
  });

  test('the 1.5 s restore clock starts at the first frame, not before warmUp', () => {
    // warmUp compiles every program synchronously (measured 2.3 s), so a clock
    // started in the intro block ran out before the swoop's first frame and
    // the intro-lite levers (ink included) never engaged.
    const m = stripped('main-simple.ts');
    expect(m).toContain(
      'requestAnimationFrame(() => window.setTimeout(restoreIntroQuality, 1500))',
    );
    expect(m.split('window.setTimeout(restoreIntroQuality, 1500)').length - 1).toBe(1);
  });

  test('the dead cel shadow patch and its load warning are gone', () => {
    // (its name survives in a CelLook comment, for anyone searching history)
    expect(stripped('CelLook.ts')).not.toContain('applyCelShadowPatch');
    expect(stripped('CelLook.ts')).not.toContain('console.warn');
    expect(stripped('main-simple.ts')).not.toContain('applyCelShadowPatch');
  });
});

describe('Firebase Auth without the popup resolver', () => {
  test('initializeAuth with getAuth’s persistences and no resolver', () => {
    const f = stripped('firebaseClient.ts');
    expect(f).not.toContain('getAuth');
    expect(f).not.toContain('popupRedirectResolver');
    expect(f).toContain('initializeAuth(app, {');
    expect(f).toMatch(
      /persistence: \[indexedDBLocalPersistence, browserLocalPersistence, browserSessionPersistence\]/,
    );
    expect(f).toContain('signInAnonymously(anonymousAuth(app))');
    // the retry contract and App Check stay as they were
    expect(f).toContain('ready = ready.catch(');
    expect(f).toMatch(/ready = null;\s*throw e;/);
    expect(f).toContain('await maybeInitAppCheck(app);');
  });
});

describe('analytics: owner opt-out and entry attribution', () => {
  test('key events carry src and campaign only in the room Vercel Pro keeps (2 props)', () => {
    sessionStorage.setItem(
      'ds_entry',
      JSON.stringify({
        ref: 'https://www.linkedin.com/feed/',
        utm: { utm_source: 'LinkedIn', utm_campaign: 'cv-2026' },
        t: 1,
      }),
    );
    track('contact_opened'); // no props of its own: src and campaign
    track('welcome_cta', { cta: 'hire' }); // one of its own: src only
    track('zone_explored', { zone: 'hire', source: 'cta' }); // two: left as it is
    track('world_ready', { touch: false, ms: 1, genMs: 1 }); // already over: left as it is
    track('npc_chat_sent', { npc: 'Gardener' }); // not a key event
    const [contact, cta, zone, ready, chat] = window.__analyticsLog!;
    expect(contact.props).toEqual({ src: 'linkedin', campaign: 'cv-2026' });
    expect(cta.props).toEqual({ cta: 'hire', src: 'linkedin' });
    expect(zone.props).toEqual({ zone: 'hire', source: 'cta' });
    expect(ready.props).toEqual({ touch: false, ms: 1, genMs: 1 });
    expect(chat.props).toEqual({ npc: 'Gardener' });
    for (const e of [contact, cta, zone]) {
      expect(Object.keys(e.props!).length, e.name).toBeLessThanOrEqual(2);
    }
  });

  test('untagged: the referring host, a /z/ share bounce, another island page, or direct', () => {
    const from = (ref: string) => {
      sessionStorage.setItem('ds_entry', JSON.stringify({ ref, utm: {}, t: 1 }));
      return entryAttribution();
    };
    expect(from('https://www.google.com/')).toEqual({ src: 'google.com' });
    expect(from(`${location.origin}/z/hire`)).toEqual({ src: 'z-link' });
    expect(from(`${location.origin}/hire.html`)).toEqual({ src: 'internal' });
    expect(from('')).toEqual({ src: 'direct' });
  });

  test('a prop-less key event carries src alone when the link was untagged', () => {
    sessionStorage.setItem('ds_entry', JSON.stringify({ ref: '', utm: {}, t: 1 }));
    track('lead_submitted');
    expect(window.__analyticsLog).toEqual([{ name: 'lead_submitted', props: { src: 'direct' } }]);
    // trackOnce dedupes on the caller's props, before attribution is added
    trackOnce('lead_submitted_once_probe', { a: 1 });
    trackOnce('lead_submitted_once_probe', { a: 1 });
    expect(window.__analyticsLog).toHaveLength(2);
  });

  test('the owner flag silences every event', () => {
    localStorage.setItem('ds_owner', '1');
    expect(isOwnerVisit()).toBe(true);
    track('world_ready', { touch: false });
    track('lead_submitted');
    expect(window.__analyticsLog).toEqual([]);
  });

  test('?owner=1 marks this browser, ?owner=0 clears it', async () => {
    try {
      vi.resetModules();
      history.replaceState(null, '', '/?owner=1');
      expect((await import('../Analytics')).isOwnerVisit()).toBe(true);
      expect(localStorage.getItem('ds_owner')).toBe('1');
      vi.resetModules();
      history.replaceState(null, '', '/?owner=0');
      expect((await import('../Analytics')).isOwnerVisit()).toBe(false);
      expect(localStorage.getItem('ds_owner')).toBeNull();
    } finally {
      history.replaceState(null, '', '/');
    }
  });

  test('pageviews obey it too (inject beforeSend)', () => {
    expect(stripped('main-simple.ts')).toContain(
      'beforeSend: (event) => (isOwnerVisit() ? null : event)',
    );
  });

  test('the stale "Web Analytics is disabled" note is gone', () => {
    expect(src('SimpleUI.ts')).not.toContain('turned out to be DISABLED');
  });
});

describe('the NPC chat admits offline replies', () => {
  test('a canned reply re-labels the live-AI badge for that chat only', () => {
    ui.showNpcChat('Gardener', 'Morning!', async () => 'A written line.');
    const badge = [...document.querySelectorAll('span')].find((s) => text(s) === '✨ live AI')!;
    ui.markNpcChatOffline('Guard'); // a different villager: no-op
    expect(text(badge)).toBe('✨ live AI');
    ui.markNpcChatOffline('Gardener');
    expect(text(badge)).toBe('offline replies');
    expect(badge.title).toContain('written lines');
  });

  test('main-simple marks it on the canned branch of the AI chat', () => {
    const m = stripped('main-simple.ts');
    const i = m.indexOf('const res = await askNpc(npcData.name, text);');
    expect(i).toBeGreaterThan(-1);
    const branch = m.slice(i, i + 400);
    expect(branch.indexOf('this.ui.markNpcChatOffline(npcData.name)')).toBeLessThan(
      branch.indexOf('canned[ci++'),
    );
  });
});

describe('accessibility quick wins', () => {
  test('the welcome title is the page’s h1, on both cards', () => {
    ui.showWelcome(null);
    expect(text(document.querySelector('[role="dialog"] h1'))).toBe('DigiScalability Life Island');
    ui.hideWelcome(false);
    localStorage.setItem('ds_welcomed', '1');
    ui.showWelcome(null);
    expect(text(document.querySelector('[role="dialog"] h1'))).toBe('👋 Welcome back!');
  });

  test('lead-form fields are labelled, autocomplete, and in the page font', () => {
    ui.showZonePanel({ id: 'contact', name: 'contact' }, { source: 'menu' });
    const name = document.querySelector('#lead-name')!;
    const email = document.querySelector('#lead-email')!;
    const msg = document.querySelector('#lead-msg')!;
    expect(name.getAttribute('aria-label')).toBe('Your name (optional)');
    expect(name.getAttribute('autocomplete')).toBe('name');
    expect(email.getAttribute('aria-label')).toBe('Your email');
    expect(email.getAttribute('autocomplete')).toBe('email');
    expect(msg.getAttribute('aria-label')).toBe('Your message');
    expect(msg.getAttribute('style')).toContain('font-family:inherit');
  });

  test('the canvas is named, and HUD chips skip the double-tap delay', () => {
    const m = stripped('main-simple.ts');
    expect(m).toContain("canvas.setAttribute('role', 'img')");
    expect(m).toMatch(/canvas\.setAttribute\(\s*'aria-label',/);
    const css = src('style.css');
    const rule = css.slice(css.indexOf('.hud-btn {'), css.indexOf('}', css.indexOf('.hud-btn {')));
    expect(rule).toContain('touch-action: manipulation');
  });

  test('the receptionist says the call streams live audio to ElevenLabs', () => {
    const box = document.createElement('div');
    appendReceptionDesk(box);
    expect(text(box)).toContain('your voice streams live to ElevenLabs');
  });
});
