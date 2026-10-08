/**
 * Keyboard-shortcut display. Shortcuts are written platform-neutrally as `+`-separated
 * tokens, e.g. "Mod+Shift+F" (Mod = ⌘ on macOS, Ctrl elsewhere).
 *
 *   formatShortcut('Mod+Shift+F', 'mac')      → '⇧⌘F'
 *   formatShortcut('Mod+Shift+F', 'windows')  → 'Ctrl+Shift+F'
 */
import { getPlatform, type Platform } from './platform';

type Modifier = 'ctrl' | 'alt' | 'shift' | 'meta';

const MODIFIER_ALIASES: Readonly<Record<string, Modifier | 'mod'>> = {
  mod: 'mod',
  cmd: 'meta',
  command: 'meta',
  meta: 'meta',
  super: 'meta',
  ctrl: 'ctrl',
  control: 'ctrl',
  alt: 'alt',
  opt: 'alt',
  option: 'alt',
  shift: 'shift',
};

/** macOS order: ⌃ ⌥ ⇧ ⌘. Windows/Linux order: Ctrl Alt Shift (Meta shown as Win/Super). */
const MAC_ORDER: readonly Modifier[] = ['ctrl', 'alt', 'shift', 'meta'];
const PC_ORDER: readonly Modifier[] = ['ctrl', 'alt', 'shift', 'meta'];

const MAC_MODIFIER: Readonly<Record<Modifier, string>> = { ctrl: '⌃', alt: '⌥', shift: '⇧', meta: '⌘' };
const PC_MODIFIER: Readonly<Record<Modifier, string>> = { ctrl: 'Ctrl', alt: 'Alt', shift: 'Shift', meta: 'Win' };

const MAC_KEYS: Readonly<Record<string, string>> = {
  enter: '↩',
  return: '↩',
  escape: '⎋',
  esc: '⎋',
  backspace: '⌫',
  delete: '⌦',
  del: '⌦',
  tab: '⇥',
  space: 'Space',
  arrowup: '↑',
  up: '↑',
  arrowdown: '↓',
  down: '↓',
  arrowleft: '←',
  left: '←',
  arrowright: '→',
  right: '→',
  pageup: '⇞',
  pagedown: '⇟',
  home: '↖',
  end: '↘',
  plus: '+',
  minus: '−',
  comma: ',',
  period: '.',
};

const PC_KEYS: Readonly<Record<string, string>> = {
  enter: 'Enter',
  return: 'Enter',
  escape: 'Esc',
  esc: 'Esc',
  backspace: 'Backspace',
  delete: 'Del',
  del: 'Del',
  tab: 'Tab',
  space: 'Space',
  arrowup: '↑',
  up: '↑',
  arrowdown: '↓',
  down: '↓',
  arrowleft: '←',
  left: '←',
  arrowright: '→',
  right: '→',
  pageup: 'PgUp',
  pagedown: 'PgDn',
  home: 'Home',
  end: 'End',
  plus: '+',
  minus: '-',
  comma: ',',
  period: '.',
};

/**
 * Splits a shortcut into display keys, modifiers first in platform order.
 * Unknown tokens are shown as written (single letters upper-cased).
 */
export function shortcutKeys(shortcut: string, platform: Platform = getPlatform()): string[] {
  const mac = platform === 'mac';
  const mods = new Set<Modifier>();
  const keys: string[] = [];
  // A literal "+" key is written as "Plus"; tolerate a trailing "+" too ("Ctrl++").
  const raw = shortcut.trim();
  const tokens = raw.endsWith('++') ? [...raw.slice(0, -2).split('+'), 'plus'] : raw.split('+');
  for (const token of tokens) {
    const t = token.trim();
    if (!t) continue;
    const lower = t.toLowerCase();
    const alias = MODIFIER_ALIASES[lower];
    if (alias) {
      mods.add(alias === 'mod' ? (mac ? 'meta' : 'ctrl') : alias);
      continue;
    }
    const named = (mac ? MAC_KEYS : PC_KEYS)[lower];
    keys.push(named ?? (t.length === 1 ? t.toUpperCase() : t));
  }
  const order = mac ? MAC_ORDER : PC_ORDER;
  const names = mac ? MAC_MODIFIER : PC_MODIFIER;
  return [...order.filter((m) => mods.has(m)).map((m) => names[m]), ...keys];
}

/** Human-readable shortcut text: '⇧⌘F' on macOS, 'Ctrl+Shift+F' elsewhere. */
export function formatShortcut(shortcut: string, platform: Platform = getPlatform()): string {
  const keys = shortcutKeys(shortcut, platform);
  return platform === 'mac' ? keys.join('') : keys.join('+');
}
