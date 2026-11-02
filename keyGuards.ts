/**
 * Who owns a keypress: the window-level hotkeys in main-simple.ts (Enter opens
 * the chat input) must not fire on a key that a focused control or an open
 * card already used. Kept pure and DOM-only so test/keyGuards.test.ts runs it
 * in happy-dom; main-simple's copy only ever ran behind the WebGL boot.
 */

/** The UI state that owns Enter while it is on screen (SimpleUI fits this). */
export interface EnterGuardUi {
  /** The welcome card or the name prompt is up. */
  isWelcomeVisible(): boolean;
  /** Any PanelManager panel is open (zone panels, the portfolio menu, …). */
  isPanelOpen(): boolean;
}

/**
 * May a window-level Enter open the chat input? Only when nothing else owns
 * the key: not already handled (defaultPrevented), no welcome card, name
 * prompt or panel open, and no control focused (a focused button, link or
 * field activates itself on Enter). The bare page and the game canvas don't
 * count as controls.
 */
export function enterOpensChat(
  e: KeyboardEvent,
  ui: EnterGuardUi,
  active: Element | null = document.activeElement,
): boolean {
  if (e.defaultPrevented) return false;
  if (ui.isWelcomeVisible() || ui.isPanelOpen()) return false;
  if (active instanceof HTMLElement && active !== document.body && active.id !== 'game-canvas') {
    if (active.isContentEditable) return false;
    if (active.matches('a[href], button, input, select, textarea, summary, [role], [tabindex]')) {
      return false;
    }
  }
  return true;
}
