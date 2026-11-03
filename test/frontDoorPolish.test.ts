// @vitest-environment happy-dom
//
// The 2026-11-02 pass, step i2b: the front door's runtime polish.
// DOM tests on a REAL SimpleUI where behaviour can run (loader exit, toast
// hints, compass hint, Day badge, offline replies tag, form labels), unit
// tests for analytics attribution and the owner opt-out, and a source lock
// where the code only runs inside the WebGL boot (Firebase Auth). The boot's
// main-simple.ts locks (error screen, coin tip, tour framing, fly-in ink
// timing, beforeSend, the canvas label) moved to package A's
// test/mainLocks.test.ts, and the two CelLook.ts locks (the ink hides through
// the shared material; the dead cel shadow patch stays gone) to package C's
// test/worldLook.test.ts (testOwnership rule 1).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { entryAttribution, isOwnerVisit, track, trackOnce } from '../Analytics';
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
/** The centred flash (z 2000 at 38%; the door fade is z 2000 too, full-screen). */
const flashEl = (): HTMLElement | undefined =>
  [...document.querySelectorAll<HTMLElement>('#ui-overlay > div')].find(
    (d) => d.style.zIndex === '2000' && d.style.top === '38%',
  );
const zonePanelEl = (): HTMLElement | undefined =>
  [...document.querySelectorAll<HTMLElement>('#ui-overlay > div')].find(
    (d) => d.style.zIndex === '1650' && !!d.querySelector('[data-email], h2'),
  );
