// @vitest-environment happy-dom
//
// Text that another visitor or a link controls must never become markup.
// - Peer names arrive from the network. safePeerName strips invisible
//   characters and caps the length, but it leaves markup intact, so the
//   roster escapes a name before it goes into innerHTML.
// - ?mood= previews a mood without the backend. Its free-text &headline= is
//   dev-only, and the returning-visitor card escapes whatever headline it gets.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { SimpleUI } from '../SimpleUI';
import { connectWorldState, MOOD_META, type WorldState } from '../WorldState';

let ui: SimpleUI;

beforeEach(() => {
  document.body.innerHTML = '<div id="ui-overlay"></div>';
  localStorage.clear();
  sessionStorage.clear();
  ui = new SimpleUI('ui-overlay');
});

afterEach(() => {
  ui.hideWelcome(false);
  vi.unstubAllEnvs();
  window.history.replaceState(null, '', '/');
  document.body.innerHTML = '';
});

describe('roster', () => {
  test('a peer name with markup renders as text and adds no element', () => {
    const name = '<img src=x>';
    ui.setRosterProvider(() => [{ id: 'peer-1', name, muted: false }]);
    ui.showRoster();

    const row = document.querySelector('[data-peer="peer-1"]');
    expect(row).not.toBeNull();
    expect(row!.querySelector('img')).toBeNull();
    expect(row!.textContent).toContain(name);
  });

  test('a name with & " and \' shows exactly as typed, never double-escaped', () => {
    const name = `Tom & "Jerry" 'O'`;
    ui.setRosterProvider(() => [{ id: 'peer-1', name, muted: false }]);
    ui.showRoster();

    const span = document.querySelector('[data-peer="peer-1"] span');
    expect(span?.textContent).toBe(`👤 ${name}`);
  });

  test('a peer id with quotes cannot break out of its data attributes', () => {
    const id = 'x" onclick="alert(1)';
    ui.setRosterProvider(() => [{ id, name: 'Sam', muted: false }]);
    ui.showRoster();

    const row = document.querySelector('[data-peer]') as HTMLElement | null;
    expect(row).not.toBeNull();
    expect(row!.dataset.peer).toBe(id);
    expect(row!.hasAttribute('onclick')).toBe(false);
    const mute = row!.querySelector('button[data-mute]') as HTMLElement;
    expect(mute.dataset.mute).toBe(id);
    expect(mute.hasAttribute('onclick')).toBe(false);
  });

  test('the mute button hands back the original peer id', () => {
    const id = `a&amp;b "c" 'd' <e>`;
    const toggled: string[] = [];
    ui.setRosterProvider(() => [{ id, name: 'Sam', muted: false }]);
    ui.setOnPeerMuteToggle((peerId) => {
      toggled.push(peerId);
      return true;
    });
    ui.showRoster();

    (document.querySelector('button[data-mute]') as HTMLButtonElement).click();
    expect(toggled).toEqual([id]);
  });

  test('a non-string id from the dev relay renders instead of throwing', () => {
    const id = 123 as unknown as string;
    ui.setRosterProvider(() => [{ id, name: 'Sam', muted: false }]);
    expect(() => ui.showRoster()).not.toThrow();
    expect(document.querySelector('[data-peer="123"]')).not.toBeNull();
  });
});

describe('roster mutes survive a reload (security)', () => {
  test("a peer Chat muted last visit reads Muted, though the provider's flag is false", () => {
    localStorage.setItem('ds_muted_peers', JSON.stringify(['peer-1']));
    ui.setRosterProvider(() => [
      { id: 'peer-1', name: 'Sam', muted: false },
      { id: 'peer-2', name: 'Ali', muted: false },
    ]);
    ui.showRoster();
    const btn = (id: string) => document.querySelector(`button[data-mute="${id}"]`)!;
    expect(btn('peer-1').textContent?.trim()).toBe('🔇 Muted');
    expect(btn('peer-2').textContent?.trim()).toBe('🔊 Mute');
  });

  test('an unreadable ds_muted_peers leaves the provider in charge', () => {
    localStorage.setItem('ds_muted_peers', '{not json');
    ui.setRosterProvider(() => [{ id: 'peer-1', name: 'Sam', muted: true }]);
    expect(() => ui.showRoster()).not.toThrow();
    expect(document.querySelector('button[data-mute="peer-1"]')!.textContent?.trim()).toBe(
      '🔇 Muted',
    );
  });
});

describe('authored values in innerHTML are escaped (security)', () => {
  const evil = '<img src=x onerror=alert(1)>';

  test("showDialogue's name renders as text", () => {
    ui.showDialogue(evil, ['Hello.']);
    const box = document.getElementById('dialogue-text')!.parentElement!.parentElement!;
    expect(box.querySelector('img')).toBeNull();
    expect(box.textContent).toContain(evil);
    ui.hideDialogue(); // the typewriter stops with the test
  });

  test("showQuestComplete's name and reward render as text", () => {
    ui.showQuestComplete({ name: evil, reward: { value: `${evil} & 5 coins` } });
    const overlay = document.getElementById('ui-overlay')!;
    expect(overlay.querySelector('img')).toBeNull();
    expect(overlay.textContent).toContain(evil);
    expect(overlay.textContent).toContain(`${evil} & 5 coins`);
  });

  test("the zone panel's fallback (an unknown id) renders its name and text as text", () => {
    ui.showZonePanel({ id: 'nowhere', name: evil, description: evil }, { source: 'menu' });
    const h2 = document.querySelector('#ds-zone-title')!;
    expect(h2.textContent).toBe(evil);
    expect(h2.parentElement!.querySelector('img')).toBeNull();
    ui.hideZonePanel();
  });

  test('a fallback with no description shows no stray "undefined"', () => {
    ui.showZonePanel({ id: 'nowhere', name: 'Somewhere' }, { source: 'menu' });
    expect(document.querySelector('#ds-zone-title')!.parentElement!.textContent).not.toContain(
      'undefined',
    );
    ui.hideZonePanel();
  });
});

describe('returning-visitor welcome card', () => {
  test('a headline with markup renders as text and adds no element', () => {
    localStorage.setItem('ds_welcomed', '1');
    const headline = '<img src=x onerror=alert(1)>';
    ui.showWelcome({
      daysAway: 2,
      editions: 0,
      headline,
      weather: null,
      guestbookSince: Promise.resolve(null),
    });

    const card = document.querySelector('[role="dialog"][aria-label^="Welcome"]');
    expect(card?.textContent).toContain('Welcome back');
    expect(card!.querySelector('img')).toBeNull();
    expect(card!.textContent).toContain(headline);
  });
});

describe('?mood= preview', () => {
  const firstState = (): WorldState => {
    const seen: WorldState[] = [];
    connectWorldState((s) => seen.push(s));
    expect(seen).toHaveLength(1);
    return seen[0];
  };

  test('production ignores a free-text &headline= and uses the authored line', () => {
    vi.stubEnv('DEV', false);
    window.history.replaceState(null, '', '/?mood=calm&headline=%3Cimg%20src%3Dx%3E');
    const s = firstState();
    expect(s.mood).toBe('calm');
    expect(s.headline).toBe(MOOD_META.calm.devHeadline);
  });

  test('dev builds keep the headline preview, capped at 160 characters', () => {
    vi.stubEnv('DEV', true);
    window.history.replaceState(null, '', `/?mood=calm&headline=${'a'.repeat(200)}`);
    expect(firstState().headline).toBe('a'.repeat(160));
  });
});
