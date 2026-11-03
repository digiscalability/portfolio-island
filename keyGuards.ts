/**
 * Who owns a keypress: the window-level hotkeys in main-simple.ts (Enter opens
 * the chat input) must not fire on a key that a focused control or an open
 * card already used, and the world (walking, the one-shot verbs, the camera)
 * takes no input while a panel or a focused control owns it. Kept pure and
 * DOM-only so test/keyGuards.test.ts and test/inputLook.test.ts run it in
 * happy-dom; main-simple's copy only ever ran behind the WebGL boot.
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

/**
 * Panels the visitor can walk away from: the conversation sheets, the
 * multiplayer chat line, the appearance editor and the tour rail. While any
 * OTHER panel is on top, the world gets no input at all (main-simple zeroes
 * movement, drops latched presses and drains camera input). An allow-list on
 * purpose: a new panel blocks the world until it is added here.
 */
export const WALKABLE: ReadonlySet<string> = new Set([
  'npc-chat',
  'dialogue',
  'chat-input',
  'customize',
  'tour',
]);

/** Does the top panel own the keyboard? `topPanelId` is PanelManager.current(). */
export function worldInputBlocked(topPanelId: string | null): boolean {
  return topPanelId !== null && !WALKABLE.has(topPanelId);
}

/** The keys a focused slider, select or radio group uses to change its value. */
const VALUE_KEYS: ReadonlySet<string> = new Set([
  'arrowup',
  'arrowdown',
  'arrowleft',
  'arrowright',
  'home',
  'end',
  'pageup',
  'pagedown',
]);
/** The keys that activate a focused button, link or switch. */
const ACTIVATE_KEYS: ReadonlySet<string> = new Set([' ', 'spacebar', 'enter']);
/** <input> types that are buttons or switches rather than text fields. */
const BUTTON_INPUTS: ReadonlySet<string> = new Set([
  'button',
  'submit',
  'reset',
  'image',
  'checkbox',
  'radio',
  'color',
  'file',
]);
/** ARIA roles that make an element act as a button (the HUD chips are role=button). */
const BUTTON_ROLES: ReadonlySet<string> = new Set([
  'button',
  'link',
  'menuitem',
  'tab',
  'checkbox',
  'radio',
  'switch',
  'option',
]);

/**
 * Does the element a key went to use that key itself? Then the world must
 * neither hold nor latch it (SimpleInputManager's keydown).
 * - Text entry (any text-like <input>, <textarea>, contenteditable): every key.
 * - Value controls (<input type=range>, <select>): the arrows, Home, End,
 *   PageUp and PageDown (a select also takes Space and Enter, which open it).
 * - Buttons, links and switches: only Space and Enter, which activate them.
 *   Anything else still reaches the world, so W after clicking an NPC chat's
 *   Send button walks away from the chat, and a focused swatch does not
 *   freeze the walkable appearance editor.
 * `key` is KeyboardEvent.key; case does not matter.
 */
export function focusedControlOwnsKey(key: string, target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const k = key.toLowerCase();
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  if (tag === 'TEXTAREA') return true;
  if (tag === 'INPUT') {
    const type = ((target as HTMLInputElement).type || 'text').toLowerCase();
    if (type === 'range') return VALUE_KEYS.has(k);
    if (BUTTON_INPUTS.has(type)) {
      return ACTIVATE_KEYS.has(k) || (type === 'radio' && VALUE_KEYS.has(k));
    }
    return true; // text, search, email, number, password, …
  }
  if (tag === 'SELECT') return VALUE_KEYS.has(k) || ACTIVATE_KEYS.has(k);
  if (tag === 'BUTTON' || tag === 'A' || tag === 'SUMMARY') return ACTIVATE_KEYS.has(k);
  const role = target.getAttribute('role');
  return role !== null && BUTTON_ROLES.has(role) && ACTIVATE_KEYS.has(k);
}
