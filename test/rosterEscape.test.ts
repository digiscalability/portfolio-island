// @vitest-environment happy-dom
//
// Peer names arrive from the network. safePeerName strips invisible
// characters and caps the length, but it leaves markup intact, so the roster
// must escape a name before it goes into innerHTML.
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { SimpleUI } from '../SimpleUI';

let ui: SimpleUI;

beforeEach(() => {
  document.body.innerHTML = '<div id="ui-overlay"></div>';
  localStorage.clear();
  sessionStorage.clear();
  ui = new SimpleUI('ui-overlay');
});

afterEach(() => {
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
});