const liveText = (): string =>
  text(document.querySelector('#ui-overlay > .ds-sr-only[role="status"]'));

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
    // (that showErrorScreen calls it before it rewrites the card, and flags
    // itself for the boot guard, is main-simple.ts code: package A's mainLocks)
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
  // D6 / P2-D3, changed deliberately: nothing paints over an open MODAL any
  // more. The modal's own outcome (here a share's 'Link copied' after a press
  // inside it) shows INSIDE the panel; the lead form's 'Please add your
  // email.' that this test used to toast is an inline field error now (see
  // 'messages: forms say it inline' below).
  test("a hint waits out an open panel; the panel's own outcome shows inside it", async () => {
    vi.useFakeTimers();
    ui.showZonePanel({ id: 'contact', name: 'contact' }, { source: 'menu' });
    ui.toast('🧭 hint line', { hint: true });
    const panel = zonePanelEl()!;
    panel.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })); // the visitor acts in it
    ui.toast('🔗 Link copied — paste it anywhere!');
    await Promise.resolve(); // the note lands a microtask later (the shop re-renders first)
    const note = panel.querySelector<HTMLElement>('[data-panel-note]');
    expect(text(note)).toBe('🔗 Link copied — paste it anywhere!');
    expect(note!.getAttribute('role')).toBe('status');
    expect(toastEl()?.style.opacity ?? '0').toBe('0'); // nothing over the panel
    vi.advanceTimersByTime(2300 + 2100); // the note's dwell + a few polls
    expect(panel.querySelector('[data-panel-note]')).toBeNull();
    expect(toastEl()).toBeUndefined(); // the hint never showed
    ui.hideZonePanel();
    vi.advanceTimersByTime(800);
    expect(text(toastEl())).toBe('🧭 hint line');
    expect(toastEl()!.style.opacity).toBe('1');
  });

  test('a message from outside the modal waits for it to close, outcome or not', () => {
    vi.useFakeTimers();
    ui.showHireCard('cta');
    ui.toast('🐟 Caught one! (1 in the basket)');
    ui.flashMessage('🔍 Secret found: The Town Hall Steps!');
    vi.advanceTimersByTime(5000);
    expect(toastEl()).toBeUndefined();
    expect(flashEl()).toBeUndefined();
    ui.hideZonePanel();
    vi.advanceTimersByTime(800);
    expect(text(toastEl())).toBe('🐟 Caught one! (1 in the basket)');
    expect(flashEl()).toBeUndefined(); // one at a time: the flash is next
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

  // Changed deliberately (D6, P2-D3): a sheet leaves feedback be, as before,
  // but a modal sends any message aside, to come back once it closes.
  test('a feedback toast stays over a sheet; a modal sends it aside until it closes', () => {
    vi.useFakeTimers();
    ui.toast('Link copied');
    ui.showNpcChat('Gardener', 'Morning!', async () => 'Hello.'); // a sheet
    expect(text(toastEl())).toBe('Link copied');
    expect(toastEl()!.style.opacity).toBe('1');
    ui.closeNpcChat();
    ui.showHireCard('cta'); // a modal
    expect(toastEl()!.style.opacity).toBe('0');
    ui.hideZonePanel();
    vi.advanceTimersByTime(800);
    expect(text(toastEl())).toBe('Link copied');
    expect(toastEl()!.style.opacity).toBe('1');
  });

  // Changed deliberately (P2-D3, GP-08): an outcome no longer waits behind a
  // hint. The hint bows out to the head of the queue and returns after.
  test('an outcome takes a hint’s place at once, and the hint comes back after', () => {
    vi.useFakeTimers();
    ui.toast('first', { hint: true });
    ui.toast('second');
    expect(text(toastEl())).toBe('second'); // within 300 ms: here, at once
    expect(toastEl()!.style.opacity).toBe('1');
    vi.advanceTimersByTime(2000 + 300); // second's 2 s dwell and the gap
    expect(text(toastEl())).toBe('first');
    expect(toastEl()!.style.opacity).toBe('1');
  });

  test('until() drops a queued hint, and takes one already on screen down', () => {
    vi.useFakeTimers();
    let chatted = false;
    ui.showZonePanel({ id: 'projects', name: 'projects' }, { source: 'menu' });
    ui.toast('💬 A villager nearby talks — walk up and press E', {
      hint: true,
      until: () => chatted,
    });
    chatted = true; // the visitor talked while the panel was up
    ui.hideZonePanel();
    vi.advanceTimersByTime(3000);
    expect(toastEl()).toBeUndefined(); // stale: dropped, never shown
    let mapped = false;
    ui.toast('🧭 compass hint', { hint: true, until: () => mapped });
    expect(toastEl()!.style.opacity).toBe('1');
    mapped = true;
    vi.advanceTimersByTime(150); // the on-screen watch
    expect(toastEl()!.style.opacity).toBe('0');
    vi.advanceTimersByTime(5000);
    expect(toastEl()!.style.opacity).toBe('0'); // and it never comes back
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
});

// D6: one message at a time, announced, never before the card or over the
// guide; forms say their errors inline; the guide's anchors.
describe('messages: one at a time', () => {
  test('a flash joins the queue: never on screen with a toast, and 300 ms after its fade', () => {
    vi.useFakeTimers();
    ui.toast('Link copied');
    ui.flashMessage('🔍 Secret found: The Town Hall Steps!');
    expect(flashEl()).toBeUndefined(); // waits its turn
    vi.advanceTimersByTime(2000); // t 2000: the toast's 2 s dwell ends
    expect(toastEl()!.style.opacity).toBe('0');
    vi.advanceTimersByTime(300); // t 2300: the flash came up at 2250
    expect(text(flashEl())).toBe('🔍 Secret found: The Town Hall Steps!');
    expect(toastEl()!.style.opacity).toBe('0');
    ui.toast('🪙 +3');
    vi.advanceTimersByTime(1940); // t 4240: still inside the flash's 2 s
    expect(flashEl()!.style.opacity).toBe('1');
    expect(toastEl()!.style.opacity).toBe('0');
    vi.advanceTimersByTime(20); // t 4260: the flash fades...
    expect(flashEl()!.style.opacity).toBe('0');
    vi.advanceTimersByTime(250); // t 4510: ...and the toast waits out its 300 ms
    expect(toastEl()!.style.opacity).toBe('0');
    vi.advanceTimersByTime(60); // t 4570
    expect(text(toastEl())).toBe('🪙 +3');
    expect(toastEl()!.style.opacity).toBe('1');
  });

  test('a flash dwells 50 ms a character, 2-6 s (it was a flat 1.8 s)', () => {
    vi.useFakeTimers();
    const line = '🏝️ You’ve got the hang of it — follow the ➤ arrow to 🚀 Projects.'; // 66 chars
    ui.flashMessage(line);
    vi.advanceTimersByTime(line.length * 50 - 50);
    expect(flashEl()!.style.opacity).toBe('1');
    vi.advanceTimersByTime(100);
    expect(flashEl()!.style.opacity).toBe('0');
  });

  test('hints wait while First steps is active, by its card or its event', () => {
    vi.useFakeTimers();
    window.dispatchEvent(new CustomEvent('ds:guide', { detail: { active: true, step: 'move' } }));
    ui.toast('🪙 Coins! The 📔 Journal lists every way to earn.', { hint: true });
    ui.toast('🧭 Compass set: 🏦 Bank');
    expect(text(toastEl())).toBe('🧭 Compass set: 🏦 Bank'); // outcomes still show
    vi.advanceTimersByTime(6000);
    expect(toastEl()!.style.opacity).toBe('0'); // the hint waited
    const card = document.createElement('div');
    card.id = 'ds-guide';
    card.dataset.active = '0'; // the card itself wins over the last event
    document.body.appendChild(card);
    vi.advanceTimersByTime(800);
    expect(text(toastEl())).toBe('🪙 Coins! The 📔 Journal lists every way to earn.');
    card.remove();
  });

  test('the first-run compass hint stands down once First steps arms', () => {
    vi.useFakeTimers();
    ui.showWelcome(null);
    document.querySelector<HTMLButtonElement>('button[data-dismiss]')!.click();
    // A6 arms on Explore and fires its own compass hint on Skip.
    window.dispatchEvent(new CustomEvent('ds:guide', { detail: { active: true, step: 'move' } }));
    vi.advanceTimersByTime(2000);
    window.dispatchEvent(new CustomEvent('ds:guide', { detail: { active: false } }));
    vi.advanceTimersByTime(5000);
    expect(text(toastEl())).not.toContain('gold ➤');
    expect(localStorage.getItem('ds_hint_compass')).toBe('1'); // both writers share the key
  });

  test('no toast before the fly-in settles (ds:intro), nor before the card', () => {
    vi.useFakeTimers();
    ui.showLoading(10);
    window.dispatchEvent(new CustomEvent('ds:intro', { detail: { phase: 'start' } }));
    ui.hideLoading();
    ui.toast('⭐ The bank is paying extra today.');
    vi.advanceTimersByTime(8000); // a long fly-in
    expect(toastEl()).toBeUndefined();
    window.dispatchEvent(new CustomEvent('ds:intro', { detail: { phase: 'settled' } }));
    ui.showWelcome(null); // afterIntro: settled, then the card in the same task
    vi.advanceTimersByTime(3000);
    expect(toastEl()).toBeUndefined();
    document.querySelector<HTMLButtonElement>('button[data-dismiss]')!.click();
    vi.advanceTimersByTime(800);
    expect(text(toastEl())).toBe('⭐ The bank is paying extra today.');
  });

  test('with no ds:intro, toasts wait 3.5 s after the loader hides', () => {
    vi.useFakeTimers();
    ui.showLoading(10);
    ui.hideLoading();
    ui.toast('⭐ The bank is paying extra today.');
    vi.advanceTimersByTime(3000);
    expect(toastEl()).toBeUndefined();
    vi.advanceTimersByTime(1300);
    expect(text(toastEl())).toBe('⭐ The bank is paying extra today.');
  });
});

describe('messages: announced, once', () => {
  test('the live region mirrors the toast, the flash and the bulletin', () => {
    vi.useFakeTimers();
    ui.toast('🔇 Muted Traveller');
    expect(liveText()).toBe('🔇 Muted Traveller');
    vi.advanceTimersByTime(2300);
    ui.flashMessage('🌊 The current pulls you back to shore');
    vi.advanceTimersByTime(400);
    expect(liveText()).toBe('🌊 The current pulls you back to shore');
    ui.showWorldBulletin('Fresh records on the circuits', '#ffd479');
    expect(liveText()).toBe('The island today: Fresh records on the circuits');
    const live = document.querySelector('#ui-overlay > .ds-sr-only')!;
    expect(live.getAttribute('aria-live')).toBe('polite');
    expect(live.hasAttribute('data-never-inert')).toBe(true);
  });

  test('the prompt is read once, 600 ms after it settles, never per frame', () => {
    vi.useFakeTimers();
    const writes: string[] = [];
    for (let f = 0; f < 30; f++)
      ui.showInteractionPrompt('🚪 Press <strong>E</strong> to enter Projects');
    const live = document.querySelector('#ui-overlay > .ds-sr-only');
    expect(live).toBeNull(); // nothing yet: debounced
    vi.advanceTimersByTime(650);
    const el = document.querySelector('#ui-overlay > .ds-sr-only')!;
    writes.push(text(el));
    new MutationObserver(() => writes.push(text(el))).observe(el, {
      childList: true,
      characterData: true,
      subtree: true,
    });
    for (let f = 0; f < 30; f++)
      ui.showInteractionPrompt('🚪 Press <strong>E</strong> to enter Projects');
    vi.advanceTimersByTime(2000);
    expect(writes).toEqual(['🚪 Press E to enter Projects']);
    const prompt = document.querySelector<HTMLElement>('[data-hud="prompt"]')!;
    expect(prompt.style.width).toBe('max-content');
    expect(prompt.style.maxWidth).toBe('min(440px, calc(100vw - 32px))');
  });

  test('a compass target change is read once, by its label', () => {
    for (let f = 0; f < 10; f++) {
      ui.updateQuestCompass({ angleRad: 0.1 * f, distance: 103 - f, label: '🚀 Projects' });
    }
    expect(liveText()).toBe('Compass: 🚀 Projects');
    ui.updateQuestCompass({ angleRad: 0, distance: 80, label: '💼 Professional' });
    expect(liveText()).toBe('Compass: 💼 Professional');
  });

  test('the NPC log is a log, the dialogue and the tour caption say their lines', () => {
    ui.showNpcChat('Gardener', 'Morning!', async () => 'Hello.');
    const log = document.querySelector('[role="log"]')!;
    expect(log.getAttribute('aria-live')).toBe('polite');
    expect(text(log.querySelector('.ds-sr-only'))).toBe('Gardener: Morning!');
    ui.closeNpcChat();
    ui.showDialogue('Mayor', ['Welcome to the island.', 'Enjoy it.']);
    expect(text(document.querySelector('#dialogue-sr'))).toBe('Welcome to the island.');
    expect(document.querySelector('#dialogue-sr')!.getAttribute('role')).toBe('status');
    expect(document.querySelector('#dialogue-text')!.getAttribute('aria-hidden')).toBe('true');
    ui.hideDialogue();
    ui.showTourOverlay(() => {});
    expect(
      [...document.querySelectorAll<HTMLElement>('#ui-overlay > div')].some(
        (d) => d.getAttribute('role') === 'status' && d.style.zIndex === '1900',
      ),
    ).toBe(true);
    ui.hideTourOverlay();
  });
});

describe('messages: the lanes', () => {
  test('desktop: the toast takes the lane under the compass, and yields it to a bulletin', () => {
    // (happy-dom drops calc(var()) offsets, so the lane is read from its
    // marker; the browser probe measures the rectangles.)
    vi.useFakeTimers();
    ui.toast('🪙 +3');
    expect(toastEl()!.dataset.lane).toBe('top');
    ui.showWorldBulletin('A steady day on the island.', '#7cc47f');
    expect(toastEl()!.dataset.lane).toBe('bottom');
    vi.advanceTimersByTime(7100); // the bulletin goes
    ui.toast('🪙 +4');
    vi.advanceTimersByTime(300);
    expect(toastEl()!.dataset.lane).toBe('top');
    expect(toastEl()!.style.zIndex).toBe('1750');
  });

  test('the 7 First-steps anchors, on desktop and on a phone', () => {
    ui.updateCoinCounter(3);
    ui.updateQuestCompass({ angleRad: 0, distance: 103, label: '🚀 Projects' });
    const anchors = (): string[] =>
      [...document.querySelectorAll<HTMLElement>('[data-guide]')]
        .map((e) => e.dataset.guide!)
        .sort();
    expect(anchors()).toEqual(['coin-chip', 'compass', 'portfolio-chip']);
    history.replaceState(null, '', '/?touch=1');
    try {
      document.body.innerHTML = '<div id="ui-overlay"></div>';
      ui = new SimpleUI('ui-overlay');
      ui.updateCoinCounter(3);
      ui.updateQuestCompass({ angleRad: 0, distance: 103, label: '🚀 Projects' });
      expect(anchors()).toEqual(
        [
          'coin-chip',
          'compass',
          'drawer-portfolio',
          'drawer-toggle',
          'joystick',
          'use-button',
        ].sort(),
      );
    } finally {
      history.replaceState(null, '', '/');
    }
  });
});

describe('messages: forms say it inline', () => {
  test('an empty Send: an inline alert, aria-invalid, focus on the field, no toast', () => {
    vi.useFakeTimers();
    ui.showZonePanel({ id: 'contact', name: 'contact' }, { source: 'menu' });
    document.querySelector<HTMLButtonElement>('#lead-send')!.click();
    const err = document.querySelector<HTMLElement>('#lead-error')!;
    const email = document.querySelector<HTMLInputElement>('#lead-email')!;
    expect(err.getAttribute('role')).toBe('alert');
    expect(err.hidden).toBe(false);
    expect(text(err)).toBe('Please add your email.');
    expect(email.getAttribute('aria-invalid')).toBe('true');
    expect(email.getAttribute('aria-describedby')).toBe('lead-error');
    expect(document.activeElement).toBe(email);
    vi.advanceTimersByTime(3000);
    expect(toastEl()).toBeUndefined();
    email.value = 'a@b.co';
    email.dispatchEvent(new Event('input'));
    expect(err.hidden).toBe(true);
    expect(email.hasAttribute('aria-invalid')).toBe(false);
  });

  test('Say hi says it inline too', () => {
    ui.showSayHi();
    document.querySelector<HTMLButtonElement>('#sh-send')!.click();
    const err = document.querySelector<HTMLElement>('#sh-error')!;
    expect(text(err)).toBe('Write a little something first!');
    expect(document.querySelector('#sh-msg')!.getAttribute('aria-invalid')).toBe('true');
    expect(document.activeElement).toBe(document.querySelector('#sh-msg'));
  });

  test('Guestbook Sign stays disabled until there is text', () => {
    const shown = ui.showGuestbook(); // its board read is async; the form is not
    const input = document.querySelector<HTMLInputElement>('#gb-msg')!;
    const sign = document.querySelector<HTMLButtonElement>('#gb-sign')!;
    expect(sign.disabled).toBe(true);
    input.value = '  ';
    input.dispatchEvent(new Event('input'));
    expect(sign.disabled).toBe(true);
    input.value = 'Hi Abbas!';
    input.dispatchEvent(new Event('input'));
    expect(sign.disabled).toBe(false);
    void shown.catch(() => {}); // the stubbed board read may settle either way
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
  // (the caption-on-landing and villager-hold locks are main-simple.ts code:
  // package A's mainLocks)
});

// (The fly-in's ink, hidden through the shared material, and the dead cel
// shadow patch are CelLook.ts code: package C's test/worldLook.test.ts. Where
// main-simple hides the ink and when it restores it is package A's mainLocks.)

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

  // (pageviews obey it through main-simple's inject beforeSend: package A's
  // mainLocks)

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
  // (that main-simple marks it on the canned branch is package A's mainLocks)
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

  test('HUD chips skip the double-tap delay', () => {
    // (that main-simple names the canvas is package A's mainLocks)
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

// Stage 1 (A3, A4) made looking a press-and-drag with the left or right mouse
// button, a swipe on touch, and J/L on the keyboard; pointer lock is opt-in.
// "mouse to look" taught a click and a move, which now turns nothing. (D9
// later drops the card's controls line, and these card checks with it.)
describe('the controls copy teaches the stage-1 look', () => {
  const lookLine = (root: Element | null | undefined): string =>
    text([...(root?.querySelectorAll('p') ?? [])].find((p) => text(p).includes('to move')));
  const cardLine = (): string => {
    ui.showWelcome(null);
    return lookLine(document.querySelector('[role="dialog"]'));
  };
  const hubLine = (): string => {
    ui.hideWelcome(false);
    ui.showZonePanel({ id: 'welcome', name: 'welcome' }, { source: 'menu' });
    const hub = [...document.querySelectorAll('#ui-overlay > div')].find((d) =>
      text(d.querySelector('h2')).includes('Welcome to Life Island'),
    );
    expect(hub, 'no Welcome Hub panel').toBeTruthy();
    return lookLine(hub);
  };

  test('desktop: drag or J/L to look, on the card and in the Welcome Hub', () => {
    expect(ui.isTouchDevice()).toBe(false);
    const card = cardLine();
    const hub = hubLine();
    expect(card).toBe('WASD to move · drag or J/L to look · space to jump · Q to wave.');
    expect(hub).toContain('WASD to move, drag or J/L to look, E to interact.');
    for (const line of [card, hub]) expect(line).not.toMatch(/mouse/i);
  });

  test('touch: swipe to look in the Hub, and neither surface names a mouse or a key', () => {
    history.replaceState(null, '', '/?touch=1'); // ?touch selects the phone scheme
    try {
      document.body.innerHTML = '<div id="ui-overlay"></div>';
      ui = new SimpleUI('ui-overlay');
      expect(ui.isTouchDevice()).toBe(true);
      const card = cardLine();
      const hub = hubLine();
      expect(card).toContain('Drag the joystick to move');
      expect(hub).toContain('Drag the joystick to move, swipe to look, 👆 USE to interact.');
      for (const line of [card, hub]) {
        expect(line).not.toMatch(/mouse|J\/L|WASD|drag to look/i);
      }
    } finally {
      history.replaceState(null, '', '/');
    }
  });

  test('the README table says the same: a drag with either button, J/L, a swipe', () => {
    const readme = src('README.md');
    const controls = readme.slice(readme.indexOf('## Controls'), readme.indexOf('## How it is'));
    expect(controls).toContain('| Mouse drag (left or right button) | Look |');
    expect(controls).toContain('| J / L | Turn the view (I / K tilt it, R recentres it) |');
    expect(controls).toContain('On a phone: a joystick to move, swipe to look,');
  });

  test('no surface still teaches the click-to-lock look', () => {
    for (const f of [
      'SimpleUI.ts',
      'README.md',
      'index.html',
      'public/hire.html',
      'public/404.html',
    ]) {
      expect(src(f), f).not.toMatch(/mouse to look|lock the pointer|click the world/i);
    }
  });
});
