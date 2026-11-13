/**
 * Keycaps and touch glyphs that follow the input in use (D7).
 *
 * One renderer, k(key, mode): a keyboard visitor sees <kbd class="kc">E</kbd>,
 * a touch visitor the glyph pill of the on-screen button that fires that
 * key (E is USE, Space JUMP, Q WAVE, G EAT, F FEED). A key with no button
 * keeps its keycap in both modes.
 *
 * Two parsers feed it:
 * - promptKeysHtml, for the interaction prompt (trusted, app-authored HTML):
 *   'Press <strong>X</strong>' and 'Hold <strong>X</strong>', any case, with
 *   any keyboard-emoji prefix dropped, and '[Key]' tokens;
 * - keyTextParts, for toasts and flashes, which render through text nodes:
 *   the same tokens in plain text ('press E', '[E]'). A toast can carry a
 *   visitor-authored name, so the caller builds DOM nodes from the parts and
 *   never sets innerHTML from toast text.
 */

export type InputMode = 'keyboard' | 'touch';

/** The touch button behind a key: its label and its ring token. */
const GLYPHS: Readonly<Record<string, { label: string; ring: string }>> = {
  E: { label: 'USE', ring: 'use' },
  Space: { label: 'JUMP', ring: 'jump' },
  Q: { label: 'WAVE', ring: 'wave' },
  G: { label: 'EAT', ring: 'eat' },
  F: { label: 'FEED', ring: 'feed' },
};

const NAMED = ['Space', 'Enter', 'Esc', 'Escape', 'Shift', 'Tab'] as const;
const KEY_SRC = `(?:${NAMED.join('|')}|[A-Za-z0-9])`;
/** A keyboard emoji before the verb ('⌨️ Press E'): dropped. */
const KB_PREFIX = '(?:\\u2328\\uFE0F?\\s*)?';

/** 'e' to 'E', 'space' to 'Space', 'escape' to 'Esc'. */
export function keyName(raw: string): string {
  const t = raw.trim();
  if (t.length === 1) return t.toUpperCase();
  const lower = t.toLowerCase();
  if (lower === 'escape' || lower === 'esc') return 'Esc';
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

/** The glyph a key has on touch, if any. */
export function touchGlyph(key: string): { label: string; ring: string } | null {
  return GLYPHS[keyName(key)] ?? null;
}

const escapeHtml = (s: string): string => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** k(): the markup for one key in a mode. */
export function k(key: string, mode: InputMode): string {
  const name = keyName(key);
  const glyph = mode === 'touch' ? touchGlyph(name) : null;
  if (glyph) {
    return `<span class="kg" data-ring="${glyph.ring}" style="--kg-ring: var(--ds-ring-${glyph.ring})">${glyph.label}</span>`;
  }
  return `<kbd class="kc">${escapeHtml(name)}</kbd>`;
}

/** k() as a DOM node. */
export function kNode(key: string, mode: InputMode): HTMLElement {
  const name = keyName(key);
  const glyph = mode === 'touch' ? touchGlyph(name) : null;
  if (glyph) {
    const s = document.createElement('span');
    s.className = 'kg';
    s.dataset.ring = glyph.ring;
    s.style.setProperty('--kg-ring', `var(--ds-ring-${glyph.ring})`);
    s.textContent = glyph.label;
    return s;
  }
  const kbd = document.createElement('kbd');
  kbd.className = 'kc';
  kbd.textContent = name;
  return kbd;
}

/** The verb for a key in a mode: a press is a tap on touch, a hold stays. */
function verb(raw: string, key: string, mode: InputMode): string {
  const hold = /^hold$/i.test(raw);
  const cap = raw.charAt(0) === raw.charAt(0).toUpperCase();
  const word = hold ? 'hold' : mode === 'touch' && touchGlyph(key) ? 'tap' : 'press';
  return cap ? word.charAt(0).toUpperCase() + word.slice(1) : word;
}

const PROMPT_RE = new RegExp(
  `${KB_PREFIX}\\b(press|hold)\\s+<strong>\\s*(${KEY_SRC})\\s*<\\/strong>`,
  'gi',
);
const BRACKET_RE = new RegExp(`\\[(${KEY_SRC})\\]`, 'g');
const EAT_WITH_RE = /\beat with G\b/g;

/** The interaction prompt's markup with every key token rendered by k(). */
export function promptKeysHtml(html: string, mode: InputMode): string {
  return html
    .replace(PROMPT_RE, (_m, v: string, key: string) => `${verb(v, key, mode)} ${k(key, mode)}`)
    .replace(BRACKET_RE, (_m, key: string) => k(key, mode))
    .replace(EAT_WITH_RE, () => `eat with ${k('G', mode)}`);
}

/** Plain-text tokens: the verb is matched in any case, the key exactly as
 *  written (a lower-case 'press a button' is prose, not a key). */
const PLAIN_RE = new RegExp(
  `${KB_PREFIX}\\b([Pp]ress|PRESS|[Hh]old|HOLD)\\s+(${NAMED.join('|')}|[A-Z0-9])(?![\\w])|\\[(${KEY_SRC})\\]`,
  'g',
);

export type KeyPart = { text: string } | { key: string; verb?: string };

/** Split plain text into text runs and keys, for a caller that builds nodes. */
export function keyTextParts(text: string, mode: InputMode): KeyPart[] {
  const parts: KeyPart[] = [];
  let at = 0;
  PLAIN_RE.lastIndex = 0;
  for (let m = PLAIN_RE.exec(text); m; m = PLAIN_RE.exec(text)) {
    if (m.index > at) parts.push({ text: text.slice(at, m.index) });
    if (m[3]) parts.push({ key: keyName(m[3]) });
    else parts.push({ key: keyName(m[2]), verb: verb(m[1], m[2], mode) });
    at = m.index + m[0].length;
  }
  if (at < text.length) parts.push({ text: text.slice(at) });
  return parts;
}

/** The same text as the live region should read it in a mode. */
export function keyTextPlain(text: string, mode: InputMode): string {
  return keyTextParts(text, mode)
    .map((p) => {
      if ('text' in p) return p.text;
      const glyph = mode === 'touch' ? touchGlyph(p.key) : null;
      const name = glyph ? glyph.label : p.key;
      return p.verb ? `${p.verb} ${name}` : name;
    })
    .join('');
}

/** Fill `el` with the text, every key token as a k() node. textContent only. */
export function renderKeyText(el: HTMLElement, text: string, mode: InputMode): void {
  el.textContent = '';
  for (const p of keyTextParts(text, mode)) {
    if ('text' in p) {
      el.appendChild(document.createTextNode(p.text));
      continue;
    }
    if (p.verb) el.appendChild(document.createTextNode(`${p.verb} `));
    el.appendChild(kNode(p.key, mode));
  }
}
