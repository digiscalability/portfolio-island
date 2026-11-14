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
import { Passport } from '../Passport';
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

  // Wave-1 integration: a flash that arrived just as a toast's dwell ended
  // showed at once, over the toast's 0.2 s fade (two elements, both on screen
  // for one sample): the 'Next:' flash on leaving a hall, 2.0 s after the
  // passport toast, at 390x844 and 667x375.
  test('a message that arrives while a toast fades waits out the 200 ms fade', () => {
    vi.useFakeTimers();
    const next = 'Next: 💼 Professional — the gold arrow points the way.';
    ui.toast('🛂 Passport stamped: Projects (1/4)');
    vi.advanceTimersByTime(2030); // its 2 s dwell ended 30 ms ago: it is fading
    expect(toastEl()!.style.opacity).toBe('0');
    ui.flashMessage(next);
    vi.advanceTimersByTime(150); // 180 ms into the fade
    expect(flashEl()).toBeUndefined();
    vi.advanceTimersByTime(30); // the fade is over
    expect(text(flashEl())).toBe(next);
  });

  test('a hint taken down for an outcome has no fade: the flash shows at once', () => {
    vi.useFakeTimers();
    const next = 'Next: 💼 Professional — the gold arrow points the way.';
    ui.toast('🛂 Passport stamped: Projects (1/4)', { hint: true });
    vi.advanceTimersByTime(1000);
    ui.flashMessage(next);
    expect(toastEl()!.style.opacity).toBe('0');
    expect(text(flashEl())).toBe(next);
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

  // Round 3 play: on a 390x844 phone the first coin's pop (B9: up 1.75 u
  // over the head, gone by 450 ms, sparkles by 500) landed at y 615-770,
  // and the coin tip it triggers sat over its lower half. The pickup's
  // ds:coin comes first, in the same task; the message waits out the pop.
  test('a message waits out the coin pop that set it off', () => {
    vi.useFakeTimers();
    window.dispatchEvent(new CustomEvent('ds:coin', { detail: { x: 195, y: 690, value: 1 } }));
    ui.toast('🪙 Coins! The 📔 Journal lists every way to earn.', { hint: true });
    expect(toastEl()?.style.opacity ?? '0').toBe('0'); // the pop is on screen
    vi.advanceTimersByTime(500);
    expect(toastEl()?.style.opacity ?? '0').toBe('0'); // sparkles still falling
    vi.advanceTimersByTime(200);
    expect(text(toastEl())).toBe('🪙 Coins! The 📔 Journal lists every way to earn.');
    expect(toastEl()!.style.opacity).toBe('1');
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

  // The queue re-polls on timers, and they outlived the UI: a pump left by a
  // hint queued behind a panel fired after a test file's environment was torn
  // down ('document is not defined' failed the run).
  test('dispose() ends the queue: nothing shows, polls or re-arms after it', () => {
    vi.useFakeTimers();
    ui.showHireCard('cta'); // a modal: the hint and the flash wait, polling
    ui.toast('🧭 Follow the gold ➤ arrow.', { hint: true });
    ui.flashMessage('🔍 Secret found: The Town Hall Steps!');
    vi.advanceTimersByTime(1000);
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    ui.dispose();
    const made = vi.spyOn(document, 'createElement');
    ui.toast('A late callback, after the page went');
    ui.flashMessage('🏁 Finish!');
    vi.advanceTimersByTime(30_000);
    expect(made).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});

// Wave-1 integration: a message stepped aside came back with no limit, after
// the visitor had read it and even after they had moved ('🧭 You have
// arrived.' re-showed inside every hall; the compass hint showed four times in
// 26 s on a phone; a passing villager's prompt made 'Lost?' blink).
describe('messages: read once, shown twice at most', () => {
  test('a message read for 1 s (an outcome) or 1.5 s (a hint) drops when a modal takes it down', () => {
    vi.useFakeTimers();
    ui.toast('🧭 You have arrived.');
    vi.advanceTimersByTime(1100);
    ui.showHireCard('cta'); // e.g. the hall panel opening at the door
    expect(toastEl()!.style.opacity).toBe('0');
    ui.hideZonePanel();
    vi.advanceTimersByTime(3000);
    expect(toastEl()!.style.opacity).toBe('0'); // read: it does not come back

    ui.toast('💬 A villager nearby talks — walk up and press E', { hint: true });
    vi.advanceTimersByTime(1400); // not yet read
    ui.showHireCard('cta');
    ui.hideZonePanel();
    vi.advanceTimersByTime(800);
    expect(text(toastEl())).toBe('💬 A villager nearby talks — walk up and press E');
    expect(toastEl()!.style.opacity).toBe('1');
    vi.advanceTimersByTime(200); // past 1.5 s on screen in all
    ui.toast('🪙 +3'); // an outcome takes its place...
    vi.advanceTimersByTime(2000 + 300 + 3000);
    expect(text(toastEl())).toBe('🪙 +3'); // ...and the read hint never returns
  });

  test('a message comes back once after a step aside, never a second time', () => {
    vi.useFakeTimers();
    ui.toast('🪙 coin hint', { hint: true });
    ui.showHireCard('cta');
    ui.hideZonePanel();
    vi.advanceTimersByTime(800);
    expect(text(toastEl())).toBe('🪙 coin hint'); // the one re-show
    expect(toastEl()!.style.opacity).toBe('1');
    ui.showHireCard('cta');
    ui.hideZonePanel();
    for (let t = 0; t < 6000; t += 200) {
      vi.advanceTimersByTime(200);
      expect(toastEl()!.style.opacity).toBe('0'); // no third show
    }
  });

  test('a shown message that changed place drops; one that never showed keeps its turn', () => {
    vi.useFakeTimers();
    ui.toast('🧭 You have arrived.'); // at the door
    vi.advanceTimersByTime(500);
    ui.showLeaveButton(() => {}); // in through it
    ui.showZonePanel({ id: 'projects', name: 'projects' }, { source: 'menu' });
    ui.hideZonePanel();
    for (let t = 0; t < 3000; t += 200) {
      vi.advanceTimersByTime(200);
      expect(toastEl()!.style.opacity).toBe('0'); // not inside the hall
    }
    ui.showZonePanel({ id: 'projects', name: 'projects' }, { source: 'menu' });
    ui.toast('🛂 Passport stamped: Projects (1/4)', { hint: true }); // waits out the panel
    ui.hideLeaveButton(); // the visitor walks out with the panel up
    ui.hideZonePanel();
    vi.advanceTimersByTime(800);
    expect(text(toastEl())).toBe('🛂 Passport stamped: Projects (1/4)');
    expect(toastEl()!.style.opacity).toBe('1');
  });

  test('until() drops an outcome too', () => {
    vi.useFakeTimers();
    let inside = false;
    ui.showHireCard('cta');
    ui.toast('🧭 You have arrived.', { until: () => inside });
    inside = true; // the visitor went in before the card closed
    ui.hideZonePanel();
    vi.advanceTimersByTime(3000);
    expect(toastEl()).toBeUndefined();
  });

  // Wave-1 re-verify: '🏝️ The Hub — the town square' showed 1.5 s at the hub,
  // stepped aside for the beach-house PIN pad, came back as the pad closed
  // and stayed up while the visitor went inside.
  describe('a place message stays where it was shown', () => {
    /** One minimap update: the radar distance to five fixed landmarks and the cruise liner. */
    const standAt = (d: number[], cruise = 0.5): void =>
      ui.updateMinimap({
        heading: 0,
        npcs: [],
        zones: [
          ...d.map((dist, i) => ({ rx: 0, ry: dist, dist, color: '#fff', label: `Z${i}` })),
          { rx: 0, ry: cruise, dist: cruise, color: '#f00', label: 'Cruise' },
        ],
        delivery: null,
      });
    const HUB = [0.05, 0.4, 0.45, 0.5, 0.6];
    const ISLET = [0.9, 0.7, 1.1, 0.8, 0.95];
    const HUB_LINE = '🏝️ The Hub — the town square. Every avenue starts here.';

    test('stepped aside at the hub, it does not come back at the islet', () => {
      vi.useFakeTimers();
      standAt(HUB);
      ui.toast(HUB_LINE, { hint: true });
      vi.advanceTimersByTime(1000); // on screen, not yet read
      expect(text(toastEl())).toBe(HUB_LINE);
      ui.showHireCard('cta'); // the PIN pad, a modal
      standAt(ISLET); // the visitor is at the beach-house door
      ui.hideZonePanel(); // the pad closes
      for (let t = 0; t < 4000; t += 200) {
        vi.advanceTimersByTime(200);
        expect(toastEl()!.style.opacity).toBe('0');
      }
    });

    test('stepped aside where the visitor still stands, it comes back once', () => {
      vi.useFakeTimers();
      standAt(HUB);
      ui.toast(HUB_LINE, { hint: true });
      vi.advanceTimersByTime(1000);
      ui.showHireCard('cta');
      standAt(
        HUB.map((d) => d + 0.03),
        0.9,
      ); // a step or two; the liner sails on
      ui.hideZonePanel();
      vi.advanceTimersByTime(800);
      expect(text(toastEl())).toBe(HUB_LINE);
      expect(toastEl()!.style.opacity).toBe('1');
    });

    test('on screen as the visitor goes through a door, it goes and stays gone', () => {
      vi.useFakeTimers();
      standAt(HUB);
      ui.toast(HUB_LINE, { hint: true });
      vi.advanceTimersByTime(500);
      ui.showLeaveButton(() => {}); // in, with no modal on the way
      vi.advanceTimersByTime(200);
      expect(toastEl()!.style.opacity).toBe('0');
      for (let t = 0; t < 4000; t += 200) {
        vi.advanceTimersByTime(200);
        expect(toastEl()!.style.opacity).toBe('0');
      }
    });

    test('walking on does not take a message on screen down', () => {
      vi.useFakeTimers();
      standAt(HUB);
      ui.toast(HUB_LINE, { hint: true });
      vi.advanceTimersByTime(500);
      standAt(ISLET); // far, at a run
      vi.advanceTimersByTime(1000);
      expect(text(toastEl())).toBe(HUB_LINE);
      expect(toastEl()!.style.opacity).toBe('1');
    });
  });

  test('a re-shown line is not read out again', () => {
    vi.useFakeTimers();
    ui.toast('💬 talk hint', { hint: true });
    expect(liveText()).toBe('💬 talk hint');
    // Every write to the live region, as it happens (a MutationObserver
    // reports a microtask later, after the expects).
    const live = document.querySelector('#ui-overlay > .ds-sr-only')!;
    const writes: string[] = [];
    const own = Object.getOwnPropertyDescriptor(Node.prototype, 'textContent')!;
    Object.defineProperty(live, 'textContent', {
      configurable: true,
      get(this: Node) {
        return own.get!.call(this);
      },
      set(this: Node, v: string) {
        writes.push(v);
        own.set!.call(this, v);
      },
    });
    ui.showHireCard('cta');
    ui.hideZonePanel();
    vi.advanceTimersByTime(800);
    expect(text(toastEl())).toBe('💬 talk hint'); // back on screen...
    expect(writes).toEqual([]); // ...silently: not cleared and set again
  });

  test('touch: a prompt coming and going no longer takes a shown hint down', () => {
    history.replaceState(null, '', '/?touch=1');
    try {
      document.body.innerHTML = '<div id="ui-overlay"></div>';
      ui = new SimpleUI('ui-overlay');
      vi.useFakeTimers();
      const lost =
        '🗺️ Lost? Tap the radar for the island map — pick a spot and the gold arrow leads.';
      ui.toast(lost, { hint: true });
      expect(toastEl()!.style.opacity).toBe('1');
      for (let i = 0; i < 4; i++) {
        ui.showInteractionPrompt('💬 Press <strong>E</strong> to talk to Mayor — ask anything');
        vi.advanceTimersByTime(250); // two poll ticks
        expect(toastEl()!.style.opacity).toBe('1');
        ui.hideInteractionPrompt();
        vi.advanceTimersByTime(250);
      }
      expect(text(toastEl())).toBe(lost);
      // A hint that has not shown yet still waits for the prompt to go.
      vi.advanceTimersByTime(4000); // lost's dwell ends
      ui.showInteractionPrompt('🚪 Press <strong>E</strong> to enter Projects');
      ui.toast('🪙 Coins! The 📔 Journal lists every way to earn.', { hint: true });
      vi.advanceTimersByTime(1500);
      expect(toastEl()!.style.opacity).toBe('0');
      ui.hideInteractionPrompt();
      vi.advanceTimersByTime(800);
      expect(text(toastEl())).toBe('🪙 Coins! The 📔 Journal lists every way to earn.');
    } finally {
      history.replaceState(null, '', '/');
    }
  });
});

// Wave-1 integration: in short landscape A6 puts First steps' card in a top
// lane (top +60, left +146), so a toast lifted over it sat on the compass pill
// and the 38% flash covered the card's last line. happy-dom has no layout:
// the boxes below are the ones measured at 844x390, 390x844 and 375x667.
describe('messages: clear of First steps’ card', () => {
  const restore: (() => void)[] = [];
  afterEach(() => {
    for (const r of restore.splice(0)) r();
    history.replaceState(null, '', '/');
  });

  /** A phone at w x h (short landscape at 500 tall or less), the guide card
   *  at `card`, the compass pill at the top centre, and a 212x37 toast and
   *  294x40 flash wherever their lanes put them. */
  const phone = (w: number, h: number, card: DOMRect): HTMLElement => {
    for (const [k, v] of [
      ['innerWidth', w],
      ['innerHeight', h],
    ] as const) {
      const own = Object.getOwnPropertyDescriptor(window, k);
      Object.defineProperty(window, k, { value: v, configurable: true });
      restore.push(() => {
        if (own) Object.defineProperty(window, k, own);
        else delete (window as unknown as Record<string, unknown>)[k];
      });
    }
    const short = h <= 500;
    vi.spyOn(window, 'matchMedia').mockImplementation(
      (q: string) =>
        ({
          matches: q.includes('max-height: 500px') ? short : false,
          media: q,
          addEventListener: () => {},
          removeEventListener: () => {},
        }) as unknown as MediaQueryList,
    );
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(40);
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(294);
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement,
    ) {
      if (this.id === 'ds-guide') return card;
      if (this.dataset.guide === 'compass') return new DOMRect(w / 2 - 62, 14, 124, 44);
      // (happy-dom drops calc(var()) offsets: the lane's offset is read from
      // its data-bottom marker.)
      if (this.style.zIndex === '1750' && this.dataset.bottom) {
        return new DOMRect(w / 2 - 106, h - Number(this.dataset.bottom) - 37, 212, 37);
      }
      return new DOMRect();
    });
    history.replaceState(null, '', '/?touch=1');
    document.body.innerHTML = '<div id="ui-overlay"></div>';
    ui = new SimpleUI('ui-overlay');
    ui.updateQuestCompass({ angleRad: 0, distance: 103, label: '🚀 Projects' });
    const g = document.createElement('div');
    g.id = 'ds-guide';
    g.dataset.active = '0';
    document.body.appendChild(g);
    return g;
  };
  const flash = (): HTMLElement | undefined =>
    [...document.querySelectorAll<HTMLElement>('#ui-overlay > div')].find(
      (d) => d.style.zIndex === '2000' && text(d).startsWith('🔍'),
    );

  test('short landscape: the toast keeps its 96 px lane, off the compass pill', () => {
    vi.useFakeTimers();
    phone(844, 390, new DOMRect(146, 60, 290, 91));
    ui.toast('🧭 Compass set: 🚀 Projects');
    expect(toastEl()!.dataset.lane).toBe('bottom');
    expect(toastEl()!.dataset.bottom).toBe('96'); // y 257-294, under the card's 60-151
  });

  test('a phone in portrait: the toast still steps 8 px above the card', () => {
    vi.useFakeTimers();
    phone(390, 844, new DOMRect(16, 403, 359, 91));
    ui.toast('🧭 Compass set: 🚀 Projects');
    expect(toastEl()!.dataset.bottom).toBe(String(844 - 403 + 8));
  });

  // Wave-2 carry-over (guide at 390x844): the NextChip fades in from opacity
  // 0, and the toast that was up when it arrived stayed on it for one poll.
  test('a phone in portrait: a card still fading in counts, a hidden one does not', () => {
    vi.useFakeTimers();
    const g = phone(390, 844, new DOMRect(16, 451, 133, 46));
    g.style.opacity = '0';
    let running = true;
    Object.defineProperty(g, 'getAnimations', {
      configurable: true,
      value: () => (running ? [{ playState: 'running' }] : []),
    });
    ui.toast('🧭 Compass set: 🏫 School');
    expect(toastEl()!.dataset.bottom).toBe(String(844 - 451 + 8));
    vi.advanceTimersByTime(6100);
    running = false; // opacity 0 and nothing playing: hidden, the 350 lane
    ui.toast('🧭 Compass set: 🚀 Projects');
    vi.advanceTimersByTime(800);
    expect(toastEl()!.dataset.bottom).toBe('350');
  });

  test('short landscape: the flash goes 8 px below the card, and follows it', () => {
    vi.useFakeTimers();
    const card = new DOMRect(146, 60, 290, 91);
    phone(844, 390, card);
    ui.flashMessage('🔍 Secret found: The Musician’s Stage!');
    expect(flash()!.style.top).toBe(`${60 + 91 + 8 + 20}px`); // its centre
    card.height = 68; // the next step's card is shorter
    vi.advanceTimersByTime(130);
    expect(flash()!.style.top).toBe(`${60 + 68 + 8 + 20}px`);
    document.getElementById('ds-guide')!.style.display = 'none';
    vi.advanceTimersByTime(130);
    expect(flash()!.style.top).toBe('38%'); // no card: back to centre
  });

  test('a small phone in portrait: the flash goes above the card', () => {
    vi.useFakeTimers();
    phone(375, 667, new DOMRect(8, 226, 359, 91));
    ui.flashMessage('🔍 Secret found: The Musician’s Stage!');
    expect(flash()!.style.top).toBe(`${226 - 8 - 20}px`);
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
  // The badge names the model, as the Fact Sheet does ('villagers talk
  // through Claude Haiku 4.5'); the label it replaced is banned copy
  // (claimsPanels).
  test('a canned reply re-labels the model badge for that chat only', () => {
    ui.showNpcChat('Gardener', 'Morning!', async () => 'A written line.');
    const badge = [...document.querySelectorAll('span')].find(
      (s) => text(s) === 'Claude Haiku 4.5',
    )!;
    expect(badge.title).toContain('talks through Claude Haiku 4.5');
    expect(badge.title).not.toMatch(/every reply|generated/i);
    ui.markNpcChatOffline('Guard'); // a different villager: no-op
    expect(text(badge)).toBe('Claude Haiku 4.5');
    ui.markNpcChatOffline('Gardener');
    expect(text(badge)).toBe('offline replies');
    expect(badge.title).toContain('written lines');
  });
  // (that main-simple marks it on the canned branch is package A's mainLocks)

  test('the chip is a neutral 12 px name of the model, not an amber status light (D10)', () => {
    ui.showNpcChat('Lighthouse Keeper', 'Evening.', async () => 'A written line.');
    const chip = document.querySelector<HTMLElement>('[data-npc-model]')!;
    expect(text(chip)).toBe('Claude Haiku 4.5');
    expect(chip.style.fontSize).toBe('12px');
    expect(chip.style.color).not.toMatch(/ffd479|255, ?212, ?121/i);
    // The name and the chip wrap as a pair; the name ellipsises before the
    // close button gives way (it broke in two at 390 px beside the chip).
    const who = chip.parentElement!;
    expect(who.style.flexWrap).toBe('wrap');
    expect(who.style.minWidth).toMatch(/^0(px)?$/);
    const name = who.firstElementChild as HTMLElement;
    expect(text(name)).toBe('Lighthouse Keeper');
    expect(name.style.textOverflow).toBe('ellipsis');
    expect(name.style.whiteSpace).toBe('nowrap');
    const close = document.querySelector<HTMLElement>('button[aria-label="Close chat"]')!;
    expect(close.parentElement!.style.flex).toMatch(/^(none|0 0 auto)$/);
  });
});

describe('the NPC chat says when the villager speaks and when the visitor types (D10)', () => {
  type Sig = { type: string; name: unknown; on: unknown };
  let seen: Sig[] = [];
  const onSpeak = (e: Event): void => {
    const d = (e as CustomEvent<{ name: string; speaking: boolean }>).detail;
    seen.push({ type: 'speaking', name: d.name, on: d.speaking });
  };
  const onType = (e: Event): void => {
    const d = (e as CustomEvent<{ name: string; typing: boolean }>).detail;
    seen.push({ type: 'typing', name: d.name, on: d.typing });
  };
  const field = (): HTMLInputElement =>
    document.querySelector<HTMLInputElement>('input[placeholder^="Say something to"]')!;

  beforeEach(() => {
    seen = [];
    vi.useFakeTimers();
    window.addEventListener('ds:npc-speaking', onSpeak);
    window.addEventListener('ds:npc-typing', onType);
  });
  afterEach(() => {
    window.removeEventListener('ds:npc-speaking', onSpeak);
    window.removeEventListener('ds:npc-typing', onType);
  });

  test("'ds:npc-speaking' is true while a line types and false when it has", () => {
    ui.showNpcChat('Gardener', 'Morning!', async () => 'A written line.');
    expect(seen).toEqual([{ type: 'speaking', name: 'Gardener', on: true }]);
    vi.advanceTimersByTime(18 * 'Morning!'.length + 40);
    expect(seen).toEqual([
      { type: 'speaking', name: 'Gardener', on: true },
      { type: 'speaking', name: 'Gardener', on: false },
    ]);
  });

  test('closing the chat mid-line ends the speaking signal', () => {
    ui.showNpcChat('Gardener', 'A much longer greeting than that.', async () => '…');
    ui.closeNpcChat();
    expect(seen.at(-1)).toEqual({ type: 'speaking', name: 'Gardener', on: false });
    vi.advanceTimersByTime(5000);
    expect(seen.filter((s) => s.type === 'speaking')).toHaveLength(2); // nothing after the close
  });

  test("'ds:npc-typing' is true on input, once, and false 1.5 s after the last keystroke", () => {
    ui.showNpcChat('Gardener', 'Hi', async () => '…');
    vi.advanceTimersByTime(200);
    seen = [];
    const input = field();
    input.value = 'H';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    vi.advanceTimersByTime(1000);
    input.value = 'He';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    vi.advanceTimersByTime(1400); // 1.4 s after the LAST keystroke: still typing
    expect(seen).toEqual([{ type: 'typing', name: 'Gardener', on: true }]);
    vi.advanceTimersByTime(150);
    expect(seen).toEqual([
      { type: 'typing', name: 'Gardener', on: true },
      { type: 'typing', name: 'Gardener', on: false },
    ]);
  });

  test('a send ends typing at once', async () => {
    ui.showNpcChat('Gardener', 'Hi', async () => 'A written line.');
    vi.advanceTimersByTime(200);
    seen = [];
    const input = field();
    input.value = 'Hello';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(seen.filter((s) => s.type === 'typing')).toEqual([
      { type: 'typing', name: 'Gardener', on: true },
      { type: 'typing', name: 'Gardener', on: false },
    ]);
    await vi.advanceTimersByTimeAsync(2000);
    expect(seen.filter((s) => s.type === 'typing')).toHaveLength(2); // the 1.5 s timer went with it
  });

  test("a slow reply reads '<name> is thinking…' after 3 s, then the reply replaces it", async () => {
    let answer!: (line: string) => void;
    ui.showNpcChat('Gardener', 'Hi', () => new Promise<string>((r) => (answer = r)));
    const input = field();
    input.value = 'How are the flowers?';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    const thinking = (): string => text(document.querySelector('[data-npc-thinking]'));
    expect(thinking()).toBe('…');
    await vi.advanceTimersByTimeAsync(2900);
    expect(thinking()).toBe('…');
    await vi.advanceTimersByTimeAsync(200);
    expect(thinking()).toBe('Gardener is thinking…');
    answer('The roses are thirsty today.');
    await vi.advanceTimersByTimeAsync(1000);
    expect(document.querySelector('[data-npc-thinking]')).toBeNull();
    expect(text(document.querySelector('[role="log"]'))).toContain('The roses are thirsty today.');
  });

  test('a reply that lands after the chat closed is not typed or spoken', async () => {
    let answer!: (line: string) => void;
    ui.showNpcChat('Gardener', 'Hi', () => new Promise<string>((r) => (answer = r)));
    const input = field();
    input.value = 'Anyone home?';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    ui.closeNpcChat();
    seen = [];
    answer('Too late.');
    await vi.advanceTimersByTimeAsync(500);
    expect(seen).toEqual([]);
  });
});

describe('the welcome cards say less and show progress (D9)', () => {
  const card = (): HTMLElement => document.querySelector<HTMLElement>('[role="dialog"]')!;
  const shown = (el: Element): boolean => !el.closest('[hidden]');
  const visibleButtons = (): HTMLButtonElement[] =>
    [...card().querySelectorAll<HTMLButtonElement>('button')].filter(shown);
  /** The card's visible words, as fm.cjs's cardGeo counts them (innerText). */
  const words = (): number => {
    const seen = card().cloneNode(true) as HTMLElement;
    for (const h of seen.querySelectorAll('[hidden]')) h.remove();
    return text(seen).split(/\s+/).filter(Boolean).length;
  };

  test('first run: 80 words or fewer, four buttons plus the disclosure', () => {
    ui.showWelcome(null);
    expect(words()).toBeLessThanOrEqual(80);
    const buttons = visibleButtons();
    const disclosure = buttons.filter((b) => b.hasAttribute('aria-expanded'));
    expect(disclosure).toHaveLength(1);
    expect(buttons.filter((b) => !b.hasAttribute('aria-expanded')).map((b) => text(b))).toEqual([
      '📄 Hiring? CV, experience and contact',
      '🚀 See the work',
      '📬 Get in touch',
      '🧭 Explore the island →',
    ]);
    expect(text(card())).toContain(
      `${Object.keys(AI_NPCS).length} villagers talk through Claude Haiku 4.5 — walk up and ask them anything.`,
    );
    expect(card().style.background).toMatch(/rgb\(8, 10, 16\)/);
  });

  test('the disclosure opens the three guided ways in, and their contracts still fire', () => {
    const onTour = vi.fn();
    ui.setOnTour(onTour);
    ui.showWelcome(null);
    const more = card().querySelector<HTMLButtonElement>('button[data-more]')!;
    const tour = card().querySelector<HTMLButtonElement>('button[data-tour]')!;
    expect(shown(tour)).toBe(false);
    expect(more.getAttribute('aria-expanded')).toBe('false');
    more.click();
    expect(more.getAttribute('aria-expanded')).toBe('true');
    expect(ui.isWelcomeVisible()).toBe(true); // the disclosure never closes the card
    for (const sel of ['button[data-meet-ai]', 'button[data-tour]', 'button[data-race]']) {
      expect(shown(card().querySelector(sel)!), sel).toBe(true);
    }
    more.click();
    expect(shown(tour)).toBe(false);
    more.click();
    tour.click();
    expect(onTour).toHaveBeenCalledTimes(1);
    expect(ui.isWelcomeVisible()).toBe(false);
    // (the disclosure itself is not an event: welcome_cta counts choices)
    expect(
      (window.__analyticsLog ?? [])
        .filter((e) => e.name === 'welcome_cta')
        .map((e) => e.props?.cta),
    ).toEqual(['tour']);
  });

  describe('the returning card', () => {
    beforeEach(() => localStorage.setItem('ds_welcomed', '1'));
    const progress = (): string => text(card().querySelector('[data-passport-progress]'));
    const explore = (): string => text(card().querySelector('button[data-dismiss]'));

    test('shows the passport progress line: how many, and which are left', () => {
      localStorage.setItem('ds_passport', JSON.stringify(['projects', 'contact']));
      ui.setPassport(new Passport());
      ui.showWelcome(null);
      expect(progress()).toBe('🛂 Passport: 2 of 4 stamps — Professional, Personal to go');
      expect(card().querySelector('button[data-more]')).toBeNull(); // a hello, not a menu
    });

    test('a complete passport says so', () => {
      localStorage.setItem(
        'ds_passport',
        JSON.stringify(['professional', 'projects', 'personal', 'contact']),
      );
      ui.setPassport(new Passport());
      ui.showWelcome(null);
      expect(progress()).toContain('Passport complete');
    });

    test("Explore counts First steps' quick steps left, from ds_guide_v1", () => {
      localStorage.setItem(
        'ds_guide_v1',
        JSON.stringify({ v: 1, done: ['move', 'look'], finished: false, skipped: false, t: 1 }),
      );
      ui.showWelcome(null);
      expect(explore()).toBe('🧭 Explore (3 quick steps left)');
      ui.hideWelcome(false);
      localStorage.setItem(
        'ds_guide_v1',
        JSON.stringify({
          v: 1,
          done: ['move', 'look', 'talk', 'portfolio'],
          finished: false,
          skipped: false,
          t: 2,
        }),
      );
      ui.showWelcome(null);
      expect(explore()).toBe('🧭 Explore (1 quick step left)');
    });

    test.each([
      ['absent', null],
      ['unparseable', '{not json'],
      ['another version', JSON.stringify({ v: 2, done: [] })],
      ['finished', JSON.stringify({ v: 1, done: ['move'], finished: true, skipped: false, t: 1 })],
      ['skipped', JSON.stringify({ v: 1, done: ['move'], finished: false, skipped: true, t: 1 })],
    ])('the count is omitted when ds_guide_v1 is %s', (_name, value) => {
      if (value !== null) localStorage.setItem('ds_guide_v1', value);
      ui.showWelcome(null);
      expect(explore()).toBe('🧭 Explore the island →');
    });

    test('a first-run card never counts steps, whatever the key says', () => {
      localStorage.removeItem('ds_welcomed');
      localStorage.setItem(
        'ds_guide_v1',
        JSON.stringify({ v: 1, done: [], finished: false, skipped: false, t: 1 }),
      );
      ui.showWelcome(null);
      expect(explore()).toBe('🧭 Explore the island →');
    });
  });

  test('a phone on its side drops the villager line and tightens the padding', () => {
    const height = window.innerHeight;
    try {
      Object.defineProperty(window, 'innerHeight', { value: 390, configurable: true });
      ui.showWelcome(null);
      expect(card().querySelector('[data-ai-line]')).toBeNull();
      expect(card().style.padding).toBe('14px 22px');
      expect(visibleButtons().length).toBe(5); // the four, and the disclosure
    } finally {
      Object.defineProperty(window, 'innerHeight', { value: height, configurable: true });
    }
    ui.hideWelcome(false);
    ui.showWelcome(null);
    expect(card().querySelector('[data-ai-line]')).not.toBeNull();
    expect(card().style.padding).toBe('22px');
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

  test('HUD chips skip the double-tap delay', () => {
    // (that main-simple names the canvas is package A's mainLocks)
    const css = src('style.css');
    const rule = css.slice(css.indexOf('.hud-btn {'), css.indexOf('}', css.indexOf('.hud-btn {')));
    expect(rule).toContain('touch-action: manipulation');
  });

  test('the receptionist is a voice assistant set up on ElevenLabs (decision 11)', () => {
    const box = document.createElement('div');
    appendReceptionDesk(box);
    expect(text(box)).toContain(
      'A voice assistant I set up on ElevenLabs — ask it about my work, or your project.',
    );
    expect(text(box)).not.toMatch(/voice agent|I built/i);
  });

  test('the receptionist says the call streams live audio to ElevenLabs', () => {
    const box = document.createElement('div');
    appendReceptionDesk(box);
    expect(text(box)).toContain('your voice streams live to ElevenLabs');
  });
});

// Stage 1 (A3, A4) made looking a press-and-drag with the left or right mouse
// button, a swipe on touch, and J/L on the keyboard; pointer lock is opt-in.
// "mouse to look" taught a click and a move, which now turns nothing. D9
// dropped the welcome card's controls line (First steps teaches the controls,
// a step at a time), so the card now has no such line to get wrong.
describe('the controls copy teaches the stage-1 look', () => {
  const lookLine = (root: Element | null | undefined): string =>
    text([...(root?.querySelectorAll('p') ?? [])].find((p) => text(p).includes('to move')));
  const cardText = (): string => {
    ui.showWelcome(null);
    return text(document.querySelector('[role="dialog"]'));
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

  test('desktop: drag or J/L to look in the Welcome Hub; the card teaches no controls', () => {
    expect(ui.isTouchDevice()).toBe(false);
    const card = cardText();
    const hub = hubLine();
    expect(card).not.toMatch(/WASD|to move|to jump|to wave|J\/L/i);
    expect(hub).toContain('WASD to move, drag or J/L to look, E to interact.');
    for (const line of [card, hub]) expect(line).not.toMatch(/mouse/i);
  });

  test('touch: swipe to look in the Hub, and neither surface names a mouse or a key', () => {
    history.replaceState(null, '', '/?touch=1'); // ?touch selects the phone scheme
    try {
      document.body.innerHTML = '<div id="ui-overlay"></div>';
      ui = new SimpleUI('ui-overlay');
      expect(ui.isTouchDevice()).toBe(true);
      const card = cardText();
      const hub = hubLine();
      expect(card).not.toMatch(/joystick|USE to interact|JUMP|WAVE/);
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
